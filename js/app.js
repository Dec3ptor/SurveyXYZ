/* global L */
import * as db from './db.js';
import { FusionFilter } from './fusion.js';
import { Sensors } from './sensors.js';
import { haversine, bearing, angDiff, cardinal, frameFor, RouteFollower, buildPlan, insideRing, longestEdgeBearing, polygonArea, pathLength, Coverage } from './geo.js';
import * as ex from './exporters.js';
import { makeZip } from './zip.js';
import { openMerge } from './mergeui.js';
import { MODES, PATTERNS, hotspotDiameter, DEFAULT_ANALYTES } from './modes.js';
import { openSample, startSample, openPoint, openPointList, openSamplesList } from './sampling.js';

const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- settings ----------
const DEFAULTS = {
  filterMode: 'smart', maxAcc: 25, tol: 3, spacing: 10, sound: true, vibrate: true, showRaw: false,
  base: 'Satellite', arrive: 3, analytes: DEFAULT_ANALYTES, mode: 'ism',
};
export const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('sxyz.settings') || '{}') };
export const mode = () => MODES[S.survey?.mode] || MODES.ism;
export const noteCategories = () => (settings['cats_' + S.survey.mode] ?? mode().categories).split(',').map((c) => c.trim()).filter(Boolean);
export const noteUnit = () => settings['unit_' + S.survey.mode] ?? mode().unit;
const saveSettings = () => localStorage.setItem('sxyz.settings', JSON.stringify(settings));

// ---------- state ----------
export const S = {
  survey: null, points: [], obs: [],
  recording: false, seg: 0, activeMs: 0, dist: 0,
  fix: null, est: null, lastFixWall: 0, lastDrSteps: 0,
  follow: true, planShape: null,
  route: null, // {frame, xy}
  coverage: null, follower: null, target: null, offCount: 0, lastAlert: 0,
};
const filter = new FusionFilter({ mode: settings.filterMode, maxAcc: settings.maxAcc });
const sensors = new Sensors(filter, { onFix, onError: onGpsError, onCompass: () => requestAnimationFrame(turnArrow) });

// ---------- map ----------
const AREA_COLORS = ['#ff9800', '#00e5ff', '#ff4081', '#b2ff59', '#e040fb', '#ffea00'];
const P = { sel: null, draw: false, counts: {} }; // plan editor selection: area id | 'extra' | 'route'
const map = L.map('map', { zoomControl: false, preferCanvas: true, maxZoom: 22, attributionControl: true }).setView([0, 0], 2);
map.attributionControl.setPrefix(false);
const bases = {
  Satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 22, crossOrigin: true, attribution: 'Imagery © Esri' }),
  Map: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 22, crossOrigin: true, attribution: '© OpenStreetMap' }),
};
(bases[settings.base] || bases.Satellite).addTo(map);
L.control.layers(bases, null, { position: 'bottomleft' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
map.on('baselayerchange', (e) => { settings.base = e.name; saveSettings(); });
map.on('dragstart', () => setFollow(false));
// Point labels crowd the map when zoomed out; show only the target's label then.
const zoomClass = () => $('map').classList.toggle('lowzoom', map.getZoom() < 19);
map.on('zoomend', zoomClass); zoomClass();

const layers = {
  plan: L.layerGroup().addTo(map), points: L.layerGroup().addTo(map), covered: L.layerGroup().addTo(map), raw: L.layerGroup().addTo(map),
  track: L.layerGroup().addTo(map), readings: L.layerGroup().addTo(map), obs: L.layerGroup().addTo(map),
  edit: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map),
};
export { map, layers };
const accCircle = L.circle([0, 0], { radius: 1, color: '#1565c0', weight: 1, fillOpacity: 0.12, interactive: false });
const meMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="me"><i hidden></i></div>', iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false, zIndexOffset: 1000 });
const targetLine = L.polyline([], { color: '#ff00c8', weight: 3, dashArray: '4 6', interactive: false });
let trackLine = null, rawLine = null;

// ---------- small UI helpers ----------
let toastTimer;
export function toast(msg, ms = 3000) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
let sheetOnClose = null;
export function openSheet(title, html, onClose) {
  closeSheet();
  $('sheetTitle').textContent = title;
  // A fresh inner element per sheet: handlers a sheet attaches cannot be hit by
  // the tap that opened it, or linger into the next sheet.
  const inner = document.createElement('div');
  inner.innerHTML = html;
  $('sheetBody').replaceChildren(inner);
  $('sheetBody').scrollTop = 0;
  $('sheet').hidden = false;
  sheetOnClose = onClose || null;
  return inner;
}
export function closeSheet() {
  if ($('sheet').hidden) return;
  $('sheet').hidden = true;
  const f = sheetOnClose; sheetOnClose = null;
  if (f) f();
}
$('sheetClose').onclick = closeSheet;

/** Ask the user for a file; resolves with File or null. */
export function pickFile(accept, capture) {
  return new Promise((resolve) => {
    const inp = $('fileInput');
    inp.value = '';
    inp.accept = accept || '';
    if (capture) inp.setAttribute('capture', capture); else inp.removeAttribute('capture');
    inp.onchange = () => resolve(inp.files[0] || null);
    inp.click();
  });
}

/** Share sheet on phones (lets you send to Files, email, Drive…), plain download elsewhere. */
export async function deliver(blob, filename) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function beep() {
  try {
    beep.ctx = beep.ctx || new (window.AudioContext || window.webkitAudioContext)();
    const o = beep.ctx.createOscillator(), g = beep.ctx.createGain();
    o.frequency.value = 880; g.gain.value = 0.25;
    o.connect(g); g.connect(beep.ctx.destination);
    o.start(); o.stop(beep.ctx.currentTime + 0.18);
  } catch { /* no audio */ }
}
export const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m');
const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000), p = (n) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
};

// ---------- surveys ----------
async function newSurvey(name, copyPlanFrom, modeKey = settings.mode) {
  const survey = {
    id: db.uid(), name: name || 'Survey ' + ex.localStamp(Date.now()).slice(0, 16), created: Date.now(), clockOffsetS: null, obsCount: 0, mode: MODES[modeKey] ? modeKey : 'ism',
    progress: 0,
    plan: copyPlanFrom ? JSON.parse(JSON.stringify(copyPlanFrom.plan)) : { areas: [], route: [], points: [] },
  };
  // A copied plan starts fresh: nothing sampled yet.
  for (const pt of survey.plan.points || []) { pt.status = 'todo'; delete pt.why; if (pt.plat != null) { pt.lat = pt.plat; pt.lon = pt.plon; } }
  survey.plan.target = null;
  await db.put('surveys', survey);
  return survey;
}
export const saveSurvey = () => db.put('surveys', S.survey);

/** Older surveys had one boundary; plans are now a list of areas. Existing points and routes are left untouched. */
function migratePlan(plan) {
  plan.points ||= []; plan.route ||= [];
  if (!plan.areas) {
    plan.areas = [];
    if (plan.boundary?.length >= 3) plan.areas.push({ id: db.uid(), name: 'Site', ring: plan.boundary, fill: 'none', pattern: plan.pattern || 'square', spacing: plan.spacing || settings.spacing, bearing: plan.bearing ?? null, count: 10, seed: 1, color: AREA_COLORS[0] });
  }
  delete plan.boundary;
}
async function loadSurvey(id) {
  if (S.recording) await stopRecording();
  let survey = id && (await db.get('surveys', id));
  if (!survey) {
    const list = await db.all('surveys');
    survey = list.sort((a, b) => b.created - a.created)[0] || (await newSurvey());
  }
  survey.mode ||= 'ism';
  migratePlan(survey.plan);
  S.survey = survey;
  localStorage.setItem('sxyz.current', survey.id);
  S.points = (await db.bySurvey('points', survey.id)).sort((a, b) => a.t - b.t);
  S.obs = (await db.bySurvey('obs', survey.id)).sort((a, b) => a.num - b.num);
  S.seg = S.points.reduce((m, p) => Math.max(m, p.seg), 0);
  S.activeMs = 0; S.dist = 0;
  for (let i = 1; i < S.points.length; i++) addStats(S.points[i - 1], S.points[i]);
  $('surveyName').textContent = survey.name;
  $('bMark').lastElementChild.textContent = mode().action === 'sample' ? 'Sample' : 'Mark';
  layers.readings.clearLayers();
  drawPlan(); rebuildRoute(true); drawTrack(); drawObs(); updateRecChip();
  const pts = [...survey.plan.areas.flatMap((a) => a.ring), ...(survey.plan.route || []), ...survey.plan.points.map((p) => [p.lat, p.lon]), ...S.points.slice(-200).map((p) => [p.lat, p.lon])];
  if (pts.length > 1) { setFollow(false); map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 19 }); }
}
function addStats(a, b) {
  if (a.seg !== b.seg) return;
  S.activeMs += b.t - a.t;
  S.dist += haversine(a.lat, a.lon, b.lat, b.lon);
}

// ---------- drawing ----------
export function drawPlan() {
  drawPoints();
  layers.plan.clearLayers();
  const { areas, route } = S.survey.plan;
  for (const a of areas) {
    if (a.ring.length < 2) continue;
    const sel = S.planShape && a.id === P.sel, empty = a.fill === 'none';
    const shape = a.ring.length === 2 ? L.polyline(a.ring, { color: a.color, weight: 4, interactive: false })
      : L.polygon(a.ring, { color: a.color, weight: sel ? 5 : 3, dashArray: empty ? '6 6' : null, fillColor: empty ? '#000' : a.color, fillOpacity: empty ? 0.25 : sel ? 0.18 : 0.06, interactive: false });
    shape.addTo(layers.plan);
    if (S.planShape && a.ring.length >= 3) shape.bindTooltip(esc(a.name), { permanent: true, direction: 'center', className: 'area-label' });
  }
  if (route?.length >= 2) {
    L.polyline(route, { color: '#fff', weight: 6, opacity: 0.7, interactive: false }).addTo(layers.plan);
    L.polyline(route, { color: '#1565c0', weight: 3, dashArray: '8 7', interactive: false }).addTo(layers.plan);
    L.circleMarker(route[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#1a8f3c', fillOpacity: 1, interactive: false }).addTo(layers.plan);
    L.circleMarker(route[route.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#c62828', fillOpacity: 1, interactive: false }).addTo(layers.plan);
  }
}
/** The sampling point guidance is heading for: the chosen one, else the first not yet done. */
export function currentTarget() {
  const pts = S.survey.plan.points;
  return pts.find((p) => p.id === S.survey.plan.target && p.status === 'todo') || pts.find((p) => p.status === 'todo') || null;
}
function drawPoints() {
  layers.points.clearLayers();
  const tgt = currentTarget();
  drawPoints.target = tgt?.id;
  for (const pt of S.survey.plan.points) {
    const icon = L.divIcon({ className: '', html: `<div class="spt ${pt.status}${tgt === pt ? ' tgt' : ''}"><span>${esc(pt.id)}</span></div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
    // In the plan editor points must not swallow taps meant for the map or the edit handles.
    L.marker([pt.lat, pt.lon], { icon, interactive: !S.planShape }).on('click', () => openPoint(pt)).addTo(layers.points);
  }
}
function rebuildRoute(replay) {
  const route = S.survey.plan.route || [];
  S.follower = null; S.target = null; targetLine.remove();
  if (route.length < 2) { S.route = null; S.coverage = null; layers.covered.clearLayers(); $('guide').hidden = true; return; }
  const frame = frameFor(route);
  S.route = { frame, xy: route.map((p) => frame.toXY(p[0], p[1])) };
  S.follower = new RouteFollower(S.route.xy, S.survey.progress);
  S.coverage = new Coverage(route, 2);
  if (replay) for (const p of S.points) S.coverage.mark(p.lat, p.lon, settings.tol);
  drawCovered();
}
function drawCovered() {
  layers.covered.clearLayers();
  if (!S.coverage) return;
  for (const run of S.coverage.runs()) L.polyline(run, { color: '#2ee66b', weight: 7, opacity: 0.85, interactive: false }).addTo(layers.covered);
}
function drawTrack() {
  layers.track.clearLayers(); layers.raw.clearLayers();
  trackLine = rawLine = null;
  let seg = null;
  for (const p of S.points) {
    if (p.seg !== seg) { seg = p.seg; startTrackLine(); }
    trackLine.addLatLng([p.lat, p.lon]);
    if (rawLine && p.src !== 'dr' && Number.isFinite(p.rlat)) rawLine.addLatLng([p.rlat, p.rlon]);
  }
}
function startTrackLine() {
  trackLine = L.polyline([], { color: '#ff3d00', weight: 3, interactive: false }).addTo(layers.track);
  rawLine = settings.showRaw ? L.polyline([], { color: '#ffffff', weight: 1.5, opacity: 0.8, dashArray: '2 5', interactive: false }).addTo(layers.raw) : null;
}
export function drawObs() {
  layers.obs.clearLayers();
  for (const o of S.obs) {
    if (o.kind === 'sample') continue; // shown by its sampling point
    const icon = L.divIcon({ className: '', html: `<div class="pin${o.photoIds?.length ? ' photo' : ''}">${o.num}</div>`, iconSize: [28, 28], iconAnchor: [2, 28] });
    L.marker([o.lat, o.lon], { icon }).on('click', () => openNote(o)).addTo(layers.obs);
  }
}

// ---------- GPS handling ----------
function onGpsError(err) {
  const chip = $('gpsChip');
  chip.className = 'chip bad';
  chip.textContent = err.code === 1 ? 'Location blocked' : 'No GPS';
  if (err.code === 1) toast('Location permission is blocked. Allow location for this site in your browser settings.', 8000);
}

function onFix(fix, est, info) {
  S.fix = fix; S.est = est; S.lastFixWall = Date.now(); S.lastDrSteps = filter.stepsTotal;
  const chip = $('gpsChip');
  const acc = fix.acc;
  chip.className = 'chip ' + (acc <= 6 ? 'good' : acc <= settings.maxAcc ? 'warn' : 'bad');
  chip.textContent = `±${acc < 10 ? acc.toFixed(1) : Math.round(acc)} m` + (est.why === 'jump' ? ' · jump ignored' : est.why === 'accuracy' ? ' · too poor' : '');
  const mc = $('motionChip');
  mc.hidden = !(info.hasMotion && settings.filterMode === 'smart');
  mc.textContent = est.moving ? 'Moving' : 'Still · averaging';
  showPosition(est.lat, est.lon, Math.max(est.sigma || 0, est.used ? 0 : acc), !est.used && !filter.ready);
  const xte = guide(est);
  if (S.recording) logPoint({
    t: fix.t, lat: est.lat, lon: est.lon, rlat: fix.lat, rlon: fix.lon, acc, alt: fix.alt, spd: fix.speed, crs: fix.heading,
    cmp: info.compass, mov: est.moving ? 1 : 0, src: est.used ? 'gps' : 'rej', why: est.why, xte,
  });
}

function showPosition(lat, lon, radius, dim) {
  const ll = [lat, lon];
  if (!layers.me.hasLayer(meMarker)) { accCircle.addTo(layers.me); meMarker.addTo(layers.me); if (S.follow) map.setView(ll, Math.max(map.getZoom(), 18)); }
  meMarker.setLatLng(ll); accCircle.setLatLng(ll); accCircle.setRadius(Math.max(1, radius));
  const el = meMarker.getElement()?.firstChild;
  if (el) {
    el.classList.toggle('dim', !!dim);
    const h = filter.travelHeading, arrow = el.firstChild;
    arrow.hidden = h == null;
    if (h != null) arrow.style.transform = `rotate(${h}deg)`;
  }
  if (S.follow) map.panTo(ll, { animate: true, duration: 0.5 });
}

function logPoint(p) {
  p.surveyId = S.survey.id; p.seg = S.seg;
  const prev = S.points[S.points.length - 1];
  S.points.push(p);
  db.put('points', p).catch((e) => toast('Could not save point: ' + e.message, 6000));
  if (prev) addStats(prev, p);
  if (!trackLine) startTrackLine();
  trackLine.addLatLng([p.lat, p.lon]);
  if (rawLine && p.src !== 'dr') rawLine.addLatLng([p.rlat, p.rlon]);
  if (S.coverage && S.coverage.mark(p.lat, p.lon, settings.tol)) {
    const now = Date.now();
    if (now - (drawCovered.last || 0) > 3000) { drawCovered.last = now; drawCovered(); }
  }
}

// Dead-reckoned points while GPS is silent but steps are being counted.
setInterval(() => {
  if (!filter.ready || settings.filterMode !== 'smart') return;
  if (Date.now() - S.lastFixWall < 4000 || filter.stepsTotal === S.lastDrSteps) return;
  S.lastDrSteps = filter.stepsTotal;
  const pos = filter.position;
  showPosition(pos.lat, pos.lon, pos.sigma, false);
  $('gpsChip').className = 'chip bad';
  $('gpsChip').textContent = 'No GPS · dead reckoning';
  const xte = guide({ ...pos, moving: true, used: true });
  if (S.recording) logPoint({ t: Date.now(), lat: pos.lat, lon: pos.lon, rlat: null, rlon: null, acc: pos.sigma, alt: null, spd: null, crs: null, cmp: sensors.compass, mov: 1, src: 'dr', why: '', xte });
}, 2000);

// ---------- guidance ----------
// The route is followed in order from start to finish. The dial arrow points
// at a spot a few metres further along the route from where you have got to
// (or straight at the rejoin point when you are well off it), turned by the
// compass so it points the right way in the real world.
function guideKind() {
  const hasR = !!S.follower, hasP = S.survey.plan.points.length > 0;
  return mode().guide === 'points' ? (hasP ? 'points' : hasR ? 'route' : null) : hasR ? 'route' : hasP ? 'points' : null;
}
export function refreshGuide() {
  if (S.est) guide(S.est); else if (!guideKind()) $('guide').hidden = true;
}
/** Navigate to the next sampling point: arrow + distance to it. */
function guidePoints(est) {
  const g = $('guide'), pts = S.survey.plan.points, t = currentTarget();
  const done = pts.filter((p) => p.status !== 'todo').length;
  g.hidden = false;
  $('guideBar').hidden = true;
  if (drawPoints.target !== t?.id) drawPoints();
  if (!t) {
    S.target = null; targetLine.remove(); g.className = '';
    $('guideText').textContent = 'All points visited'; $('dialDist').textContent = '✓'; $('dialLabel').textContent = '';
    $('guideSub').textContent = `${done} of ${pts.length} locations · tap for the list`;
    turnArrow();
    return null;
  }
  const d = haversine(est.lat, est.lon, t.lat, t.lon), b = bearing(est.lat, est.lon, t.lat, t.lon);
  const here = d <= settings.arrive;
  S.target = { bearing: b };
  targetLine.setLatLngs([[est.lat, est.lon], [t.lat, t.lon]]).addTo(layers.me);
  g.className = here ? '' : 'far';
  $('guideText').textContent = here ? `At ${t.id}` : `Go to ${t.id}`;
  $('dialDist').textContent = d < 20 ? d.toFixed(1) + ' m' : fmtDist(d);
  $('dialLabel').textContent = 'to ' + t.id;
  $('guideSub').textContent = `${here ? 'You are here — tap Sample' : `${cardinal(b)} (${Math.round(b)}°)`} · GPS ±${Math.round(S.fix?.acc ?? est.sigma ?? 0)} m · ${done} of ${pts.length} done`;
  if (here && guidePoints.arrived !== t.id) {
    guidePoints.arrived = t.id;
    if (settings.vibrate && navigator.vibrate) navigator.vibrate(300);
    if (settings.sound) beep();
  }
  turnArrow();
  return null;
}

function guide(est) {
  const g = $('guide'), f = S.follower;
  const kind = S.planShape ? null : guideKind();
  if (!kind) { g.hidden = true; targetLine.remove(); return null; }
  if (kind === 'points') return guidePoints(est);
  $('guideBar').hidden = false;
  const p = S.route.frame.toXY(est.lat, est.lon);
  const tol = settings.tol;
  const atStart = f.s < 0.5;
  const n = f.update(p, S.recording, Math.max(5, 2 * tol));
  if (!n) { g.hidden = true; return null; }
  g.hidden = false;
  const pct = S.coverage ? Math.round(S.coverage.fraction * 100) : 0;
  const leg = `Leg ${n.idx + 1}/${n.legs}`;
  const done = f.total - n.s < 1.5 && n.dist <= 2 * tol;
  const far = n.dist > Math.max(15, 4 * tol);
  // Where to head: ahead along the route when near it, the rejoin point when far.
  const tp = f.pointAt(far ? f.s : n.s + Math.max(6, 2 * tol));
  const [tla, tlo] = S.route.frame.toLL(tp.x, tp.y);
  S.target = done ? null : { bearing: bearing(est.lat, est.lon, tla, tlo) };
  if (done) targetLine.remove(); else targetLine.setLatLngs([[est.lat, est.lon], [tla, tlo]]).addTo(layers.me);

  const a = Math.abs(n.xte), off = n.dist > tol;
  let cls = '', text, dist, label, sub;
  if (done) { text = 'Route finished'; dist = '✓'; label = ''; sub = `${pct}% walked`; }
  else if (far) {
    cls = 'far'; dist = fmtDist(n.dist); label = atStart ? 'to start' : 'to path';
    text = atStart ? 'Go to start' : 'Return to path';
    sub = `${atStart ? 'Start' : 'Where you left off'} is ${cardinal(S.target.bearing)} (${Math.round(S.target.bearing)}°) · ${pct}% walked`;
  } else if (off) {
    cls = n.dist <= 2 * tol ? 'warn' : 'bad';
    dist = n.dist.toFixed(1) + ' m'; label = 'to path';
    text = n.xte > 0 ? `← ${a.toFixed(1)} m left` : `${a.toFixed(1)} m right →`;
    sub = `${leg} · ${fmtDist(n.toTurn)} to turn · ${pct}% walked`;
  } else {
    const last = n.idx === n.legs - 1;
    dist = fmtDist(n.toTurn); label = last ? 'to finish' : 'to turn';
    text = a <= tol * 0.35 ? 'On path' : n.xte > 0 ? `On path · ${a.toFixed(1)} m R` : `On path · ${a.toFixed(1)} m L`;
    sub = `${leg} · ${fmtDist(f.total - n.s)} left · ${pct}% walked`;
  }
  if (!S.recording && !done) sub += ' · press Record to start following';
  g.className = cls;
  $('guideText').textContent = text;
  $('dialDist').textContent = dist;
  $('dialLabel').textContent = label;
  $('guideSub').textContent = sub;
  $('guideDot').style.left = 50 + Math.max(-48, Math.min(48, (n.xte / (3 * tol)) * 50)) + '%';
  $('guideBar').style.visibility = far || done ? 'hidden' : '';
  turnArrow();

  if (S.recording && est.moving && off && !done) {
    if (++S.offCount >= 3 && Date.now() - S.lastAlert > 8000) {
      S.lastAlert = Date.now();
      if (settings.vibrate && navigator.vibrate) navigator.vibrate([200, 100, 200]);
      if (settings.sound) beep();
    }
  } else S.offCount = 0;
  if (S.recording && Math.abs((S.survey.progress || 0) - f.s) > 20) { S.survey.progress = f.s; saveSurvey(); }
  return n.xte;
}

/** Rotate the dial arrow. Runs on every compass event so it stays live as you turn. */
let arrowNote = '';
function turnArrow() {
  const el = $('dialArrow');
  if (!S.target) { el.hidden = true; return; }
  el.hidden = false;
  let h = sensors.screenHeading, note = '';
  if (h == null) {
    h = filter.travelHeading;
    note = h == null ? 'No compass: arrow is north-up' : 'No compass: arrow is relative to your walking direction';
    if (h == null) h = 0;
  }
  // Keep the rotation continuous so the CSS transition takes the short way round.
  const want = S.target.bearing - h;
  turnArrow.rot = (turnArrow.rot ?? want) + angDiff(want, turnArrow.rot ?? want);
  el.style.transform = `rotate(${turnArrow.rot}deg)`;
  if (note !== arrowNote) { arrowNote = note; $('dial').title = note; }
  $('dial').style.borderStyle = note ? 'dashed' : 'solid';
}

$('guide').onclick = () => {
  if (guideKind() === 'points') return openPointList();
  const f = S.follower;
  if (!f) return;
  const b = openSheet('Path guidance', `
    <p>The route is followed in order from the green start dot to the red finish dot. You are ${fmtDist(f.s)} along a ${fmtDist(f.total)} route.</p>
    <p class="muted">The arrow shows which way to face and walk; the number in it is the distance to the path when you are off it, or to the next turn when you are on it. A dashed dial means the compass is not available${arrowNote ? ` (${arrowNote.toLowerCase()})` : ''}. If the arrow seems wrong, wave the phone in a figure-of-eight to recalibrate the compass and keep it away from metal.</p>
    <div class="list">
      <button class="btn primary" data-a="near">Continue from the nearest point<small>Use after skipping a section or walking round an obstacle</small></button>
      <button class="btn" data-a="start">Restart from the beginning</button>
      <button class="btn" data-a="reverse">Reverse the route<small>Walk it from the other end</small></button>
    </div>`);
  b.querySelector('.list').onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (!a) return;
    if (a === 'near') {
      if (!S.est) return toast('No GPS fix yet.');
      f.resync(S.route.frame.toXY(S.est.lat, S.est.lon));
    }
    if (a === 'start') f.s = 0;
    if (a === 'reverse') {
      S.survey.plan.route.reverse();
      S.survey.progress = 0;
      drawPlan(); rebuildRoute(true);
    } else S.survey.progress = f.s;
    saveSurvey(); closeSheet();
    if (S.est) guide(S.est);
    toast(a === 'near' ? `Continuing from ${fmtDist(S.follower.s)} along the route.` : a === 'start' ? 'Back to the start of the route.' : 'Route reversed.');
  };
};

// ---------- recording ----------
async function startRecording() {
  if (S.planShape) exitPlan();
  S.recording = true;
  S.seg++;
  trackLine = rawLine = null;
  $('bRec').classList.add('on');
  $('bRec').lastElementChild.textContent = 'Stop';
  setFollow(true);
  const motion = await sensors.startMotion();
  sensors.startGps();
  const awake = await sensors.keepAwake(true);
  if (navigator.storage?.persist) navigator.storage.persist();
  toast(`Recording. ${awake ? 'Screen will stay on' : 'Keep the screen on'} — GPS stops if the phone locks or you switch apps.` + (motion ? '' : ' Motion sensors unavailable: using GPS-only smoothing.'), 6000);
  updateRecChip();
}
async function stopRecording() {
  S.recording = false;
  $('bRec').classList.remove('on');
  $('bRec').lastElementChild.textContent = 'Record';
  sensors.keepAwake(false);
  if (S.follower) { S.survey.progress = S.follower.s; saveSurvey(); }
  drawCovered(); updateRecChip();
}
$('bRec').onclick = () => {
  if (!S.recording) startRecording();
  else if (confirm('Stop recording? You can press Record again to continue this survey.')) { stopRecording(); toast(`Stopped. ${S.points.length} fixes saved on this device.`); }
};
function updateRecChip() {
  const c = $('recChip');
  c.hidden = !S.recording && !S.points.length;
  c.className = 'chip' + (S.recording ? ' rec' : '');
  c.textContent = `${S.recording ? '● ' : ''}${fmtDur(S.activeMs)} · ${fmtDist(S.dist)}`;
}
setInterval(updateRecChip, 1000);
window.addEventListener('beforeunload', (e) => { if (S.recording) { e.preventDefault(); e.returnValue = ''; } });

function setFollow(on) {
  S.follow = on;
  $('followBtn').classList.toggle('on', on);
}
$('followBtn').onclick = () => {
  setFollow(true);
  sensors.startGps();
  if (S.est) map.setView([S.est.lat, S.est.lon], Math.max(map.getZoom(), 18));
  else toast('Waiting for a GPS fix…');
};

// ---------- plan editing ----------
// A plan is a list of areas. Each area has its own fill (sampling points,
// walk transects, or empty) and density; points and transects are rebuilt
// automatically whenever an area changes. A smaller area inside a larger one
// takes over its ground, so focus areas and exclusion zones just work.
// Targeted points and a free-drawn route sit alongside the areas.
let planBefore = '';
const defaultFill = () => (mode().guide === 'points' ? 'points' : mode().guide === 'route' ? 'route' : 'none');
const selArea = () => S.survey.plan.areas.find((a) => a.id === P.sel);
const manualPoints = () => S.survey.plan.points.filter((p) => !p.auto && p.status === 'todo');
const fmtArea = (m2) => (m2 >= 10000 ? (m2 / 10000).toFixed(2) + ' ha' : Math.round(m2) + ' m²');

export function nextPointId(prefix) {
  const pre = prefix ?? 'T';
  const re = new RegExp('^' + pre.replace(/[^\w]/g, '\\$&') + '(\\d+)$');
  const n = S.survey.plan.points.reduce((m, p) => Math.max(m, +(p.id.match(re) || [])[1] || 0), 0) + 1;
  return pre + String(n).padStart(2, '0');
}
/** Add a hand-placed point (targeted, step-out, imported). These are never touched by regeneration. */
export function addPoint(lat, lon, kind, id) {
  const taken = new Set(S.survey.plan.points.map((p) => p.id));
  const pt = { id: id && !taken.has(id) ? id : nextPointId(), lat, lon, kind, status: 'todo' };
  S.survey.plan.points.push(pt);
  return pt;
}

function newArea(props = {}) {
  const areas = S.survey.plan.areas, n = areas.length;
  const base = areas[0]?.spacing || settings.spacing;
  const a = {
    id: db.uid(), name: n ? `Focus area ${n}` : 'Site', ring: [], fill: defaultFill(), pattern: 'square',
    spacing: n ? Math.max(1, Math.round(base / 2)) : base, bearing: null, count: 10, randomStart: false, seed: 1 + Math.floor(Math.random() * 1e6),
    color: AREA_COLORS[n % AREA_COLORS.length],
  };
  for (const [k, v] of Object.entries(props)) if (v != null) a[k] = v;
  areas.push(a);
  return a;
}

/** Rebuild automatic points and transects from the areas. Sampled points and hand-placed points are kept. */
function regenerate() {
  const plan = S.survey.plan;
  const built = buildPlan(plan.areas);
  if (built.points.length > 3000) { toast(`That would be ${built.points.length} points — use a wider spacing.`, 5000); return false; }
  const sampled = new Set(ex.samplesOnly(S.obs).map((o) => o.pointId));
  const keep = plan.points.filter((p) => !p.auto || p.status !== 'todo' || sampled.has(p.id));
  const keptAuto = keep.filter((p) => p.auto);
  const fresh = built.points.filter((n) => !keptAuto.some((k) => haversine(k.plat ?? k.lat, k.plon ?? k.lon, n.lat, n.lon) < 1));
  const used = new Set(keep.map((p) => p.id)), pre = plan.prefix || 'S', width = fresh.length > 99 ? 3 : 2;
  let n = 0;
  for (const p of fresh) {
    let id;
    do id = pre + String(++n).padStart(width, '0'); while (used.has(id));
    Object.assign(p, { id, auto: true, status: 'todo' });
  }
  plan.points = [...keptAuto, ...fresh, ...keep.filter((p) => !p.auto)];
  if (built.route.length >= 2 || plan.routeAuto) { plan.route = built.route; plan.routeAuto = built.route.length >= 2; }
  P.counts = built.counts;
  return true;
}

function enterPlan() {
  if (S.recording) { toast('Stop recording before editing the plan.'); return; }
  closeSheet();
  const plan = S.survey.plan;
  planBefore = JSON.stringify(plan.route);
  S.planShape = 'plan';
  $('planbar').hidden = false; $('guide').hidden = true; $('crosshair').hidden = false;
  $('bPlan').classList.add('on');
  targetLine.remove();
  P.draw = false; P.counts = buildPlan(plan.areas).counts;
  if (!plan.areas.length && !plan.points.length && !plan.route.length) { P.sel = newArea().id; P.draw = true; }
  else P.sel = plan.areas[0]?.id ?? (plan.points.length ? 'extra' : 'route');
  renderPlan();
}
function exitPlan() {
  const plan = S.survey.plan;
  plan.areas = plan.areas.filter((a) => a.ring.length >= 3);
  regenerate();
  S.planShape = null;
  $('planbar').hidden = true; $('crosshair').hidden = true;
  $('bPlan').classList.remove('on');
  layers.edit.clearLayers();
  if (JSON.stringify(plan.route) !== planBefore) S.survey.progress = 0;
  saveSurvey(); drawPlan(); rebuildRoute(true);
  refreshGuide();
}

/** Full redraw of the plan editor: chips, the panel for the selected item, and the map. */
function renderPlan() {
  const plan = S.survey.plan;
  const a = selArea();
  if (!a && P.sel !== 'extra' && P.sel !== 'route') P.sel = 'extra';
  const showRoute = !plan.routeAuto && (mode().guide !== 'points' || plan.route.length > 0);
  if (P.sel === 'route' && !showRoute) P.sel = 'extra';
  const nExtra = plan.points.filter((p) => !p.auto).length;
  $('planChips').innerHTML = plan.areas.map((x) => `<button data-s="${x.id}" class="${x.id === P.sel ? 'on' : ''}"><i style="background:${x.color}"></i>${esc(x.name)}</button>`).join('')
    + '<button data-s="+" class="add">+ Area</button>'
    + `<button data-s="extra" class="${P.sel === 'extra' ? 'on' : ''}">Targeted points${nExtra ? ` (${nExtra})` : ''}</button>`
    + (showRoute ? `<button data-s="route" class="${P.sel === 'route' ? 'on' : ''}">Free route</button>` : '');
  $('planChips').querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });

  const panel = $('planPanel');
  const tools = (extra = '') => `<div class="row wrap"><button data-a="here">+ Here</button><button data-a="undo">Undo</button>${extra}</div>`;
  if (a && P.draw) {
    panel.innerHTML = `<div class="hint">Tap round the edge of <b>${esc(a.name)}</b>, or walk it pressing “+ Here”. Drag a corner to move it; tap a <b>+</b> to add one in between.</div>
      ${tools('<button data-a="finish" class="primary">Finish shape</button><button data-a="delete" class="danger">Delete</button>')}`;
  } else if (a) {
    const pts = a.fill === 'points', random = pts && a.pattern === 'random';
    panel.innerHTML = `
      <div class="row wrap">
        <div class="seg" id="aFill">${[['points', 'Points'], ['route', 'Transects'], ['none', 'Empty']].map(([v, t]) => `<button data-v="${v}" class="${a.fill === v ? 'on' : ''}">${t}</button>`).join('')}</div>
        <span class="row links"><button data-a="shape">Edit shape</button><button data-a="rename">Rename</button><button data-a="delete" class="danger">Delete</button></span>
      </div>
      ${a.fill === 'none' ? '' : `<div class="row wrap">
        ${pts ? `<select id="aPattern" aria-label="Pattern">${Object.entries(PATTERNS).map(([k, v]) => `<option value="${k}" ${k === a.pattern ? 'selected' : ''}>${v}</option>`).join('')}</select>` : ''}
        ${random ? `<label>Points <input id="aCount" type="number" inputmode="numeric" min="1" step="1" value="${a.count}"></label><button data-a="shuffle">Reshuffle</button>`
    : `<label>Spacing <input id="aSpacing" type="number" inputmode="decimal" min="0.5" step="0.5" value="${a.spacing}"> m</label>
           <label>Bearing <input id="aBearing" type="number" inputmode="numeric" min="0" max="359" step="1" placeholder="auto" value="${a.bearing ?? ''}">°</label>`}
        ${pts && !random ? `<label class="check"><input id="aRandom" type="checkbox" ${a.randomStart ? 'checked' : ''}> Random start</label>` : ''}
      </div>`}
      <div class="hint" id="aInfo"></div>`;
  } else if (P.sel === 'extra') {
    panel.innerHTML = `<div class="hint">Tap the map to add a point at a known or suspected source (tank, drain, stained ground). Drag a point to move it. These are kept whatever you do to the areas.</div>${tools()}`;
  } else {
    panel.innerHTML = `<div class="hint">Tap the map to add route points in walking order. Drag points to adjust.</div>${tools('<button data-a="clear" class="danger">Clear</button>')}`;
  }
  refreshPlanMap();
}

/** Redraw the map side of the plan editor and the summary lines, leaving the panel's inputs alone. */
function refreshPlanMap() {
  const plan = S.survey.plan, a = selArea();
  drawPlan();
  layers.edit.clearLayers();
  const handle = (ll, cls, onDrag, onEnd) => {
    const m = L.marker(ll, { draggable: true, zIndexOffset: 3000, icon: L.divIcon({ className: '', html: `<div class="vtx ${cls}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) });
    m.on('drag', () => { const p = m.getLatLng(); onDrag(p.lat, p.lng); });
    m.on('dragend', () => { saveSurvey(); onEnd(); });
    m.addTo(layers.edit);
  };
  if (a && P.draw) {
    a.ring.forEach((p, i) => handle(p, 'area', (lat, lon) => { a.ring[i] = [lat, lon]; drawPlan(); }, refreshPlanMap));
    const n = a.ring.length;
    for (let i = 0; i < (n >= 3 ? n : n - 1); i++) {
      const p = a.ring[i], q = a.ring[(i + 1) % n];
      L.marker([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], { zIndexOffset: 2500, icon: L.divIcon({ className: '', html: '<div class="mid">+</div>', iconSize: [20, 20], iconAnchor: [10, 10] }) })
        .on('click', (e) => { L.DomEvent.stop(e); a.ring.splice(i + 1, 0, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]); saveSurvey(); refreshPlanMap(); })
        .addTo(layers.edit);
    }
  } else if (P.sel === 'extra') {
    for (const pt of manualPoints()) handle([pt.lat, pt.lon], 'points', (lat, lon) => { pt.lat = lat; pt.lon = lon; }, refreshPlanMap);
  } else if (P.sel === 'route' && plan.route.length <= 400) {
    plan.route.forEach((p, i) => handle(p, 'route', (lat, lon) => { plan.route[i] = [lat, lon]; drawPlan(); }, refreshPlanMap));
  }

  const info = $('aInfo');
  if (info && a) {
    const size = polygonArea(a.ring), n = P.counts[a.id] ?? 0;
    info.textContent = a.fill === 'none' ? `${fmtArea(size)} · left empty: no points are placed inside this area, including those of any larger area around it.`
      : a.fill === 'route' ? `${fmtArea(size)} · ${n} transects ${a.spacing} m apart`
        : a.pattern === 'random' ? `${fmtArea(size)} · ${n} random points`
          : `${fmtArea(size)} · ${n} points · about one per ${fmtArea(a.spacing * a.spacing)} · finds circular hotspots ≥ ${hotspotDiameter(a.spacing).toFixed(1)} m across (95%)`;
  }
  const auto = plan.points.filter((p) => p.auto).length, extra = plan.points.length - auto;
  const bits = [];
  if (plan.points.length) bits.push(`${plan.points.length} sampling points` + (extra && auto ? ` (${auto} from areas, ${extra} targeted)` : ''));
  if (plan.route.length >= 2) { const len = pathLength(plan.route); bits.push(`route ${fmtDist(len)}, about ${Math.max(1, Math.round(len / 60))} min at 1 m/s`); }
  $('planInfo').textContent = bits.length ? 'Plan total: ' + bits.join(' · ') : '';
}

/** An area setting changed: rebuild, save and refresh without disturbing the input being typed in. */
function areaChanged(full) {
  regenerate(); saveSurvey();
  if (full) renderPlan(); else refreshPlanMap();
}

map.on('click', (e) => {
  if (!S.planShape) return;
  const plan = S.survey.plan, { lat, lng } = e.latlng, a = selArea();
  if (P.sel === 'extra') addPoint(lat, lng, 'targeted');
  else if (P.sel === 'route') plan.route.push([lat, lng]);
  else if (a && P.draw) a.ring.push([lat, lng]);
  else {
    // Tapping inside an area selects it (the innermost one where they overlap).
    const hit = plan.areas.filter((x) => insideRing(x.ring, lat, lng)).sort((x, y) => polygonArea(x.ring) - polygonArea(y.ring))[0];
    if (hit && hit.id !== P.sel) { P.sel = hit.id; renderPlan(); }
    return;
  }
  saveSurvey();
  if (P.sel === 'extra') renderPlan(); else refreshPlanMap();
});
$('bPlan').onclick = () => (S.planShape ? exitPlan() : enterPlan());
$('planDone').onclick = exitPlan;

$('planChips').onclick = (e) => {
  const s = e.target.closest('button')?.dataset.s;
  if (!s) return;
  const cur = selArea();
  if (cur && P.draw) {
    if (cur.ring.length < 3) S.survey.plan.areas = S.survey.plan.areas.filter((x) => x !== cur); // abandon an unfinished shape
    regenerate();
  }
  P.draw = s === '+';
  P.sel = s === '+' ? newArea().id : s;
  saveSurvey(); renderPlan();
};

$('planPanel').onclick = (e) => {
  const plan = S.survey.plan, a = selArea();
  const fill = e.target.closest('#aFill button')?.dataset.v;
  if (fill && a) { a.fill = fill; return areaChanged(true); }
  const act = e.target.closest('button')?.dataset.a;
  if (!act) return;
  const list = a ? a.ring : P.sel === 'route' ? plan.route : null;
  if (act === 'here') {
    if (!S.est) return toast('No GPS fix yet.');
    if (S.fix.acc > settings.maxAcc) return toast(`GPS too poor right now (±${Math.round(S.fix.acc)} m).`);
    if (list) list.push([S.est.lat, S.est.lon]); else addPoint(S.est.lat, S.est.lon, 'targeted');
  }
  if (act === 'undo') {
    if (list) list.pop();
    else { const last = manualPoints().pop(); if (last) plan.points = plan.points.filter((p) => p !== last); }
  }
  if (act === 'clear') { if (!plan.route.length || !confirm('Clear the route?')) return; plan.route = []; }
  if (act === 'finish') {
    if (a.ring.length < 3) return toast('An area needs at least 3 corners.');
    P.draw = false;
    return areaChanged(true);
  }
  if (act === 'shape') { P.draw = true; return renderPlan(); }
  if (act === 'rename') {
    const name = prompt('Area name', a.name);
    if (!name?.trim()) return;
    a.name = name.trim();
  }
  if (act === 'delete') {
    if (a.ring.length >= 3 && !confirm(`Delete “${a.name}” and the points or transects it generates?`)) return;
    plan.areas = plan.areas.filter((x) => x !== a);
    P.draw = false; P.sel = plan.areas[0]?.id ?? 'extra';
    return areaChanged(true);
  }
  if (act === 'shuffle') { a.seed = 1 + Math.floor(Math.random() * 1e6); return areaChanged(false); }
  saveSurvey();
  if (act === 'rename' || !list) renderPlan(); else refreshPlanMap();
};
$('planPanel').oninput = (e) => {
  const a = selArea();
  if (!a) return;
  const id = e.target.id, v = e.target.value;
  if (id === 'aPattern') { a.pattern = v; return areaChanged(true); }
  if (id === 'aRandom') a.randomStart = e.target.checked;
  if (id === 'aSpacing') { if (!(parseFloat(v) >= 0.5)) return; a.spacing = parseFloat(v); if (a === S.survey.plan.areas[0]) { settings.spacing = a.spacing; saveSettings(); } }
  if (id === 'aCount') { if (!(parseInt(v, 10) > 0)) return; a.count = parseInt(v, 10); }
  if (id === 'aBearing') a.bearing = v === '' ? null : ((parseFloat(v) % 360) + 360) % 360;
  areaChanged(false);
};

$('planImport').onclick = async () => {
  const file = await pickFile('.geojson,.json,.gpx,.kml,application/geo+json,application/json');
  if (!file) return;
  try {
    const res = ex.parsePlanFile(await file.text());
    const plan = S.survey.plan;
    plan.areas = plan.areas.filter((a) => a.ring.length >= 3);
    for (const a of res.areas) newArea({ ring: a.ring, name: a.name, fill: a.fill, pattern: a.pattern, spacing: a.spacing, bearing: a.bearing, count: a.count });
    if (res.route && !res.areas.some((a) => a.fill === 'route')) { plan.route = res.route; plan.routeAuto = false; }
    // Points that our own areas will regenerate are not imported twice.
    const own = res.areas.some((a) => a.fill === 'points');
    for (const p of res.points) if (!own || !/^(grid|random)$/.test(p.type || '')) addPoint(p.lat, p.lon, 'imported', p.id != null ? String(p.id) : null);
    P.draw = false; P.sel = plan.areas[plan.areas.length - 1]?.id ?? (res.points.length ? 'extra' : 'route');
    areaChanged(true);
    setFollow(false);
    map.fitBounds(L.latLngBounds([...res.areas.flatMap((a) => a.ring), ...(res.route || []), ...res.points.map((p) => [p.lat, p.lon])]).pad(0.15), { maxZoom: 19 });
    toast(`Imported ${[res.areas.length && `${res.areas.length} area${res.areas.length > 1 ? 's' : ''}`, res.route && 'route', res.points.length && `${res.points.length} points`].filter(Boolean).join(', ')}.`);
  } catch (e) { toast('Import failed: ' + e.message, 6000); }
};

// ---------- observations ----------
export function currentSpot() {
  if (S.est && (S.est.used || filter.ready)) return { lat: S.est.lat, lon: S.est.lon, acc: S.fix?.acc ?? null, from: 'gps' };
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng, acc: null, from: 'map' };
}
export async function saveObs(o) {
  if (!o.num) { o.num = ++S.survey.obsCount; S.obs.push(o); saveSurvey(); }
  await db.put('obs', o);
  drawObs();
}
$('bMark').onclick = async () => {
  if (mode().action === 'sample') return startSample();
  const spot = currentSpot();
  const o = { id: db.uid(), surveyId: S.survey.id, t: Date.now(), ...spot, category: '', note: '', reading: null, unit: noteUnit(), extent: null, photoIds: [] };
  await saveObs(o);
  if (navigator.vibrate) navigator.vibrate(60);
  toast(`Mark ${o.num} dropped${spot.from === 'map' ? ' at map centre (no GPS)' : ` (±${Math.round(spot.acc)} m)`}. Tap it to add details.`);
};
$('bNote').onclick = () => openNote(null);

async function shrinkPhoto(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
    return blob || file;
  } catch { return file; }
}

/**
 * Photo picker shared by the note and sample forms. Mutates o.photoIds;
 * nothing touches the database until save() is called.
 */
export function photoEditor(el, o) {
  const fresh = new Map(), removed = [], urls = [];
  el.innerHTML = `<div class="actions" style="margin-top:6px"><button class="btn primary" data-p="environment">Take photo</button><button class="btn" data-p="">Add from gallery</button></div><div class="thumbs"></div>`;
  const thumbs = async () => {
    const box = el.querySelector('.thumbs');
    box.innerHTML = '';
    for (const id of o.photoIds) {
      const blob = fresh.get(id) || (await db.get('photos', id))?.blob;
      if (!blob) continue;
      const url = URL.createObjectURL(blob); urls.push(url);
      const d = document.createElement('div');
      d.innerHTML = `<img src="${url}" alt="photo"><button aria-label="Remove photo">✕</button>`;
      d.querySelector('button').onclick = () => { o.photoIds = o.photoIds.filter((x) => x !== id); if (!fresh.delete(id)) removed.push(id); thumbs(); };
      d.querySelector('img').onclick = () => window.open(url, '_blank');
      box.appendChild(d);
    }
  };
  thumbs();
  el.querySelector('.actions').onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const file = await pickFile('image/*', b.dataset.p || null);
    if (!file) return;
    const id = db.uid();
    fresh.set(id, await shrinkPhoto(file));
    o.photoIds.push(id);
    thumbs();
  };
  return {
    async save() {
      for (const [id, blob] of fresh) await db.put('photos', { id, surveyId: S.survey.id, obsId: o.id, blob });
      for (const id of removed) await db.del('photos', id);
    },
    dispose() { urls.forEach(URL.revokeObjectURL); },
  };
}
export async function deleteObs(o) {
  for (const id of o.photoIds || []) await db.del('photos', id);
  await db.del('obs', o.id);
  S.obs = S.obs.filter((x) => x.id !== o.id);
  drawObs();
}

async function openNote(existing) {
  if (existing?.kind === 'sample') return openSample(null, existing);
  // Position and time are captured the moment the button is pressed, not when saved.
  const o = existing ? { ...existing, photoIds: [...(existing.photoIds || [])] }
    : { id: db.uid(), surveyId: S.survey.id, t: Date.now(), ...currentSpot(), category: '', note: '', reading: null, unit: noteUnit(), extent: null, photoIds: [] };
  const cats = noteCategories();
  if (o.category && !cats.includes(o.category)) cats.push(o.category);
  let photos;
  const body = openSheet(existing ? `Note ${o.num}` : 'New note', `
    <p class="muted" id="nPos"></p>
    <div id="nPhotos"></div>
    <div class="chips" id="nCats">${cats.map((c) => `<button data-c="${esc(c)}" class="${c === o.category ? 'on' : ''}">${esc(c)}</button>`).join('')}</div>
    <label class="field">Note<textarea id="nNote" placeholder="What did you see?">${esc(o.note)}</textarea></label>
    <div class="two">
      <label class="field">Reading<input id="nReading" type="number" inputmode="decimal" step="any" value="${o.reading ?? ''}"></label>
      <label class="field">Unit<input id="nUnit" value="${esc(o.unit || '')}"></label>
    </div>
    <label class="field">Size of affected area (m across, optional)<input id="nExtent" type="number" inputmode="decimal" step="any" value="${o.extent ?? ''}"></label>
    <div class="actions"><button class="btn" id="nMove">Move to map crosshair</button></div>
    <div class="actions">
      ${existing ? '<button class="btn danger" id="nDel">Delete</button>' : ''}
      <button class="btn primary" id="nSave">Save</button>
    </div>`, () => { photos.dispose(); $('crosshair').hidden = !S.planShape; });
  const q = (s) => body.querySelector(s);
  photos = photoEditor(q('#nPhotos'), o);
  const posText = () => { q('#nPos').textContent = `${ex.localStamp(o.t)} · ${o.lat.toFixed(6)}, ${o.lon.toFixed(6)} · ${o.from === 'map' || o.acc == null ? 'placed on map' : `GPS ±${Math.round(o.acc)} m`}`; };
  posText();
  q('#nCats').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    o.category = o.category === b.dataset.c ? '' : b.dataset.c;
    q('#nCats').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.c === o.category));
  };
  $('crosshair').hidden = false;
  q('#nMove').onclick = () => { const c = map.getCenter(); o.lat = c.lat; o.lon = c.lng; o.acc = null; o.from = 'map'; posText(); toast('Position set to the map crosshair.'); };
  q('#nSave').onclick = async () => {
    o.note = q('#nNote').value.trim();
    const r = q('#nReading').value, x = q('#nExtent').value;
    o.reading = r === '' ? null : Number(r);
    o.unit = q('#nUnit').value.trim();
    o.extent = x === '' ? null : Number(x);
    await photos.save();
    if (existing) Object.assign(existing, o);
    await saveObs(existing || o);
    closeSheet();
    toast(`Note ${(existing || o).num} saved.`);
  };
  if (existing) q('#nDel').onclick = async () => {
    if (!confirm(`Delete note ${o.num} and its photos?`)) return;
    await deleteObs(existing);
    closeSheet();
  };
}

// ---------- menu ----------
$('bMenu').onclick = () => {
  const soil = mode().action === 'sample' || S.survey.plan.points.length;
  const notes = ex.notesOnly(S.obs).length, samples = ex.samplesOnly(S.obs).length;
  const b = openSheet('Menu', `<div class="list">
    <button class="btn" data-a="mode">Survey type: ${esc(mode().name)}<small>Tap to change</small></button>
    ${soil ? `<button class="btn" data-a="points">Sampling points<small>${S.survey.plan.points.filter((p) => p.status !== 'todo').length} of ${S.survey.plan.points.length} visited</small></button>
    <button class="btn" data-a="samples">Samples<small>${samples} logged</small></button>` : ''}
    <button class="btn primary" data-a="export">Export data<small>ZIP for QGIS, CSV, GPX, GeoJSON</small></button>
    <button class="btn" data-a="merge">Merge instrument readings<small>Match a gas monitor CSV to this track by time</small></button>
    <button class="btn" data-a="clock">Instrument clock sync<small>${S.survey.clockOffsetS == null ? 'Not set for this survey' : `Offset ${S.survey.clockOffsetS} s`}</small></button>
    <button class="btn" data-a="notes">Notes &amp; marks<small>${notes} in this survey</small></button>
    <button class="btn" data-a="surveys">Surveys<small>New, switch, rename, delete, restore backup</small></button>
    <button class="btn" data-a="settings">Settings &amp; offline maps</button>
    <button class="btn" data-a="help">How it works</button>
  </div>`);
  b.querySelector('.list').onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a) ({ mode: openMode, points: openPointList, samples: openSamplesList, export: openExport, merge: () => openMerge(), clock: openClock, notes: openNotesList, surveys: openSurveys, settings: openSettings, help: openHelp })[a]();
  };
};
$('surveyBtn').onclick = () => openSurveys();

function openMode() {
  const b = openSheet('Survey type', `<p class="muted">The type sets how this survey is planned and guided and what the quick button records. You can change it at any time; nothing already recorded is lost.</p>
    <div class="list">${Object.entries(MODES).map(([k, m]) => `<button class="btn ${k === S.survey.mode ? 'primary' : ''}" data-m="${k}"><span>${esc(m.name)}<small>${esc(m.blurb)}</small></span></button>`).join('')}</div>`);
  b.querySelector('.list').onclick = async (e) => {
    const k = e.target.closest('button')?.dataset.m;
    if (!k) return;
    S.survey.mode = settings.mode = k; saveSettings(); await saveSurvey();
    $('bMark').lastElementChild.textContent = mode().action === 'sample' ? 'Sample' : 'Mark';
    refreshGuide(); closeSheet();
    toast(`This survey is now “${mode().name}”.`);
  };
}

function openNotesList() {
  const list = ex.notesOnly(S.obs);
  const b = openSheet('Notes & marks', list.length ? `<div class="list">${list.map((o) => `<button class="btn" data-id="${o.id}"><span><b>${o.num}</b> ${esc(o.category || 'Mark')}${o.reading != null ? ` · ${o.reading} ${esc(o.unit || '')}` : ''}
    <small>${ex.localStamp(o.t).slice(11)}${o.photoIds?.length ? ` · ${o.photoIds.length} photo${o.photoIds.length > 1 ? 's' : ''}` : ''}${o.note ? ' · ' + esc(o.note.slice(0, 60)) : ''}</small></span></button>`).join('')}</div>`
    : '<p class="muted">Nothing yet. Use Mark for a one-tap pin, or Note for a photo, category, reading and text.</p>');
  b.onclick = (e) => {
    const o = S.obs.find((x) => x.id === e.target.closest('button')?.dataset.id);
    if (o) { setFollow(false); map.setView([o.lat, o.lon], Math.max(map.getZoom(), 19)); openNote(o); }
  };
}

// ---------- export ----------
function backupJSON() {
  return JSON.stringify({ format: 'surveyxyz', version: 1, exported: new Date().toISOString(), survey: S.survey, points: S.points.map(({ id, ...p }) => p), obs: S.obs });
}
async function exportZip() {
  toast('Building ZIP…', 0);
  const { survey, points, obs } = S;
  const entries = [
    { name: 'README.txt', data: ex.packageReadme(survey, points, obs) },
    { name: 'track.csv', data: ex.trackCSV(points) },
    { name: 'track_line.geojson', data: JSON.stringify(ex.trackLineGeoJSON(survey, points)) },
    { name: 'track_points.geojson', data: JSON.stringify(ex.trackPointsGeoJSON(points)) },
    { name: 'observations.geojson', data: JSON.stringify(ex.obsGeoJSON(obs)) },
    { name: 'observations.csv', data: ex.obsCSV(obs) },
    { name: 'samples.csv', data: ex.samplesCSV(survey, obs) },
    { name: 'samples.geojson', data: JSON.stringify(ex.samplesGeoJSON(survey, obs)) },
    { name: 'plan.geojson', data: JSON.stringify(ex.planGeoJSON(survey)) },
    { name: 'track.gpx', data: ex.gpx(survey, points, obs) },
    { name: 'survey.json', data: backupJSON() },
  ];
  for (const o of obs) {
    for (const [i, id] of (o.photoIds || []).entries()) {
      const ph = await db.get('photos', id);
      if (ph) entries.push({ name: ex.photoName(o, i), data: ph.blob, date: new Date(o.t) });
    }
  }
  const blob = await makeZip(entries);
  $('toast').hidden = true;
  await deliver(blob, `${ex.safeName(survey.name)}.zip`);
}
function openExport() {
  const n = ex.safeName(S.survey.name);
  const b = openSheet('Export', `
    <p class="muted">${S.points.length} GPS fixes · ${ex.notesOnly(S.obs).length} notes · ${ex.samplesOnly(S.obs).length} samples · ${fmtDist(S.dist)}. Coordinates are WGS84 (EPSG:4326).</p>
    <div class="list">
      <button class="btn primary" data-a="zip">Everything (.zip)<small>All files below + photos + README. Unzip and drag into QGIS.</small></button>
      <button class="btn" data-a="csv">Track table (.csv)<small>One row per fix: time, lat/lon, raw lat/lon, accuracy</small></button>
      <button class="btn" data-a="geojson">Map layers (.geojson)<small>Plan, walked line and notes in one file</small></button>
      <button class="btn" data-a="gpx">GPX<small>Track, waypoints and planned route</small></button>
      <button class="btn" data-a="samples">Sample register (.csv)<small>One row per sample: ID, location, depth, type, description, analysis, coordinates</small></button>
      <button class="btn" data-a="obs">Notes table (.csv)</button>
      <button class="btn" data-a="plan">Plan only (.geojson)<small>Boundary, route and sampling points; re-importable for the next visit</small></button>
      <button class="btn" data-a="json">Backup (.json)<small>Restore later via Surveys → Restore backup (no photos)</small></button>
    </div>`);
  b.querySelector('.list').onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (!a) return;
    const text = (s, name, type) => deliver(new Blob([s], { type }), name);
    try {
      if (a === 'zip') await exportZip();
      if (a === 'csv') await text(ex.trackCSV(S.points), `${n}_track.csv`, 'text/csv');
      if (a === 'geojson') await text(JSON.stringify(ex.allGeoJSON(S.survey, S.points, S.obs)), `${n}.geojson`, 'application/geo+json');
      if (a === 'gpx') await text(ex.gpx(S.survey, S.points, S.obs), `${n}.gpx`, 'application/gpx+xml');
      if (a === 'samples') await text(ex.samplesCSV(S.survey, S.obs), `${n}_samples.csv`, 'text/csv');
      if (a === 'obs') await text(ex.obsCSV(S.obs), `${n}_notes.csv`, 'text/csv');
      if (a === 'plan') await text(JSON.stringify(ex.planGeoJSON(S.survey)), `${n}_plan.geojson`, 'application/geo+json');
      if (a === 'json') await text(backupJSON(), `${n}_backup.json`, 'application/json');
    } catch (err) { toast('Export failed: ' + err.message, 6000); }
  };
}

// ---------- instrument clock ----------
function openClock() {
  const b = openSheet('Instrument clock sync', `
    <p>Gas monitors keep their own clock, and it is rarely exact. Readings are matched to GPS by time, so a clock that is a minute out puts every reading tens of metres along the path.</p>
    <p>Look at the instrument, type the time it shows, and press <b>Set</b> at the moment its seconds match.</p>
    <p class="muted">Phone time now: <b id="cNow"></b></p>
    <label class="field">Time shown on the instrument<input id="cTime" type="time" step="1"></label>
    <div class="actions"><button class="btn primary" id="cSet">Set (press when it matches)</button></div>
    <label class="field">Or enter the offset directly (seconds to ADD to instrument time)<input id="cOff" type="number" step="1" value="${S.survey.clockOffsetS ?? ''}"></label>
    <div class="actions"><button class="btn" id="cSave">Save offset</button></div>
    <p class="muted" id="cCur"></p>`, () => clearInterval(tick));
  const q = (s) => b.querySelector(s);
  const show = () => { q('#cCur').textContent = S.survey.clockOffsetS == null ? 'No offset saved for this survey.' : `Saved: instrument is ${Math.abs(S.survey.clockOffsetS)} s ${S.survey.clockOffsetS >= 0 ? 'behind' : 'ahead of'} the phone. Used automatically when you merge readings.`; };
  show();
  const tick = setInterval(() => { q('#cNow').textContent = ex.localStamp(Date.now()).slice(11); }, 250);
  q('#cTime').value = ex.localStamp(Date.now() + 15000).slice(11);
  const save = (v) => { S.survey.clockOffsetS = v; saveSurvey(); q('#cOff').value = v ?? ''; show(); toast('Clock offset saved.'); };
  q('#cSet').onclick = () => {
    const m = q('#cTime').value.match(/(\d+):(\d+)(?::(\d+))?/);
    if (!m) return toast('Enter the instrument time first.');
    const now = new Date();
    const inst = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2], +(m[3] || 0));
    let off = Math.round((now - inst) / 1000);
    if (off > 43200) off -= 86400; if (off < -43200) off += 86400;
    save(off);
  };
  q('#cSave').onclick = () => { const v = q('#cOff').value; save(v === '' ? null : Math.round(Number(v))); };
}

// ---------- surveys ----------
async function openSurveys() {
  const list = (await db.all('surveys')).sort((a, b) => b.created - a.created);
  const b = openSheet('Surveys', `
    <label class="field">New survey name<input id="sName" placeholder="e.g. North cell – Nov ISM"></label>
    <label class="field">Survey type<select id="sMode">${Object.entries(MODES).map(([k, m]) => `<option value="${k}" ${k === S.survey.mode ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
    <label class="field inline"><input type="checkbox" id="sCopy" ${S.survey.plan.route.length || S.survey.plan.areas.length || S.survey.plan.points.length ? 'checked' : ''}>Copy the plan (areas, route, points) from “${esc(S.survey.name)}”</label>
    <div class="actions"><button class="btn primary" id="sNew">Create</button><button class="btn" id="sImport">Restore backup</button></div>
    <h3>On this device</h3>
    <div class="list">${list.map((s) => `<div class="survey-row ${s.id === S.survey.id ? 'cur' : ''}" data-id="${s.id}">
      <b>${esc(s.name)}</b><div class="muted">${esc((MODES[s.mode] || MODES.ism).name)} · ${ex.localStamp(s.created).slice(0, 16)}${s.id === S.survey.id ? ' · open' : ''}</div>
      <div class="row">${s.id === S.survey.id ? '' : '<button class="btn primary" data-a="open">Open</button>'}<button class="btn" data-a="rename">Rename</button><button class="btn danger" data-a="delete">Delete</button></div>
    </div>`).join('')}</div>`);
  const q = (s) => b.querySelector(s);
  q('#sNew').onclick = async () => {
    const s = await newSurvey(q('#sName').value.trim(), q('#sCopy').checked ? S.survey : null, q('#sMode').value);
    settings.mode = s.mode; saveSettings();
    await loadSurvey(s.id); closeSheet(); toast(`“${s.name}” created.`);
  };
  q('#sImport').onclick = async () => {
    const file = await pickFile('.json,application/json');
    if (!file) return;
    try {
      const d = JSON.parse(await file.text());
      if (d.format !== 'surveyxyz' || !d.survey) throw new Error('not a SurveyXYZ backup');
      const id = db.uid();
      await db.put('surveys', { ...d.survey, id, name: d.survey.name + ' (restored)' });
      await db.putMany('points', (d.points || []).map((p) => ({ ...p, surveyId: id })));
      await db.putMany('obs', (d.obs || []).map((o) => ({ ...o, id: db.uid(), surveyId: id, photoIds: [] })));
      await loadSurvey(id); closeSheet(); toast('Backup restored (photos are not part of backups).', 5000);
    } catch (e) { toast('Restore failed: ' + e.message, 6000); }
  };
  q('.list').onclick = async (e) => {
    const a = e.target.closest('button')?.dataset.a, id = e.target.closest('.survey-row')?.dataset.id;
    const s = list.find((x) => x.id === id);
    if (!a || !s) return;
    if (a === 'open') { await loadSurvey(id); closeSheet(); }
    if (a === 'rename') {
      const name = prompt('Survey name', s.name);
      if (!name) return;
      s.name = name.trim(); await db.put('surveys', s);
      if (id === S.survey.id) { S.survey.name = s.name; $('surveyName').textContent = s.name; }
      openSurveys();
    }
    if (a === 'delete') {
      if (!confirm(`Delete “${s.name}” with all its GPS data, notes and photos? This cannot be undone — export it first if you need it.`)) return;
      if (id === S.survey.id && S.recording) await stopRecording();
      await db.deleteSurvey(id);
      if (id === S.survey.id) await loadSurvey(null);
      openSurveys();
    }
  };
}

// ---------- settings ----------
function tileUrls() {
  const layer = Object.values(bases).find((l) => map.hasLayer(l));
  const b = map.getBounds(), z0 = Math.min(19, Math.round(map.getZoom()));
  const urls = [];
  for (let z = z0; z <= Math.min(19, z0 + 3); z++) {
    const a = map.project(b.getNorthWest(), z).divideBy(256).floor(), c = map.project(b.getSouthEast(), z).divideBy(256).floor();
    for (let x = a.x; x <= c.x; x++) for (let y = a.y; y <= c.y; y++) urls.push(L.Util.template(layer._url, { x, y, z }));
  }
  return urls;
}
async function saveOffline() {
  if (!('caches' in window)) return toast('Offline storage is not available in this browser.');
  const urls = tileUrls();
  if (urls.length > 1500) return toast(`That is ${urls.length} map tiles — zoom in closer to the site and try again.`, 6000);
  const cache = await caches.open('sxyz-tiles');
  let done = 0, failed = 0;
  const work = async () => {
    for (let u; (u = urls.pop());) {
      try { if (!(await cache.match(u))) { const r = await fetch(u, { mode: 'cors' }); if (r.ok) await cache.put(u, r); else failed++; } } catch { failed++; }
      toast(`Saving map tiles… ${++done}`, 0);
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  toast(failed ? `Saved, but ${failed} tiles failed. Check your connection and retry.` : `Map saved for offline use (${done} tiles, down to full zoom).`, 5000);
}
function openSettings() {
  const b = openSheet('Settings', `
    <h3>GPS</h3>
    <label class="field">Position filter<select id="oMode">
      <option value="smart">Smart — GPS + motion sensors (recommended)</option>
      <option value="gps">GPS smoothing only</option>
      <option value="raw">Raw GPS, no filtering</option></select></label>
    <p class="muted">Raw fixes are always stored alongside the filtered ones, so you can compare or reprocess later.</p>
    <label class="field">Ignore fixes worse than (± metres)<input id="oAcc" type="number" min="5" max="200" value="${settings.maxAcc}"></label>
    <label class="field inline"><input type="checkbox" id="oRaw" ${settings.showRaw ? 'checked' : ''}>Show raw GPS trace on the map</label>
    <h3>Path guidance</h3>
    <label class="field">Off-path tolerance (metres)<input id="oTol" type="number" min="0.5" step="0.5" value="${settings.tol}"></label>
    <label class="field inline"><input type="checkbox" id="oSound" ${settings.sound ? 'checked' : ''}>Beep when off path</label>
    <label class="field inline"><input type="checkbox" id="oVib" ${settings.vibrate ? 'checked' : ''}>Vibrate when off path (Android)</label>
    <label class="field">Sampling point “arrived” distance (metres)<input id="oArrive" type="number" min="0.5" step="0.5" value="${settings.arrive}"></label>
    <h3>Notes — ${esc(mode().name)}</h3>
    <label class="field">Categories (comma separated)<textarea id="oCats">${esc(noteCategories().join(', '))}</textarea></label>
    <label class="field">Default reading unit<input id="oUnit" value="${esc(noteUnit())}"></label>
    <h3>Samples</h3>
    <label class="field">Analysis options (comma separated)<textarea id="oAnalytes">${esc(settings.analytes)}</textarea></label>
    <label class="field">Sampling point ID prefix for this survey<input id="oPrefix" value="${esc(S.survey.plan.prefix || 'S')}"></label>
    <h3>Offline maps</h3>
    <p class="muted">Map tiles you have looked at are kept for offline use. To prepare a site, frame it on the map with the basemap you want, then:</p>
    <div class="actions"><button class="btn primary" id="oSaveMap">Save this map area</button><button class="btn" id="oClearMap">Clear saved maps</button></div>
    <p class="muted" id="oStore"></p>`, () => {
    const q = (s) => b.querySelector(s);
    const num = (s, min, def) => { const v = parseFloat(q(s).value); return v >= min ? v : def; };
    const tol = settings.tol;
    Object.assign(settings, {
      filterMode: q('#oMode').value, maxAcc: num('#oAcc', 5, 25), showRaw: q('#oRaw').checked, tol: num('#oTol', 0.5, 3),
      sound: q('#oSound').checked, vibrate: q('#oVib').checked, arrive: num('#oArrive', 0.5, 3), analytes: q('#oAnalytes').value,
      ['cats_' + S.survey.mode]: q('#oCats').value, ['unit_' + S.survey.mode]: q('#oUnit').value.trim(),
    });
    const prefix = q('#oPrefix').value.trim() || 'S';
    if (prefix !== (S.survey.plan.prefix || 'S')) { S.survey.plan.prefix = prefix; regenerate(); saveSurvey(); drawPlan(); }
    saveSettings();
    if (filter.o.mode !== settings.filterMode) { filter.o.mode = settings.filterMode; filter.reset(); }
    filter.o.maxAcc = settings.maxAcc;
    if (tol !== settings.tol) rebuildRoute(true);
    drawTrack(); refreshGuide();
  });
  b.querySelector('#oMode').value = settings.filterMode;
  b.querySelector('#oSaveMap').onclick = saveOffline;
  b.querySelector('#oClearMap').onclick = async () => { if (confirm('Remove all saved map tiles?')) { await caches.delete('sxyz-tiles'); toast('Saved maps cleared.'); } };
  navigator.storage?.estimate?.().then((e) => { const el = b.querySelector('#oStore'); if (el) el.textContent = `Storage used on this device: ${(e.usage / 1e6).toFixed(0)} MB of about ${(e.quota / 1e9).toFixed(1)} GB available.`; });
}

function openHelp() {
  openSheet('How it works', `
    <h3>Survey types</h3>
    <p>Each survey has a type (<b>Menu → Survey type</b>): <b>Gas walkover (ISM)</b> follows a walked route; <b>Contaminated land sampling</b> plans sampling points and logs samples; <b>General</b> is plain tracking, notes and photos.</p>
    <h3>1 · Plan</h3>
    <p>Tap <b>Plan</b> and tap round the edge of the site (or walk it pressing <b>+ Here</b>), then <b>Finish shape</b>. The area fills itself straight away: sampling points or walk transects, depending on the survey type. Change the pattern, spacing or bearing and the map updates as you type.</p>
    <p><b>+ Area</b> adds another area with its own settings. Draw one inside the site for a <b>focus area</b> with a tighter grid: it replaces the site grid there. Set an area to <b>Empty</b> to keep points out of it (a building, a pond). Tap an area on the map to select it.</p>
    <p><b>Targeted points</b> are single points you tap in at known sources; they are never changed by the areas. Plans can be imported from GeoJSON, KML or GPX, and a plan exported from here re-imports with its areas and settings.</p>
    <p class="muted">The hotspot size shown for a grid is an aid; the choice of density still needs site-specific justification in your sampling plan.</p>
    <h3>Sampling</h3>
    <p>The arrow leads to the next point with the distance to it. Tap <b>Sample</b> on arrival: the sample ID, depth, type (primary, duplicate, blanks), method, soil description, evidence of contamination, PID reading, analysis and photos are saved against the location with the position you actually sampled at. <b>Save + next depth</b> logs another depth at the same spot. Tap a point on the map to navigate to it, mark it as not sampled with a reason, move it, or add step-out points around it.</p>
    <h3>2 · Sync the instrument clock</h3>
    <p><b>Menu → Instrument clock sync</b> before you start. This is what makes the later merge line up.</p>
    <h3>3 · Record</h3>
    <p>Press <b>Record</b> and walk. The route is followed in order from the green dot to the red dot. The arrow shows which way to face and walk (hold the phone flat, pointing ahead), with the distance back to the path when you are off it or to the next turn when you are on it; walked sections turn green. Tap the banner to continue from the nearest point, restart, or reverse the route. <b>Keep this app open with the screen on</b> — phones stop giving GPS to web apps when locked or in the background. Carry the phone the same way throughout (in hand or a chest pocket works best).</p>
    <h3>4 · Mark and note</h3>
    <p><b>Mark</b> drops a numbered pin instantly. <b>Note</b> captures the position first, then lets you add photos, a category, a reading and text. To record something you can see but not reach, pan the map and use <b>Move to map crosshair</b>.</p>
    <h3>5 · Export and merge</h3>
    <p><b>Menu → Export</b> gives a ZIP that opens directly in QGIS. <b>Menu → Merge instrument readings</b> takes the monitor's CSV log and gives every reading a coordinate by matching timestamps.</p>
    <h3>About the position filter</h3>
    <p>The app blends GPS with the phone's step counter and compass. While you stand still it averages fixes instead of drawing wander; single fixes that leap away are ignored; through short GPS dropouts it carries on by counting steps. The blue circle is the estimated uncertainty. It makes a phone GPS behave better — it does not turn it into survey-grade GNSS, so expect a few metres under open sky.</p>
    <p class="muted">All data stays on this device until you export it. Export after every survey.</p>`);
}

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost') navigator.serviceWorker?.register('sw.js').catch(() => {});
loadSurvey(localStorage.getItem('sxyz.current')).then(() => {
  sensors.startGps();
  sensors.startMotion(); // compass for the guidance arrow
  window.addEventListener('pointerdown', () => { if (sensors.compass == null) sensors.startMotion(); }, { once: true });
  if (!localStorage.getItem('sxyz.seen')) { localStorage.setItem('sxyz.seen', '1'); openHelp(); }
});
// Debug/testing handle.
window.sxyz = { S, settings, filter, sensors, map };
