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
export function obsCSV(obs) {
  const rows = [OBS_COLS];
  for (const o of obs) {
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
  return fc('observations', obs.map((o) => ({
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
  if (plan.boundary?.length >= 3) {
    const ring = plan.boundary.map((p) => [f7(p[1]), f7(p[0])]);
    ring.push(ring[0]);
    feats.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { kind: 'boundary', survey: survey.name } });
  }
  if (plan.route?.length >= 2) {
    feats.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: plan.route.map((p) => [f7(p[1]), f7(p[0])]) },
      properties: { kind: 'planned_route', survey: survey.name, spacing_m: plan.spacing ?? null, bearing_deg: plan.bearing ?? null, length_m: Math.round(pathLength(plan.route)) },
    });
  }
  return fc('plan', feats);
}

/** Everything in one GeoJSON file (mixed geometry; QGIS splits it into layers on load). */
export function allGeoJSON(survey, points, obs) {
  const tag = (g, layer) => g.features.map((f) => ({ ...f, properties: { layer, ...f.properties } }));
  return fc(safeName(survey.name), [
    ...tag(planGeoJSON(survey), 'plan'),
    ...tag(trackLineGeoJSON(survey, points), 'track'),
    ...tag(obsGeoJSON(obs), 'observation'),
  ]);
}

export function gpx(survey, points, obs) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="SurveyXYZ" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${xml(survey.name)}</name><time>${iso(survey.created)}</time></metadata>`];
  for (const o of obs) {
    out.push(`<wpt lat="${f7(o.lat)}" lon="${f7(o.lon)}"><time>${iso(o.t)}</time><name>${xml(`${o.num} ${o.category || ''}`.trim())}</name>` +
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
Instrument clock offset recorded in the field: ${survey.clockOffsetS ?? 'not set'} s (add to instrument time to get true time)

track.csv              one row per GPS fix (${points.length} rows). latitude/longitude are the
                       filtered position; raw_latitude/raw_longitude are exactly what the GPS
                       reported. source: gps = fix used, rej = fix distrusted (see reject_reason),
                       dr = dead-reckoned from steps + compass while GPS was absent.
track_line.geojson     the walked path as a line (one part per recording segment)
track_points.geojson   every fix as a point with attributes
observations.geojson   notes / marks / manual readings (${obs.length}); 'photo' is a relative path
observations.csv       same, as a table
plan.geojson           site boundary and planned route
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
  const res = { boundary: null, route: null };
  const visit = (g) => {
    if (!g) return;
    if (g.type === 'FeatureCollection') g.features.forEach((f) => visit(f));
    else if (g.type === 'Feature') visit(g.geometry);
    else if (g.type === 'GeometryCollection') g.geometries.forEach(visit);
    else if (g.type === 'Polygon' && !res.boundary) res.boundary = g.coordinates[0];
    else if (g.type === 'MultiPolygon' && !res.boundary) res.boundary = g.coordinates[0][0];
    else if (g.type === 'LineString' && !res.route) res.route = g.coordinates;
    else if (g.type === 'MultiLineString' && !res.route) res.route = g.coordinates.flat();
  };
  visit(obj);
  const ll = (c) => c && c.map((p) => [p[1], p[0]]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  res.boundary = ll(res.boundary); res.route = ll(res.route);
  return res;
}

function kmlCoords(s) {
  return s.trim().split(/\s+/).map((t) => t.split(',').map(Number)).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[1], p[0]]);
}

/** Parse a plan file. Returns {boundary: [[lat,lon]]|null, route: [[lat,lon]]|null}. */
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
    res = { boundary: null, route: pts };
  } else if (/<kml[\s>]/i.test(t)) {
    const poly = t.match(/<Polygon[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i);
    const line = t.match(/<LineString[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/i);
    res = { boundary: poly ? kmlCoords(poly[1]) : null, route: line ? kmlCoords(line[1]) : null };
  } else throw new Error('Unrecognised file: expected GeoJSON, GPX or KML');
  // Closed rings repeat the first vertex; we store them open.
  const b = res.boundary;
  if (b && b.length > 1 && b[0][0] === b[b.length - 1][0] && b[0][1] === b[b.length - 1][1]) b.pop();
  if (b && b.length < 3) res.boundary = null;
  if (res.route && res.route.length < 2) res.route = null;
  if (!res.boundary && !res.route) throw new Error('No polygon or line found in file');
  return res;
}
