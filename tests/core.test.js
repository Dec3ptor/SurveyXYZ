import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, bearing, LocalFrame, generateTransects, nearestOnRoute, polygonArea, pathLength, Coverage, angDiff } from '../js/geo.js';
import { FusionFilter, StepDetector } from '../js/fusion.js';
import { parseCSV, parseInstrumentTime, detectDateOrder, positionAt, mergeReadings, mergedTable, guessTimeColumns, detectDelimiter } from '../js/merge.js';
import { trackCSV, gpx, parsePlanFile, planGeoJSON, obsGeoJSON } from '../js/exporters.js';
import { makeZip } from '../js/zip.js';

const LAT = -37.8, LON = 145.0;
const F = new LocalFrame(LAT, LON);
// deterministic pseudo-random gaussian
function rng(seed) { let s = seed; const u = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()); }

test('geodesy basics', () => {
  const [lat2, lon2] = F.toLL(100, 0);
  assert.ok(Math.abs(haversine(LAT, LON, lat2, lon2) - 100) < 0.05);
  assert.ok(Math.abs(bearing(LAT, LON, lat2, lon2) - 90) < 0.1);
  assert.equal(angDiff(350, 10), -20);
  assert.equal(angDiff(10, 350), 20);
});

test('transects cover a 100 x 50 m rectangle at 10 m spacing', () => {
  const sq = [[0, 0], [100, 0], [100, 50], [0, 50]].map(([x, y]) => F.toLL(x, y));
  assert.ok(Math.abs(polygonArea(sq) - 5000) < 1);
  const r = generateTransects(sq, 10, 0); // lines run north-south
  assert.equal(r.length, 20); // 10 lines x 2 endpoints
  const xy = r.map((p) => F.toXY(p[0], p[1]));
  assert.ok(Math.abs(xy[0][0] - 5) < 0.01 && Math.abs(xy[2][0] - 15) < 0.01);
  // serpentine: line 1 ends where line 2 starts (same y)
  assert.ok(Math.abs(xy[1][1] - xy[2][1]) < 0.01);
  assert.ok(Math.abs(pathLength(r) - (10 * 50 + 9 * 10)) < 0.5);
});

test('cross-track sign: right of travel is positive', () => {
  const route = [[0, 0], [0, 100]]; // heading north
  assert.ok(Math.abs(nearestOnRoute(route, [3, 50]).xte - 3) < 1e-9);
  assert.ok(Math.abs(nearestOnRoute(route, [-2, 50]).xte + 2) < 1e-9);
});

test('route hint keeps guidance on current transect', () => {
  const route = [[0, 0], [0, 100], [10, 100], [10, 0]];
  const r = nearestOnRoute(route, [5.5, 50], 0); // slightly nearer the return leg
  assert.equal(r.idx, 0);
  assert.equal(nearestOnRoute(route, [9.5, 50], 0).idx, 2); // clearly on the other one
});

test('coverage marks walked samples', () => {
  const route = [[0, 0], [0, 100]].map(([x, y]) => F.toLL(x, y));
  const c = new Coverage(route, 2);
  for (let y = 0; y <= 50; y += 1) c.mark(...F.toLL(1, y), 3);
  assert.ok(c.fraction > 0.48 && c.fraction < 0.56, String(c.fraction));
  assert.equal(c.runs().length, 1);
});

function simulate(mode, withSensors) {
  const g = rng(42);
  const f = new FusionFilter({ mode });
  let t = 1e12, errF = 0, errR = 0, n = 0, stillDrift = 0, stillRaw = 0, x = 0, y = 0;
  let prevStill = null, prevRaw = null, jumpsUsed = 0;
  const fix = (sx, sy, acc, speed) => {
    const [lat, lon] = F.toLL(sx, sy);
    return f.onGps({ t, lat, lon, acc, speed, heading: 0 });
  };
  // 30 s still, 120 s walk north at 1.4 m/s (2 steps/s, 0.7 m), 60 s still. GPS noise sigma 4 m.
  for (let s = 0; s < 210; s++) {
    t += 1000;
    const walking = s >= 30 && s < 150;
    if (withSensors) {
      f.setMotion(true, walking);
      f.setCompass(20); // phone carried 20 deg off the direction of travel
      if (walking) { f.onStep(); f.onStep(); }
    }
    if (walking) y += 1.4;
    let nx = x + g() * 4, ny = y + g() * 4;
    const jump = s === 100 || s === 180;
    if (jump) { nx += 60; ny -= 40; }
    const r = fix(nx, ny, 5, walking ? 1.4 : 0.05);
    if (jump && r.used) jumpsUsed++;
    const [fx, fy] = F.toXY(r.lat, r.lon);
    if (s > 5) { errF += Math.hypot(fx - x, fy - y); errR += Math.hypot(nx - x, ny - y); n++; }
    if (s >= 160) {
      if (prevStill) { stillDrift += Math.hypot(fx - prevStill[0], fy - prevStill[1]); stillRaw += Math.hypot(nx - prevRaw[0], ny - prevRaw[1]); }
      prevStill = [fx, fy]; prevRaw = [nx, ny];
    }
  }
  return { errF: errF / n, errR: errR / n, stillDrift, stillRaw, jumpsUsed, f };
}

test('smart fusion beats raw GPS, rejects jumps and holds still', () => {
  const r = simulate('smart', true);
  assert.ok(r.errF < r.errR * 0.6, `filtered ${r.errF.toFixed(2)} vs raw ${r.errR.toFixed(2)}`);
  assert.equal(r.jumpsUsed, 0);
  assert.ok(r.stillDrift < r.stillRaw * 0.15, `still drift ${r.stillDrift.toFixed(1)} vs raw ${r.stillRaw.toFixed(1)}`);
  assert.ok(Math.abs(angDiff(r.f.hdgOffset, -20)) < 5, 'learned compass offset ' + r.f.hdgOffset);
});

test('gps-only smoothing still improves on raw and rejects jumps', () => {
  const r = simulate('gps', false);
  assert.ok(r.errF < r.errR * 0.85, `filtered ${r.errF.toFixed(2)} vs raw ${r.errR.toFixed(2)}`);
  assert.equal(r.jumpsUsed, 0);
});

test('filter re-locks when GPS persistently disagrees', () => {
  const f = new FusionFilter({ mode: 'smart' });
  let t = 1e12;
  f.setMotion(true, false);
  for (let i = 0; i < 10; i++) f.onGps({ t: (t += 1000), lat: LAT, lon: LON, acc: 4 });
  const [la, lo] = F.toLL(200, 0);
  let last;
  for (let i = 0; i < 6; i++) last = f.onGps({ t: (t += 1000), lat: la, lon: lo, acc: 4 });
  assert.ok(haversine(last.lat, last.lon, la, lo) < 1);
});

test('dead reckoning carries position through a GPS outage', () => {
  const f = new FusionFilter({ mode: 'smart' });
  let t = 1e12;
  f.setMotion(true, true); f.setCompass(90);
  for (let i = 0; i < 40; i++) { // walk east with GPS to learn offset
    f.onStep(); f.onStep();
    const [lat, lon] = F.toLL(i * 1.44, 0);
    f.onGps({ t: (t += 1000), lat, lon, acc: 4, speed: 1.44, heading: 90 });
  }
  const before = F.toXY(f.position.lat, f.position.lon);
  for (let i = 0; i < 40; i++) f.onStep(); // 20 s without GPS
  const after = F.toXY(f.position.lat, f.position.lon);
  assert.ok(Math.abs(after[0] - before[0] - 40 * f.stepLen) < 2);
  assert.ok(Math.abs(after[1] - before[1]) < 3);
});

test('step detector counts a 2 Hz walk and reports stillness', () => {
  const d = new StepDetector();
  let steps = 0, t = 0;
  for (let i = 0; i < 600; i++, t += 1000 / 60) if (d.sample(9.81 + 3 * Math.sin(2 * Math.PI * 2 * t / 1000), t)) steps++;
  assert.ok(steps >= 18 && steps <= 21, 'steps ' + steps);
  assert.ok(d.moving(t));
  for (let i = 0; i < 400; i++, t += 1000 / 60) d.sample(9.81, t);
  assert.ok(!d.moving(t));
});

test('csv + time parsing', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  const rows = parseCSV('Date,Time,"CH4, ppm"\r\n14/11/2026,10:00:05,"1,200"\r\n\r\n14/11/2026,10:00:10,35\r\n');
  assert.equal(rows.length, 3);
  assert.equal(rows[1][2], '1,200');
  assert.deepEqual(guessTimeColumns(rows[0]), { dateCol: 0, timeCol: 1 });
  const u = { zone: 'utc' };
  assert.equal(parseInstrumentTime('14/11/2026', '10:00:05', u), Date.UTC(2026, 10, 14, 10, 0, 5));
  assert.equal(parseInstrumentTime('11/14/2026 1:02:03 PM', '', { ...u, order: 'mdy' }), Date.UTC(2026, 10, 14, 13, 2, 3));
  assert.equal(parseInstrumentTime('2026-11-14 10:00:05', '', u), Date.UTC(2026, 10, 14, 10, 0, 5));
  assert.equal(parseInstrumentTime('14-Nov-2026 10:00', '', u), Date.UTC(2026, 10, 14, 10, 0, 0));
  assert.equal(parseInstrumentTime('2026-11-14T10:00:05Z', ''), Date.UTC(2026, 10, 14, 10, 0, 5));
  assert.equal(parseInstrumentTime('', '10:00:05', { ...u, fallbackDate: { y: 2026, m: 11, d: 14 } }), Date.UTC(2026, 10, 14, 10, 0, 5));
  assert.ok(Number.isNaN(parseInstrumentTime('hello', '')));
  assert.equal(detectDateOrder(['01/02/2026', '14/11/2026']), 'dmy');
  assert.equal(detectDateOrder(['11/14/2026']), 'mdy');
});

test('merge interpolates, applies clock offset, respects gaps', () => {
  const t0 = Date.UTC(2026, 10, 14, 10, 0, 0);
  const pts = [0, 1, 2, 3, 4].map((i) => ({ t: t0 + i * 2000, lat: LAT + i * 1e-5, lon: LON, acc: 4 }));
  pts.push({ t: t0 + 300000, lat: LAT + 1, lon: LON, acc: 4 });
  const p = positionAt(pts, t0 + 3000);
  assert.equal(p.match, 'interpolated');
  assert.ok(Math.abs(p.lat - (LAT + 1.5e-5)) < 1e-9);
  assert.equal(positionAt(pts, t0 + 100000), null); // inside the long gap
  assert.equal(positionAt(pts, t0 + 20000).match, 'nearest');
  assert.equal(positionAt(pts, t0 - 5000).match, 'nearest');
  const rows = [['14/11/2026', '10:00:13', '55'], ['14/11/2026', '11:30:00', '2'], ['bad', '', '1']];
  // instrument is 10 s fast, so offset is -10
  const m = mergeReadings(rows, pts, { dateCol: 0, timeCol: 1, zone: 'utc', offsetS: -10, maxGapS: 30 });
  assert.equal(m.matched, 1);
  assert.equal(m.badTime, 1);
  assert.ok(Math.abs(m.rows[0].pos.lat - (LAT + 1.5e-5)) < 1e-9);
  const table = mergedTable(['Date', 'Time', 'CH4'], m);
  assert.equal(table[0].length, 9);
  assert.equal(table[2][7], 'no_gps');
  assert.equal(table[3][7], 'bad_time');
});

test('exports and plan import round-trip', async () => {
  const survey = { name: 'Test & <site>', created: 1e12, plan: { boundary: [[1, 2], [1, 3], [2, 3]], route: [[1, 2], [1.5, 2.5]] } };
  const pts = [{ t: 1e12, lat: 1, lon: 2, rlat: 1.00001, rlon: 2, acc: 4.2, seg: 1, src: 'gps', mov: 1 }, { t: 1e12 + 1000, lat: 1.1, lon: 2.1, rlat: 1.1, rlon: 2.1, acc: 5, seg: 1, src: 'gps', mov: 1 }];
  const csv = parseCSV(trackCSV(pts));
  assert.equal(csv.length, 3);
  assert.equal(csv[1][csv[0].indexOf('latitude')], '1');
  assert.equal(csv[1][csv[0].indexOf('raw_latitude')], '1.00001');
  const obs = [{ num: 1, t: 1e12, lat: 1, lon: 2, category: 'Crack', note: 'a "b"', photoIds: ['x'] }];
  const x = gpx(survey, pts, obs);
  assert.ok(x.includes('Test &amp; &lt;site&gt;') && x.includes('<trkpt lat="1.1" lon="2.1">'));
  assert.equal(obsGeoJSON(obs).features[0].properties.photo, 'photos/obs001_1.jpg');
  const back = parsePlanFile(JSON.stringify(planGeoJSON(survey)));
  assert.deepEqual(back.boundary, survey.plan.boundary);
  assert.deepEqual(back.route, survey.plan.route);
  assert.equal(parsePlanFile(x).route.length, 2); // planned route preferred over track
  const kml = '<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>2,1,0 3,1,0 3,2,0 2,1,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>';
  assert.deepEqual(parsePlanFile(kml).boundary, [[1, 2], [1, 3], [2, 3]]);
  const zip = await makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'b/c.bin', data: new Uint8Array([1, 2, 3]) }]);
  const buf = new Uint8Array(await zip.arrayBuffer());
  assert.equal(buf[0], 0x50); assert.equal(buf[1], 0x4b);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.ZIP_OUT || '/dev/null', buf);
});
