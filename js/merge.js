// Instrument CSV parsing + time-matching of readings onto the GPS track.
// Pure logic, no DOM (unit-tested in Node).

export function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (!q && c in counts) counts[c]++;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

/** RFC4180-ish CSV parser. Returns array of rows (arrays of strings). */
export function parseCSV(text, delim = detectDelimiter(text)) {
  const rows = [];
  let row = [], cell = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

export function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCSV(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Extract {y,m,d} from a string, or null. order: 'dmy' | 'mdy'. */
export function parseDatePart(s, order = 'dmy') {
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return order === 'mdy' ? { y, m: +m[1], d: +m[2] } : { y, m: +m[2], d: +m[1] };
  }
  m = s.match(/(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{2,4})/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return { y, m: MONTHS[m[2].toLowerCase()], d: +m[1] };
  }
  return null;
}

export function parseTimePart(s) {
  const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*([AaPp])?/);
  if (!m) return null;
  let h = +m[1];
  if (m[4]) {
    const pm = m[4].toLowerCase() === 'p';
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
  }
  return { h, mi: +m[2], s: m[3] ? parseFloat(m[3]) : 0 };
}

/**
 * Parse an instrument timestamp to epoch ms, or NaN.
 * opts: order ('dmy'|'mdy'), zone ('local'|'utc'), fallbackDate {y,m,d} for time-only values.
 */
export function parseInstrumentTime(dateStr, timeStr, opts = {}) {
  const { order = 'dmy', zone = 'local', fallbackDate = null } = opts;
  const s = [dateStr, timeStr].filter((v) => v != null && v !== '').join(' ').trim();
  if (!s) return NaN;
  if (/^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:?\d{2})$/.test(s)) return Date.parse(s);
  if (/^\d{9,10}(\.\d+)?$/.test(s)) return parseFloat(s) * 1000;
  if (/^\d{12,13}$/.test(s)) return +s;
  const d = parseDatePart(s, order) || fallbackDate;
  // Strip the date before looking for the time so "2026-11-14" can't confuse it.
  const tm = parseTimePart(s.replace(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/, ' '));
  if (!d || !tm) return NaN;
  const sec = Math.floor(tm.s), ms = Math.round((tm.s - sec) * 1000);
  return zone === 'utc'
    ? Date.UTC(d.y, d.m - 1, d.d, tm.h, tm.mi, sec, ms)
    : new Date(d.y, d.m - 1, d.d, tm.h, tm.mi, sec, ms).getTime();
}

/** Look at date strings and decide whether they must be day-first or month-first. */
export function detectDateOrder(samples) {
  for (const s of samples) {
    const m = String(s).match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (!m || /^\d{4}/.test(m[0])) continue;
    if (+m[1] > 12) return 'dmy';
    if (+m[2] > 12) return 'mdy';
  }
  return null;
}

export function guessTimeColumns(header) {
  const h = header.map((v) => v.trim().toLowerCase());
  const find = (re) => h.findIndex((v) => re.test(v));
  const dt = find(/date.?time|timestamp|^time ?stamp/);
  if (dt >= 0) return { dateCol: dt, timeCol: -1 };
  const d = find(/date/), t = find(/time/);
  if (d >= 0 && t >= 0 && d !== t) return { dateCol: d, timeCol: t };
  if (t >= 0) return { dateCol: -1, timeCol: t };
  if (d >= 0) return { dateCol: d, timeCol: -1 };
  return { dateCol: 0, timeCol: -1 };
}

/**
 * Position at time t (ms) from track points sorted by t.
 * Interpolates between the surrounding points when they are at most maxGapS
 * apart, else snaps to the nearest point within maxGapS, else null.
 */
export function positionAt(points, t, maxGapS = 30) {
  const n = points.length;
  if (!n) return null;
  let lo = 0, hi = n - 1;
  if (t <= points[0].t) hi = 0;
  else if (t >= points[n - 1].t) lo = n - 1;
  else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= t) lo = mid; else hi = mid;
    }
  }
  const a = points[lo], b = points[hi];
  const gap = maxGapS * 1000;
  if (lo !== hi && b.t - a.t <= gap && b.t > a.t) {
    const f = (t - a.t) / (b.t - a.t);
    return {
      lat: a.lat + f * (b.lat - a.lat), lon: a.lon + f * (b.lon - a.lon),
      acc: Math.max(a.acc ?? 0, b.acc ?? 0), match: 'interpolated',
      gapS: Math.min(t - a.t, b.t - t) / 1000,
    };
  }
  const near = Math.abs(t - a.t) <= Math.abs(t - b.t) ? a : b;
  const d = Math.abs(t - near.t);
  if (d <= gap) return { lat: near.lat, lon: near.lon, acc: near.acc ?? null, match: 'nearest', gapS: d / 1000 };
  return null;
}

/**
 * Merge instrument rows with a track.
 * rows: data rows (no header). opts: dateCol, timeCol, order, zone,
 * offsetS (added to instrument time to get true time), maxGapS, fallbackDate.
 * Returns {header additions, rows: [{cells, t, pos}], matched}.
 */
export function mergeReadings(rows, points, opts) {
  const pts = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  let matched = 0, badTime = 0;
  const out = rows.map((cells) => {
    const ds = opts.dateCol >= 0 ? cells[opts.dateCol] : '';
    const ts = opts.timeCol >= 0 ? cells[opts.timeCol] : '';
    let t = parseInstrumentTime(ds, ts, opts);
    if (!Number.isFinite(t)) { badTime++; return { cells, t: NaN, pos: null }; }
    t += (opts.offsetS || 0) * 1000;
    const pos = positionAt(pts, t, opts.maxGapS ?? 30);
    if (pos) matched++;
    return { cells, t, pos };
  });
  return { rows: out, matched, badTime, total: rows.length };
}

export const MERGE_COLS = ['latitude', 'longitude', 'gps_accuracy_m', 'time_utc', 'gps_match', 'gps_gap_s'];

export function mergedTable(header, merged) {
  const table = [[...header, ...MERGE_COLS]];
  for (const r of merged.rows) {
    const p = r.pos;
    table.push([
      ...header.map((_, i) => r.cells[i] ?? ''),
      p ? p.lat.toFixed(7) : '', p ? p.lon.toFixed(7) : '',
      p && p.acc != null ? p.acc.toFixed(1) : '',
      Number.isFinite(r.t) ? new Date(r.t).toISOString() : '',
      p ? p.match : Number.isFinite(r.t) ? 'no_gps' : 'bad_time',
      p ? p.gapS.toFixed(1) : '',
    ]);
  }
  return table;
}

export function mergedGeoJSON(header, merged) {
  const features = [];
  for (const r of merged.rows) {
    if (!r.pos) continue;
    const props = {};
    header.forEach((h, i) => {
      const v = r.cells[i] ?? '';
      const n = v.trim() !== '' && !isNaN(v) ? Number(v) : v;
      props[h || 'col' + (i + 1)] = n;
    });
    props.time_utc = new Date(r.t).toISOString();
    props.gps_accuracy_m = r.pos.acc;
    props.gps_match = r.pos.match;
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [+r.pos.lon.toFixed(7), +r.pos.lat.toFixed(7)] }, properties: props });
  }
  return { type: 'FeatureCollection', name: 'readings', features };
}
