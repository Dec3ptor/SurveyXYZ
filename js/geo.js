// Geodesy + path geometry helpers. Pure functions, no DOM (unit-tested in Node).
export const EARTH_R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees clockwise from north, 0..360. */
export function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Signed smallest difference a-b in degrees, range (-180, 180]. */
export function angDiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function cardinal(b) {
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8];
}

/** Local east/north metre frame around an origin. Accurate to cm over site-sized areas. */
export class LocalFrame {
  constructor(lat0, lon0) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.kx = rad(1) * EARTH_R * Math.cos(rad(lat0));
    this.ky = rad(1) * EARTH_R;
  }
  toXY(lat, lon) {
    return [(lon - this.lon0) * this.kx, (lat - this.lat0) * this.ky];
  }
  toLL(x, y) {
    return [this.lat0 + y / this.ky, this.lon0 + x / this.kx];
  }
}

export function frameFor(latlngs) {
  let la = 0, lo = 0;
  for (const p of latlngs) { la += p[0]; lo += p[1]; }
  return new LocalFrame(la / latlngs.length, lo / latlngs.length);
}

export function pathLength(latlngs) {
  let d = 0;
  for (let i = 1; i < latlngs.length; i++) d += haversine(latlngs[i - 1][0], latlngs[i - 1][1], latlngs[i][0], latlngs[i][1]);
  return d;
}

/** Polygon area in m² from [lat,lon] ring. */
export function polygonArea(latlngs) {
  if (latlngs.length < 3) return 0;
  const f = frameFor(latlngs);
  const xy = latlngs.map((p) => f.toXY(p[0], p[1]));
  let a = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * Nearest point on a polyline (in XY metres) to p.
 * xte is signed: positive = p is to the RIGHT of the direction of travel.
 * If hint (the segment index last time) is given, that segment wins unless
 * another one is closer by more than `stickiness` metres — stops the guidance flipping between
 * adjacent parallel transects when GPS wobbles.
 */
export function nearestOnRoute(xy, p, hint = -1, stickiness = 4) {
  let best = null, bestHint = null;
  for (let i = 0; i < xy.length - 1; i++) {
    const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    let t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    const dist = Math.hypot(p[0] - px, p[1] - py);
    const cross = dx * (p[1] - ay) - dy * (p[0] - ax); // >0: p left of travel
    const len = Math.sqrt(len2);
    const r = { idx: i, t, dist, xte: -cross / len, px, py, segLen: len, toEnd: (1 - t) * len, segBearing: (deg(Math.atan2(dx, dy)) + 360) % 360 };
    if (!best || dist < best.dist) best = r;
    if (i === hint) bestHint = r;
  }
  if (bestHint && best && bestHint.dist <= best.dist + stickiness) return bestHint;
  return best;
}

/** Bearing (deg) of the longest edge of a polygon — a sensible default transect direction. */
export function longestEdgeBearing(boundary) {
  let best = 0, bestLen = -1;
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i], b = boundary[(i + 1) % boundary.length];
    const d = haversine(a[0], a[1], b[0], b[1]);
    if (d > bestLen) { bestLen = d; best = bearing(a[0], a[1], b[0], b[1]); }
  }
  return Math.round(best) % 180;
}

/**
 * Serpentine walk pattern: parallel transects `spacing` metres apart running
 * along `bearingDeg`, clipped to the boundary polygon, joined end to end.
 * Returns [[lat,lon], ...].
 */
export function generateTransects(boundary, spacing, bearingDeg) {
  if (boundary.length < 3 || !(spacing > 0)) return [];
  const f = frameFor(boundary);
  const b = rad(bearingDeg);
  const u = [Math.sin(b), Math.cos(b)]; // along-transect unit vector
  const v = [Math.cos(b), -Math.sin(b)]; // across-transect unit vector
  const ab = boundary.map((p) => {
    const [x, y] = f.toXY(p[0], p[1]);
    return [x * v[0] + y * v[1], x * u[0] + y * u[1]];
  });
  let minA = Infinity, maxA = -Infinity;
  for (const p of ab) { minA = Math.min(minA, p[0]); maxA = Math.max(maxA, p[0]); }
  const out = [];
  let flip = false;
  for (let a = minA + spacing / 2; a < maxA; a += spacing) {
    const hits = [];
    for (let i = 0; i < ab.length; i++) {
      const [a1, b1] = ab[i], [a2, b2] = ab[(i + 1) % ab.length];
      if ((a1 <= a) !== (a2 <= a)) hits.push(b1 + ((a - a1) / (a2 - a1)) * (b2 - b1));
    }
    hits.sort((p, q) => p - q);
    const line = [];
    for (let i = 0; i + 1 < hits.length; i += 2) line.push(hits[i], hits[i + 1]);
    if (!line.length) continue;
    if (flip) line.reverse();
    for (const bb of line) out.push(f.toLL(a * v[0] + bb * u[0], a * v[1] + bb * u[1]));
    flip = !flip;
  }
  return out;
}

/** Points every `step` metres along a route (XY). Used for coverage tracking. */
export function densify(xy, step) {
  const out = [];
  for (let i = 0; i < xy.length - 1; i++) {
    const [ax, ay] = xy[i], [bx, by] = xy[i + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, i]);
  }
  if (xy.length) out.push([...xy[xy.length - 1], Math.max(0, xy.length - 2)]);
  return out;
}

/** Tracks which parts of the planned route have been walked within tolerance. */
export class Coverage {
  constructor(routeLL, step = 2) {
    this.frame = routeLL.length ? frameFor(routeLL) : null;
    this.samples = this.frame ? densify(routeLL.map((p) => this.frame.toXY(p[0], p[1])), step) : [];
    this.covered = new Uint8Array(this.samples.length);
    this.count = 0;
    this.cell = 5;
    this.grid = new Map();
    this.samples.forEach((s, i) => {
      const k = this.key(s[0], s[1]);
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(i);
    });
  }
  key(x, y) { return Math.floor(x / this.cell) + ',' + Math.floor(y / this.cell); }
  /** Mark samples within tol metres of lat/lon. Returns true if anything changed. */
  mark(lat, lon, tol) {
    if (!this.frame) return false;
    const [x, y] = this.frame.toXY(lat, lon);
    const r = Math.ceil(tol / this.cell);
    const cx = Math.floor(x / this.cell), cy = Math.floor(y / this.cell);
    let changed = false;
    for (let i = cx - r; i <= cx + r; i++) for (let j = cy - r; j <= cy + r; j++) {
      const list = this.grid.get(i + ',' + j);
      if (!list) continue;
      for (const s of list) {
        if (!this.covered[s] && Math.hypot(this.samples[s][0] - x, this.samples[s][1] - y) <= tol) {
          this.covered[s] = 1; this.count++; changed = true;
        }
      }
    }
    return changed;
  }
  get fraction() { return this.samples.length ? this.count / this.samples.length : 0; }
  /** Covered stretches as arrays of [lat,lon] for drawing. */
  runs() {
    const out = [];
    let cur = null;
    for (let i = 0; i < this.samples.length; i++) {
      if (this.covered[i]) {
        if (!cur) { cur = []; out.push(cur); }
        cur.push(this.frame.toLL(this.samples[i][0], this.samples[i][1]));
      } else cur = null;
    }
    return out.filter((r) => r.length > 1);
  }
}
