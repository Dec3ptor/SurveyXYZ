// Export / import formats. No DOM dependencies beyond Blob (works in Node for tests).
import { toCSV } from './merge.js';
import { pathLength } from './geo.js';

const f7 = (v) => (Number.isFinite(v) ? +v.toFixed(7) : null);
const f1 = (v) => (Number.isFinite(v) ? +v.toFixed(1) : null);
const f2 = (v) => (Number.isFinite(v) ? +v.toFixed(2) : null);
const iso = (t) => new Date(t).toISOString();
const xml = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function localStamp(t) {
  const d = new Date(t), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function safeName(s) {
  return (String(s || 'survey').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'survey').slice(0, 60);
}

export const TRACK_COLS = ['time_utc', 'time_local', 'unix_ms', 'latitude', 'longitude', 'raw_latitude', 'raw_longitude',
  'accuracy_m', 'altitude_m', 'speed_ms', 'course_deg', 'compass_deg', 'moving', 'source', 'reject_reason', 'segment', 'offpath_m'];

export function trackCSV(points) {
  const rows = [TRACK_COLS];
  for (const p of points) {
    rows.push([iso(p.t), localStamp(p.t), p.t, f7(p.lat), f7(p.lon), f7(p.rlat), f7(p.rlon), f1(p.acc), f1(p.alt),
      f2(p.spd), f1(p.crs), f1(p.cmp), p.mov ? 1 : 0, p.src, p.why || '', p.seg, f1(p.xte)]);
  }
  return toCSV(rows);
}

export function photoName(obs, i) {
  return `photos/obs${String(obs.num).padStart(3, '0')}_${i + 1}.jpg`;
}

export const OBS_COLS = ['number', 'time_utc', 'time_local', 'latitude', 'longitude', 'accuracy_m', 'category', 'note', 'reading', 'unit', 'extent_m', 'photos'];
export const notesOnly = (obs) => obs.filter((o) => o.kind !== 'sample');
export const samplesOnly = (obs) => obs.filter((o) => o.kind === 'sample');

export function obsCSV(obs) {
  const rows = [OBS_COLS];
  for (const o of notesOnly(obs)) {
    rows.push([o.num, iso(o.t), localStamp(o.t), f7(o.lat), f7(o.lon), f1(o.acc), o.category || '', o.note || '',
      o.reading ?? '', o.unit || '', o.extent ?? '', (o.photoIds || []).map((_, i) => photoName(o, i)).join(';')]);
  }
  return toCSV(rows);
}

function segments(points, latKey = 'lat', lonKey = 'lon') {
  const segs = new Map();
  for (const p of points) {
    if (!Number.isFinite(p[latKey])) continue;
    if (latKey === 'rlat' && p.src === 'dr') continue;
    if (!segs.has(p.seg)) segs.set(p.seg, []);
    segs.get(p.seg).push(p);
  }
  return [...segs.values()];
}

const fc = (name, features) => ({ type: 'FeatureCollection', name, features });

export function trackLineGeoJSON(survey, points) {
  const lines = segments(points).filter((s) => s.length > 1);
  const coords = lines.map((s) => s.map((p) => [f7(p.lon), f7(p.lat)]));
  if (!coords.length) return fc('track_line', []);
  const first = points[0], last = points[points.length - 1];
  return fc('track_line', [{
    type: 'Feature',
    geometry: { type: 'MultiLineString', coordinates: coords },
    properties: {
      survey: survey.name, start_utc: iso(first.t), end_utc: iso(last.t),
      length_m: Math.round(lines.reduce((d, s) => d + pathLength(s.map((p) => [p.lat, p.lon])), 0)),
    },
  }]);
}

export function trackPointsGeoJSON(points) {
  return fc('track_points', points.filter((p) => Number.isFinite(p.lat)).map((p) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [f7(p.lon), f7(p.lat)] },
    properties: {
      time_utc: iso(p.t), unix_ms: p.t, accuracy_m: f1(p.acc), altitude_m: f1(p.alt), speed_ms: f2(p.spd),
      raw_latitude: f7(p.rlat), raw_longitude: f7(p.rlon), moving: p.mov ? 1 : 0, source: p.src, segment: p.seg, offpath_m: f1(p.xte),
    },
  })));
}

export function obsGeoJSON(obs) {
  return fc('observations', notesOnly(obs).map((o) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [f7(o.lon), f7(o.lat)] },
    properties: {
      number: o.num, time_utc: iso(o.t), category: o.category || '', note: o.note || '',
      reading: o.reading ?? null, unit: o.unit || '', extent_m: o.extent ?? null, accuracy_m: f1(o.acc),
      photo: (o.photoIds || []).length ? photoName(o, 0) : '',
      photos: (o.photoIds || []).map((_, i) => photoName(o, i)).join(';'),
    },
  })));
}

export function planGeoJSON(survey) {
  const plan = survey.plan || {};
  const feats = [];
  for (const a of plan.areas || []) {
    if (a.ring.length < 3) continue;
    const ring = a.ring.map((p) => [f7(p[1]), f7(p[0])]);
    ring.push(ring[0]);
    feats.push({
      type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] },
      properties: { kind: 'area', name: a.name, fill: a.fill, pattern: a.fill === 'points' ? a.pattern : null, spacing_m: a.fill !== 'none' && a.pattern !== 'random' ? a.spacing : null, bearing_deg: a.bearing ?? null, count: a.pattern === 'random' ? a.count : null, survey: survey.name },
    });
  }
  if (plan.route?.length >= 2) {
    feats.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: plan.route.map((p) => [f7(p[1]), f7(p[0])]) },
      properties: { kind: 'planned_route', survey: survey.name, spacing_m: plan.spacing ?? null, bearing_deg: plan.bearing ?? null, length_m: Math.round(pathLength(plan.route)) },
    });
  }
  for (const pt of plan.points || []) {
    feats.push({
      type: 'Feature', geometry: { type: 'Point', coordinates: [f7(pt.lon), f7(pt.lat)] },
      properties: { kind: 'sample_point', id: pt.id, point_type: pt.kind, area: (plan.areas || []).find((a) => a.id === pt.area)?.name || '', status: pt.status, reason: pt.why || '', survey: survey.name },
    });
  }
  return fc('plan', feats);
}

const list = (v) => (Array.isArray(v) ? v.join('; ') : v ?? '');
export const SAMPLE_COLS = ['sample_id', 'location_id', 'sample_type', 'date_local', 'time_local', 'time_utc', 'depth_from_m', 'depth_to_m',
  'latitude', 'longitude', 'gps_accuracy_m', 'planned_latitude', 'planned_longitude', 'offset_from_planned_m',
  'method', 'material', 'soil_type', 'colour', 'moisture', 'odour', 'evidence', 'pid_ppm', 'analytes', 'containers', 'sampler', 'weather', 'notes', 'photos'];

function sampleRow(survey, o) {
  const d = o.data || {};
  const pt = (survey.plan?.points || []).find((p) => p.id === o.pointId);
  const plat = pt?.plat ?? pt?.lat, plon = pt?.plon ?? pt?.lon;
  const R = 6371008.8, r = Math.PI / 180;
  const off = pt ? Math.hypot((o.lat - plat) * r * R, (o.lon - plon) * r * R * Math.cos(o.lat * r)) : null;
  const ls = localStamp(o.t);
  return [d.sampleId || '', o.pointId || '', d.type || '', ls.slice(0, 10), ls.slice(11), iso(o.t), d.depthFrom ?? '', d.depthTo ?? '',
    f7(o.lat), f7(o.lon), f1(o.acc), pt ? f7(plat) : '', pt ? f7(plon) : '', pt ? f1(off) : '',
    d.method || '', d.stratum || '', list(d.soil), d.colour || '', d.moisture || '', d.odour || '', list(d.evidence), d.pid ?? '',
    list(d.analytes), d.containers || '', d.sampler || '', d.weather || '', o.note || '', (o.photoIds || []).map((_, i) => photoName(o, i)).join(';')];
}
export function samplesCSV(survey, obs) {
  return toCSV([SAMPLE_COLS, ...samplesOnly(obs).map((o) => sampleRow(survey, o))]);
}
export function samplesGeoJSON(survey, obs) {
  return fc('samples', samplesOnly(obs).map((o) => {
    const row = sampleRow(survey, o), props = {};
    SAMPLE_COLS.forEach((c, i) => { props[c] = row[i] === '' ? null : row[i]; });
    props.photo = (o.photoIds || []).length ? photoName(o, 0) : '';
    return { type: 'Feature', geometry: { type: 'Point', coordinates: [f7(o.lon), f7(o.lat)] }, properties: props };
  }));
}

/** Everything in one GeoJSON file (mixed geometry; QGIS splits it into layers on load). */
export function allGeoJSON(survey, points, obs) {
  const tag = (g, layer) => g.features.map((f) => ({ ...f, properties: { layer, ...f.properties } }));
  return fc(safeName(survey.name), [
    ...tag(planGeoJSON(survey), 'plan'),
    ...tag(trackLineGeoJSON(survey, points), 'track'),
    ...tag(obsGeoJSON(obs), 'observation'),
    ...tag(samplesGeoJSON(survey, obs), 'sample'),
  ]);
}

export function gpx(survey, points, obs) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="SurveyXYZ" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${xml(survey.name)}</name><time>${iso(survey.created)}</time></metadata>`];
  for (const o of obs) {
    out.push(`<wpt lat="${f7(o.lat)}" lon="${f7(o.lon)}"><time>${iso(o.t)}</time><name>${xml(o.kind === 'sample' ? o.data?.sampleId || o.pointId || 'sample' : `${o.num} ${o.category || ''}`.trim())}</name>` +
      `<desc>${xml([o.note, o.reading != null && o.reading !== '' ? `${o.reading} ${o.unit || ''}` : ''].filter(Boolean).join(' | '))}</desc></wpt>`);
  }
  if (survey.plan?.route?.length >= 2) {
    out.push(`<rte><name>${xml(survey.name)} plan</name>`);
    for (const p of survey.plan.route) out.push(`<rtept lat="${f7(p[0])}" lon="${f7(p[1])}"/>`);
    out.push('</rte>');
  }
  const segs = segments(points);
  if (segs.length) {
    out.push(`<trk><name>${xml(survey.name)}</name>`);
    for (const s of segs) {
      out.push('<trkseg>');
      for (const p of s) {
        out.push(`<trkpt lat="${f7(p.lat)}" lon="${f7(p.lon)}">${Number.isFinite(p.alt) ? `<ele>${f1(p.alt)}</ele>` : ''}<time>${iso(p.t)}</time>` +
          `${Number.isFinite(p.acc) ? `<hdop>${f1(p.acc / 5)}</hdop>` : ''}</trkpt>`);
      }
      out.push('</trkseg>');
    }
    out.push('</trk>');
  }
  out.push('</gpx>');
  return out.join('\n');
}

export function packageReadme(survey, points, obs) {
  return `SurveyXYZ export: ${survey.name}
Exported: ${localStamp(Date.now())} (device local time)
Coordinates: WGS84 (EPSG:4326), decimal degrees. Times: UTC unless the column says local.
${(survey.gaps || []).length ? 'Gaps while the phone was locked or the app was in the background (nothing recorded):\n' + survey.gaps.map((g) => `  ${localStamp(g.from)} to ${localStamp(g.to).slice(11)}`).join('\n') + '\n' : ''}Instrument clock offset recorded in the field: ${survey.clockOffsetS ?? 'not set'} s (add to instrument time to get true time)

track.csv              one row per GPS fix (${points.length} rows). latitude/longitude are the
                       filtered position; raw_latitude/raw_longitude are exactly what the GPS
                       reported. source: gps = fix used, rej = fix distrusted (see reject_reason),
                       dr = dead-reckoned from steps + compass while GPS was absent,
                       import = from a GPX track added afterwards.
track_line.geojson     the walked path as a line (one part per recording segment)
track_points.geojson   every fix as a point with attributes
observations.geojson   notes / marks / manual readings (${notesOnly(obs).length}); 'photo' is a relative path
observations.csv       same, as a table
samples.csv            sample register (${samplesOnly(obs).length}): ID, location, depth, type, soil description,
                       analysis requested, actual and planned coordinates
samples.geojson        same, as points
plan.geojson           plan areas (site, focus and exclusion areas with their settings), planned
                       route and planned sampling points (with status and area)
track.gpx              track + waypoints + planned route for GPS tools / Google Earth
survey.json            full backup; re-import in SurveyXYZ (Menu > Surveys > Import backup)
photos/                observation photos, named obsNNN_n.jpg

QGIS: drag the .geojson files onto the map. For track.csv or a merged readings CSV use
Layer > Add Layer > Add Delimited Text Layer, X = longitude, Y = latitude, CRS EPSG:4326.
To show photos on click: observations layer > Properties > Attributes Form > 'photo' >
widget type Attachment, relative path, integrated viewer: Image.
`;
}

// ---- plan import (GeoJSON / GPX / KML) ----

function fromGeoJSON(obj) {
  const res = { areas: [], route: null, points: [] };
  const visit = (g, props) => {
    if (!g) return;
    if (g.type === 'FeatureCollection') g.features.forEach((f) => visit(f));
    else if (g.type === 'Feature') visit(g.geometry, g.properties);
    else if (g.type === 'GeometryCollection') g.geometries.forEach(visit);
    else if (g.type === 'Point') res.points.push({ lat: g.coordinates[1], lon: g.coordinates[0], id: props?.id ?? props?.name ?? props?.Name ?? null, type: props?.point_type ?? null });
    else if (g.type === 'Polygon') res.areas.push({ ring: g.coordinates[0], props: props || {} });
    else if (g.type === 'MultiPolygon') g.coordinates.forEach((c) => res.areas.push({ ring: c[0], props: props || {} }));
    else if (g.type === 'LineString' && !res.route) res.route = g.coordinates;
    else if (g.type === 'MultiLineString' && !res.route) res.route = g.coordinates.flat();
  };
  visit(obj);
  const ll = (c) => c && c.map((p) => [p[1], p[0]]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  res.route = ll(res.route);
  res.areas = res.areas.map(({ ring, props }) => ({
    ring: ll(ring), name: props.name ?? props.Name ?? null, fill: props.fill ?? null, pattern: props.pattern ?? null,
    spacing: props.spacing_m ?? null, bearing: props.bearing_deg ?? null, count: props.count ?? null,
  }));
  return res;
}

function kmlCoords(s) {
  return s.trim().split(/\s+/).map((t) => t.split(',').map(Number)).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[1], p[0]]);
}

/** Parse a plan file. Returns {areas: [{ring, name, ...}], route: [[lat,lon]]|null, points: [{lat, lon, id}]}. */
export function parsePlanFile(text) {
  const t = text.trim();
  let res;
  if (t.startsWith('{') || t.startsWith('[')) res = fromGeoJSON(JSON.parse(t));
  else if (/<gpx[\s>]/i.test(t)) {
    const grab = (tag) => [...t.matchAll(new RegExp('<' + tag + '\\b([^>]*)>', 'gi'))].map((m) => {
      const lat = m[1].match(/lat\s*=\s*["']([^"']+)/i), lon = m[1].match(/lon\s*=\s*["']([^"']+)/i);
      return [lat ? +lat[1] : NaN, lon ? +lon[1] : NaN];
    }).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    let pts = grab('rtept');
    if (pts.length < 2) pts = grab('trkpt');
    const wpts = [...t.matchAll(/<wpt\b([^>]*)>([\s\S]*?)<\/wpt>/gi)].map((m) => ({
      lat: +(m[1].match(/lat\s*=\s*["']([^"']+)/i) || [])[1], lon: +(m[1].match(/lon\s*=\s*["']([^"']+)/i) || [])[1],
      id: (m[2].match(/<name>([^<]*)<\/name>/i) || [])[1] || null,
    }));
    res = { areas: [], route: pts, points: wpts };
  } else if (/<kml[\s>]/i.test(t)) {
    const marks = [...t.matchAll(/<Placemark[\s\S]*?<\/Placemark>/gi)].map((m) => m[0]);
    const areas = (marks.length ? marks : [t]).filter((m) => /<Polygon[\s>]/i.test(m)).map((m) => ({
      ring: kmlCoords((m.match(/<Polygon[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i) || [])[1] || ''),
      name: (m.match(/<name>([^<]*)<\/name>/i) || [])[1] || null,
    }));
    const line = t.match(/<LineString[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i);
    const pms = [...t.matchAll(/<Placemark[\s\S]*?<\/Placemark>/gi)].map((m) => m[0]).filter((m) => /<Point[\s>]/i.test(m));
    const points = pms.map((m) => {
      const c = kmlCoords((m.match(/<Point[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i) || [])[1] || '')[0];
      return c ? { lat: c[0], lon: c[1], id: (m.match(/<name>([^<]*)<\/name>/i) || [])[1] || null } : null;
    }).filter(Boolean);
    res = { areas, route: line ? kmlCoords(line[1]) : null, points };
  } else throw new Error('Unrecognised file: expected GeoJSON, GPX or KML');
  // Closed rings repeat the first vertex; we store them open.
  for (const a of res.areas) {
    const b = a.ring;
    if (b.length > 1 && b[0][0] === b[b.length - 1][0] && b[0][1] === b[b.length - 1][1]) b.pop();
  }
  res.areas = res.areas.filter((a) => a.ring.length >= 3);
  if (res.route && res.route.length < 2) res.route = null;
  res.points = (res.points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!res.areas.length && !res.route && !res.points.length) throw new Error('No polygon, line or points found in file');
  return res;
}

/** Timed track points from a GPX file: [{t, lat, lon, alt, seg}], sorted by time. */
export function parseGpxTrack(text) {
  const out = [];
  [...text.matchAll(/<trkseg[\s\S]*?<\/trkseg>/gi)].forEach((sm, seg) => {
    for (const m of sm[0].matchAll(/<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi)) {
      const lat = +(m[1].match(/lat\s*=\s*["']([^"']+)/i) || [])[1], lon = +(m[1].match(/lon\s*=\s*["']([^"']+)/i) || [])[1];
      const t = Date.parse((m[2].match(/<time>([^<]+)<\/time>/i) || [])[1]);
      const ele = parseFloat((m[2].match(/<ele>([^<]+)<\/ele>/i) || [])[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Number.isFinite(t)) out.push({ t, lat, lon, alt: Number.isFinite(ele) ? ele : null, seg });
    }
  });
  return out.sort((a, b) => a.t - b.t);
}
