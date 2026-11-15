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

/**
 * Follows a route in order, start to finish. Progress `s` is metres along the
 * route. Each update only looks a short way behind and ahead of the current
 * progress, so guidance cannot hop to a neighbouring transect or skip ahead.
 */
export class RouteFollower {
  constructor(xy, s = 0) {
    this.xy = xy;
    this.cum = [0];
    for (let i = 1; i < xy.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    this.total = this.cum[this.cum.length - 1];
    this.s = Math.max(0, Math.min(this.total, s || 0));
  }
  /** Point at distance s along the route: {x, y, idx}. */
  pointAt(s) {
    s = Math.max(0, Math.min(this.total, s));
    let i = 0;
    while (i < this.xy.length - 2 && this.cum[i + 1] < s) i++;
    const len = this.cum[i + 1] - this.cum[i];
    const t = len ? (s - this.cum[i]) / len : 0;
    return { x: this.xy[i][0] + t * (this.xy[i + 1][0] - this.xy[i][0]), y: this.xy[i][1] + t * (this.xy[i + 1][1] - this.xy[i][1]), idx: i };
  }
  /** Nearest point within [from, to] metres along the route. xte > 0 = right of travel. */
  project(p, from = 0, to = this.total) {
    let best = null;
    for (let i = 0; i < this.xy.length - 1; i++) {
      const len = this.cum[i + 1] - this.cum[i];
      if (!len || this.cum[i + 1] < from || this.cum[i] > to) continue;
      const [ax, ay] = this.xy[i], dx = (this.xy[i + 1][0] - ax) / len, dy = (this.xy[i + 1][1] - ay) / len;
      let a = (p[0] - ax) * dx + (p[1] - ay) * dy;
      a = Math.max(Math.max(0, from - this.cum[i]), Math.min(Math.min(len, to - this.cum[i]), a));
      const px = ax + a * dx, py = ay + a * dy;
      const dist = Math.hypot(p[0] - px, p[1] - py);
      if (!best || dist < best.dist) {
        best = { s: this.cum[i] + a, dist, idx: i, px, py, xte: -(dx * (p[1] - ay) - dy * (p[0] - ax)), toTurn: len - a, legs: this.xy.length - 1 };
      }
    }
    return best;
  }
  /**
   * Project near current progress. Progress only moves when you are within
   * `corridor` metres of the route, so walking beside or towards the path
   * cannot drag progress along with you.
   */
  update(p, commit = true, corridor = 6, back = 6, ahead = 25) {
    const r = this.project(p, this.s - back, this.s + ahead);
    if (r && commit && r.dist <= corridor) this.s = r.s;
    return r;
  }
  /** Jump progress to the nearest point anywhere on the route. */
  resync(p) {
    const r = this.project(p);
    if (r) this.s = r.s;
    return r;
  }
}

export function pointInPolygon(poly, p) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Sampling locations inside a boundary. o: {pattern, spacing, bearing, count, randomStart, exclude}.
 *  exclude: rings ([[lat,lon]]) inside which no points are placed.
 *  square / triangular / herringbone: systematic grids at `spacing` metres, rows along `bearing`.
 *  random: `count` uniformly random locations.
 * Returned in a walkable order (serpentine rows; nearest-neighbour for random). [[lat,lon], ...]
 */
export function samplePoints(boundary, o, rnd = Math.random) {
  if (boundary.length < 3) return [];
  const f = frameFor(boundary);
  const b = rad(o.bearing || 0);
  const u = [Math.sin(b), Math.cos(b)], v = [Math.cos(b), -Math.sin(b)];
  const ab = boundary.map((p) => { const [x, y] = f.toXY(p[0], p[1]); return [x * v[0] + y * v[1], x * u[0] + y * u[1]]; });
  let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
  for (const p of ab) { minA = Math.min(minA, p[0]); maxA = Math.max(maxA, p[0]); minB = Math.min(minB, p[1]); maxB = Math.max(maxB, p[1]); }
  // Areas to leave empty (inner focus or exclusion areas), in the same rotated frame.
  const holes = (o.exclude || []).filter((r) => r.length >= 3).map((r) => r.map((p) => { const [x, y] = f.toXY(p[0], p[1]); return [x * v[0] + y * v[1], x * u[0] + y * u[1]]; }));
  const ok = (p) => pointInPolygon(ab, p) && !holes.some((h) => pointInPolygon(h, p));
  let out = [];
  if (o.pattern === 'random') {
    const n = Math.max(0, Math.floor(o.count || 0));
    for (let tries = 0; out.length < n && tries < n * 500; tries++) {
      const p = [minA + rnd() * (maxA - minA), minB + rnd() * (maxB - minB)];
      if (ok(p)) out.push(p);
    }
    if (!out.length) return [];
    // nearest-neighbour walk order
    const rest = out, ordered = [];
    let cur = rest.reduce((m, p) => (p[0] + p[1] < m[0] + m[1] ? p : m), rest[0]);
    while (rest.length) {
      let k = 0, best = Infinity;
      rest.forEach((p, i) => { const d = Math.hypot(p[0] - cur[0], p[1] - cur[1]); if (d < best) { best = d; k = i; } });
      cur = rest.splice(k, 1)[0]; ordered.push(cur);
    }
    out = ordered;
  } else {
    const G = o.spacing;
    if (!(G > 0)) return [];
    const tri = o.pattern === 'triangular', her = o.pattern === 'herringbone';
    const rowStep = tri ? (G * Math.sqrt(3)) / 2 : G;
    const offA = (o.randomStart ? rnd() : 0.5) * G, offB = (o.randomStart ? rnd() : 0.5) * rowStep;
    let flip = false;
    for (let j = -1, bb = minB + offB - rowStep; bb <= maxB + G; j++, bb += rowStep) {
      const row = [];
      for (let i = -1, a = minA + offA - G; a <= maxA + G; i++, a += G) {
        const jo = ((j % 2) + 2) % 2, io = ((i % 2) + 2) % 2;
        const p = [a + (tri ? jo * G / 2 : her ? (jo ? 0.25 : -0.25) * G : 0), bb + (her ? (io ? 0.25 : -0.25) * G : 0)];
        if (ok(p)) row.push(p);
      }
      if (!row.length) continue;
      row.sort((p, q) => p[0] - q[0]);
      if (flip) row.reverse();
      out.push(...row);
      flip = !flip;
    }
  }
  return out.map(([a, bb]) => f.toLL(a * v[0] + bb * u[0], a * v[1] + bb * u[1]));
}

/** Small seeded random generator, so a random layout stays put until deliberately reshuffled. */
export function seededRandom(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Is [lat,lon] inside the ring [[lat,lon], ...]? */
export function insideRing(ring, lat, lon) {
  return ring.length >= 3 && pointInPolygon(ring.map((p) => [p[1], p[0]]), [lon, lat]);
}

/**
 * Build the automatic parts of a plan from its areas.
 * areas: [{id, ring, fill: 'points'|'route'|'none', pattern, spacing, bearing, count, randomStart, seed}]
 * A smaller area overlapping a larger one owns its ground: the larger area's
 * points are left out of it. So a focus area replaces the site grid inside it,
 * and an area with fill 'none' is an exclusion zone.
 * Returns {points: [{lat, lon, area, kind}], route: [[lat,lon]], counts: {areaId: n}}.
 */
export function buildPlan(areas) {
  const valid = areas.filter((a) => a.ring.length >= 3);
  const size = new Map(valid.map((a) => [a.id, polygonArea(a.ring)]));
  const points = [], route = [], counts = {};
  for (const a of valid) {
    const b = Number.isFinite(a.bearing) ? a.bearing : longestEdgeBearing(a.ring);
    if (a.fill === 'points') {
      const exclude = valid.filter((o) => o !== a && size.get(o.id) < size.get(a.id)).map((o) => o.ring);
      const made = samplePoints(a.ring, { ...a, bearing: b, exclude }, seededRandom(a.seed || 1));
      counts[a.id] = made.length;
      for (const [lat, lon] of made) points.push({ lat, lon, area: a.id, kind: a.pattern === 'random' ? 'random' : 'grid' });
    } else if (a.fill === 'route') {
      const t = generateTransects(a.ring, a.spacing, b);
      counts[a.id] = t.length / 2;
      route.push(...t);
    }
  }
  return { points, route, counts };
}
