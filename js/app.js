/* global L */
import * as db from './db.js';
import { FusionFilter } from './fusion.js';
import { Sensors } from './sensors.js';
import { haversine, bearing, angDiff, cardinal, frameFor, nearestOnRoute, generateTransects, longestEdgeBearing, polygonArea, pathLength, Coverage } from './geo.js';
import * as ex from './exporters.js';
import { makeZip } from './zip.js';
import { openMerge } from './mergeui.js';

const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- settings ----------
const DEFAULTS = {
  filterMode: 'smart', maxAcc: 25, tol: 3, spacing: 10, sound: true, vibrate: true, showRaw: false,
  categories: 'Exceedance, Crack / fissure, Vegetation stress, Odour, Leachate, Erosion, Well / borehole, Cover damage, Other',
  unit: 'ppm', base: 'Satellite',
};
export const settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('sxyz.settings') || '{}') };
const saveSettings = () => localStorage.setItem('sxyz.settings', JSON.stringify(settings));

// ---------- state ----------
export const S = {
  survey: null, points: [], obs: [],
  recording: false, seg: 0, activeMs: 0, dist: 0,
  fix: null, est: null, lastFixWall: 0, lastDrSteps: 0,
  follow: true, planShape: null,
  route: null, // {frame, xy}
  coverage: null, hint: -1, offCount: 0, lastAlert: 0,
};
const filter = new FusionFilter({ mode: settings.filterMode, maxAcc: settings.maxAcc });
const sensors = new Sensors(filter, { onFix, onError: onGpsError });

// ---------- map ----------
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

const layers = {
  plan: L.layerGroup().addTo(map), covered: L.layerGroup().addTo(map), raw: L.layerGroup().addTo(map),
  track: L.layerGroup().addTo(map), readings: L.layerGroup().addTo(map), obs: L.layerGroup().addTo(map),
  edit: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map),
};
export { map, layers };
const accCircle = L.circle([0, 0], { radius: 1, color: '#1565c0', weight: 1, fillOpacity: 0.12, interactive: false });
const meMarker = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="me"><i hidden></i></div>', iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false, zIndexOffset: 1000 });
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
  $('sheetBody').innerHTML = html;
  $('sheetBody').scrollTop = 0;
  $('sheet').hidden = false;
  sheetOnClose = onClose || null;
  return $('sheetBody');
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
const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m');
const fmtDur = (ms) => {
  const s = Math.floor(ms / 1000), p = (n) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
};

// ---------- surveys ----------
async function newSurvey(name, copyPlanFrom) {
  const survey = {
    id: db.uid(), name: name || 'Survey ' + ex.localStamp(Date.now()).slice(0, 16), created: Date.now(), clockOffsetS: null, obsCount: 0,
    plan: copyPlanFrom ? JSON.parse(JSON.stringify(copyPlanFrom.plan)) : { boundary: [], route: [], spacing: settings.spacing, bearing: null },
  };
  await db.put('surveys', survey);
  return survey;
}
const saveSurvey = () => db.put('surveys', S.survey);

async function loadSurvey(id) {
  if (S.recording) await stopRecording();
  let survey = id && (await db.get('surveys', id));
  if (!survey) {
    const list = await db.all('surveys');
    survey = list.sort((a, b) => b.created - a.created)[0] || (await newSurvey());
  }
  S.survey = survey;
  localStorage.setItem('sxyz.current', survey.id);
  S.points = (await db.bySurvey('points', survey.id)).sort((a, b) => a.t - b.t);
  S.obs = (await db.bySurvey('obs', survey.id)).sort((a, b) => a.num - b.num);
  S.seg = S.points.reduce((m, p) => Math.max(m, p.seg), 0);
  S.activeMs = 0; S.dist = 0;
  for (let i = 1; i < S.points.length; i++) addStats(S.points[i - 1], S.points[i]);
  $('surveyName').textContent = survey.name;
  layers.readings.clearLayers();
  drawPlan(); rebuildRoute(true); drawTrack(); drawObs(); updateRecChip();
  const pts = [...(survey.plan.boundary || []), ...(survey.plan.route || []), ...S.points.slice(-200).map((p) => [p.lat, p.lon])];
  if (pts.length > 1) { setFollow(false); map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 19 }); }
}
function addStats(a, b) {
  if (a.seg !== b.seg) return;
  S.activeMs += b.t - a.t;
  S.dist += haversine(a.lat, a.lon, b.lat, b.lon);
}

// ---------- drawing ----------
function drawPlan() {
  layers.plan.clearLayers();
  const { boundary, route } = S.survey.plan;
  if (boundary?.length >= 2) L.polygon(boundary, { color: '#ff9800', weight: 3, fillOpacity: 0.05, interactive: false }).addTo(layers.plan);
  if (route?.length >= 2) {
    L.polyline(route, { color: '#fff', weight: 6, opacity: 0.7, interactive: false }).addTo(layers.plan);
    L.polyline(route, { color: '#1565c0', weight: 3, dashArray: '8 7', interactive: false }).addTo(layers.plan);
    L.circleMarker(route[0], { radius: 7, color: '#fff', weight: 2, fillColor: '#1a8f3c', fillOpacity: 1, interactive: false }).addTo(layers.plan);
    L.circleMarker(route[route.length - 1], { radius: 7, color: '#fff', weight: 2, fillColor: '#c62828', fillOpacity: 1, interactive: false }).addTo(layers.plan);
  }
}
function rebuildRoute(replay) {
  const route = S.survey.plan.route || [];
  S.hint = -1;
  if (route.length < 2) { S.route = null; S.coverage = null; layers.covered.clearLayers(); $('guide').hidden = true; return; }
  const frame = frameFor(route);
  S.route = { frame, xy: route.map((p) => frame.toXY(p[0], p[1])) };
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
function drawObs() {
  layers.obs.clearLayers();
  for (const o of S.obs) {
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
function guide(est) {
  const g = $('guide');
  if (!S.route || S.planShape) { g.hidden = true; return null; }
  const p = S.route.frame.toXY(est.lat, est.lon);
  const n = nearestOnRoute(S.route.xy, p, S.hint);
  if (!n) { g.hidden = true; return null; }
  S.hint = n.idx;
  g.hidden = false;
  const tol = settings.tol;
  const pct = S.coverage ? Math.round(S.coverage.fraction * 100) : 0;
  if (n.dist > Math.max(25, 6 * tol)) {
    const [la, lo] = S.route.frame.toLL(n.px, n.py);
    const b = bearing(est.lat, est.lon, la, lo);
    g.className = 'far';
    $('guideText').textContent = fmtDist(n.dist);
    $('guideDot').style.left = '50%';
    $('guideSub').textContent = `Path is ${fmtDist(n.dist)} to the ${cardinal(b)} (${Math.round(b)}°) · ${pct}% walked`;
    S.offCount = 0;
    return n.dist;
  }
  // Left/right is relative to the way you are actually walking the line.
  let xte = n.xte;
  const h = filter.travelHeading;
  if (h != null && Math.abs(angDiff(h, n.segBearing)) > 90) xte = -xte;
  const a = Math.abs(xte);
  g.className = a <= tol ? '' : a <= 2 * tol ? 'warn' : 'bad';
  $('guideText').textContent = a <= tol * 0.35 ? 'On path' : xte > 0 ? `← ${a.toFixed(1)} m` : `${a.toFixed(1)} m →`;
  $('guideDot').style.left = 50 + Math.max(-48, Math.min(48, (xte / (3 * tol)) * 50)) + '%';
  $('guideSub').textContent = `Leg ${n.idx + 1}/${S.route.xy.length - 1} · ${fmtDist(n.toEnd)} to turn · ${pct}% walked` + (a > tol ? ` · steer ${xte > 0 ? 'left' : 'right'}` : '');
  if (S.recording && est.moving && a > tol) {
    if (++S.offCount >= 3 && Date.now() - S.lastAlert > 8000) {
      S.lastAlert = Date.now();
      if (settings.vibrate && navigator.vibrate) navigator.vibrate([200, 100, 200]);
      if (settings.sound) beep();
    }
  } else S.offCount = 0;
  return n.xte;
}

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
const planPts = () => S.survey.plan[S.planShape];
function enterPlan() {
  if (S.recording) { toast('Stop recording before editing the plan.'); return; }
  closeSheet();
  S.planShape = S.survey.plan.boundary?.length || !S.survey.plan.route?.length ? 'boundary' : 'route';
  $('planbar').hidden = false; $('guide').hidden = true; $('crosshair').hidden = false;
  $('bPlan').classList.add('on');
  $('planSpacing').value = S.survey.plan.spacing || settings.spacing;
  $('planBearing').value = S.survey.plan.bearing ?? '';
  refreshPlanEdit();
}
function exitPlan() {
  S.planShape = null;
  $('planbar').hidden = true; $('crosshair').hidden = true;
  $('bPlan').classList.remove('on');
  layers.edit.clearLayers();
  saveSurvey(); rebuildRoute(true);
}
function refreshPlanEdit() {
  document.querySelectorAll('#planbar .seg button').forEach((b) => b.classList.toggle('on', b.dataset.shape === S.planShape));
  $('planGen').hidden = S.planShape !== 'boundary';
  drawPlan();
  layers.edit.clearLayers();
  const pts = planPts();
  if (pts.length <= 400) pts.forEach((p, i) => {
    const m = L.marker(p, { draggable: true, icon: L.divIcon({ className: '', html: `<div class="vtx ${S.planShape}"></div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) });
    m.on('drag', () => { const ll = m.getLatLng(); pts[i] = [ll.lat, ll.lng]; drawPlan(); });
    m.on('dragend', () => { saveSurvey(); planInfo(); });
    m.addTo(layers.edit);
  });
  planInfo();
}
function planInfo() {
  const { boundary, route } = S.survey.plan;
  const bits = [];
  if (boundary.length >= 3) { const a = polygonArea(boundary); bits.push(`Area ${a >= 10000 ? (a / 10000).toFixed(2) + ' ha' : Math.round(a) + ' m²'}`); }
  if (route.length >= 2) { const len = pathLength(route); bits.push(`Route ${fmtDist(len)} · ${route.length - 1} legs · about ${Math.max(1, Math.round(len / 60))} min at 1 m/s`); }
  $('planInfo').textContent = bits.join(' · ') || (S.planShape === 'boundary'
    ? 'Tap the map to add boundary corners (or “+ Here” while walking the edge), then fill it with transects.'
    : 'Tap the map to add route points in walking order. Drag points to adjust.');
}
function addVertex(lat, lon) {
  planPts().push([lat, lon]);
  saveSurvey(); refreshPlanEdit();
}
map.on('click', (e) => { if (S.planShape) addVertex(e.latlng.lat, e.latlng.lng); });
$('bPlan').onclick = () => (S.planShape ? exitPlan() : enterPlan());
$('planDone').onclick = exitPlan;
document.querySelectorAll('#planbar .seg button').forEach((b) => { b.onclick = () => { S.planShape = b.dataset.shape; refreshPlanEdit(); }; });
$('planGps').onclick = () => {
  if (!S.est) return toast('No GPS fix yet.');
  if (S.fix.acc > settings.maxAcc) return toast(`GPS too poor right now (±${Math.round(S.fix.acc)} m).`);
  addVertex(S.est.lat, S.est.lon);
};
$('planUndo').onclick = () => { planPts().pop(); saveSurvey(); refreshPlanEdit(); };
$('planClear').onclick = () => {
  if (!planPts().length || !confirm(`Clear the ${S.planShape}?`)) return;
  S.survey.plan[S.planShape] = []; saveSurvey(); refreshPlanEdit();
};
$('planGenerate').onclick = () => {
  const plan = S.survey.plan;
  if (plan.boundary.length < 3) return toast('Add at least 3 boundary corners first.');
  const spacing = parseFloat($('planSpacing').value);
  if (!(spacing >= 0.5)) return toast('Enter a spacing in metres.');
  let b = parseFloat($('planBearing').value);
  if (!Number.isFinite(b)) { b = longestEdgeBearing(plan.boundary); $('planBearing').value = b; }
  if (plan.route.length && !confirm('Replace the existing route?')) return;
  const route = generateTransects(plan.boundary, spacing, b);
  if (route.length < 2) return toast('Boundary is too small for that spacing.');
  plan.route = route; plan.spacing = spacing; plan.bearing = b;
  settings.spacing = spacing; saveSettings(); saveSurvey();
  S.planShape = 'route'; refreshPlanEdit();
  toast(`${route.length / 2} transects, ${fmtDist(pathLength(route))} to walk.`);
};
$('planImport').onclick = async () => {
  const file = await pickFile('.geojson,.json,.gpx,.kml,application/geo+json,application/json');
  if (!file) return;
  try {
    const res = ex.parsePlanFile(await file.text());
    if (res.boundary) S.survey.plan.boundary = res.boundary;
    if (res.route) S.survey.plan.route = res.route;
    saveSurvey(); refreshPlanEdit();
    setFollow(false);
    map.fitBounds(L.latLngBounds([...(res.boundary || []), ...(res.route || [])]).pad(0.15));
    toast(`Imported ${[res.boundary && 'boundary', res.route && 'route'].filter(Boolean).join(' and ')}.`);
  } catch (e) { toast('Import failed: ' + e.message, 6000); }
};

// ---------- observations ----------
function currentSpot() {
  if (S.est && (S.est.used || filter.ready)) return { lat: S.est.lat, lon: S.est.lon, acc: S.fix?.acc ?? null, from: 'gps' };
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng, acc: null, from: 'map' };
}
async function saveObs(o) {
  if (!o.num) { o.num = ++S.survey.obsCount; S.obs.push(o); saveSurvey(); }
  await db.put('obs', o);
  drawObs();
}
$('bMark').onclick = async () => {
  const spot = currentSpot();
  const o = { id: db.uid(), surveyId: S.survey.id, t: Date.now(), ...spot, category: '', note: '', reading: null, unit: settings.unit, extent: null, photoIds: [] };
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

async function openNote(existing) {
  // Position and time are captured the moment the button is pressed, not when saved.
  const o = existing ? { ...existing, photoIds: [...(existing.photoIds || [])] }
    : { id: db.uid(), surveyId: S.survey.id, t: Date.now(), ...currentSpot(), category: '', note: '', reading: null, unit: settings.unit, extent: null, photoIds: [] };
  const newPhotos = new Map(); // id -> blob (not yet saved)
  const removed = [];
  const urls = [];
  const cats = settings.categories.split(',').map((s) => s.trim()).filter(Boolean);
  const body = openSheet(existing ? `Note ${o.num}` : 'New note', `
    <p class="muted" id="nPos"></p>
    <div class="actions" style="margin-top:6px">
      <button class="btn primary" id="nCam">Take photo</button>
      <button class="btn" id="nGal">Add from gallery</button>
    </div>
    <div class="thumbs" id="nThumbs"></div>
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
    </div>`, () => { urls.forEach(URL.revokeObjectURL); $('crosshair').hidden = !S.planShape; });
  const q = (s) => body.querySelector(s);
  const posText = () => { q('#nPos').textContent = `${ex.localStamp(o.t)} · ${o.lat.toFixed(6)}, ${o.lon.toFixed(6)} · ${o.from === 'map' || o.acc == null ? 'placed on map' : `GPS ±${Math.round(o.acc)} m`}`; };
  posText();
  const thumbs = async () => {
    const el = q('#nThumbs');
    el.innerHTML = '';
    for (const id of o.photoIds) {
      const blob = newPhotos.get(id) || (await db.get('photos', id))?.blob;
      if (!blob) continue;
      const url = URL.createObjectURL(blob); urls.push(url);
      const d = document.createElement('div');
      d.innerHTML = `<img src="${url}" alt="photo"><button aria-label="Remove photo">✕</button>`;
      d.querySelector('button').onclick = () => { o.photoIds = o.photoIds.filter((x) => x !== id); if (!newPhotos.delete(id)) removed.push(id); thumbs(); };
      d.querySelector('img').onclick = () => window.open(url, '_blank');
      el.appendChild(d);
    }
  };
  thumbs();
  const addPhoto = async (capture) => {
    const file = await pickFile('image/*', capture);
    if (!file) return;
    const id = db.uid();
    newPhotos.set(id, await shrinkPhoto(file));
    o.photoIds.push(id);
    thumbs();
  };
  q('#nCam').onclick = () => addPhoto('environment');
  q('#nGal').onclick = () => addPhoto(null);
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
    for (const [id, blob] of newPhotos) await db.put('photos', { id, surveyId: S.survey.id, obsId: o.id, blob });
    for (const id of removed) await db.del('photos', id);
    if (existing) Object.assign(existing, o);
    await saveObs(existing || o);
    closeSheet();
    toast(`Note ${(existing || o).num} saved.`);
  };
  if (existing) q('#nDel').onclick = async () => {
    if (!confirm(`Delete note ${o.num} and its photos?`)) return;
    for (const id of existing.photoIds || []) await db.del('photos', id);
    await db.del('obs', o.id);
    S.obs = S.obs.filter((x) => x.id !== o.id);
    drawObs(); closeSheet();
  };
}

// ---------- menu ----------
$('bMenu').onclick = () => {
  const b = openSheet('Menu', `<div class="list">
    <button class="btn primary" data-a="export">Export data<small>ZIP for QGIS, CSV, GPX, GeoJSON</small></button>
    <button class="btn" data-a="merge">Merge instrument readings<small>Match a gas monitor CSV to this track by time</small></button>
    <button class="btn" data-a="clock">Instrument clock sync<small>${S.survey.clockOffsetS == null ? 'Not set for this survey' : `Offset ${S.survey.clockOffsetS} s`}</small></button>
    <button class="btn" data-a="notes">Notes &amp; marks<small>${S.obs.length} in this survey</small></button>
    <button class="btn" data-a="surveys">Surveys<small>New, switch, rename, delete, restore backup</small></button>
    <button class="btn" data-a="settings">Settings &amp; offline maps</button>
    <button class="btn" data-a="help">How it works</button>
  </div>`);
  b.querySelector('.list').onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a) ({ export: openExport, merge: () => openMerge(), clock: openClock, notes: openNotesList, surveys: openSurveys, settings: openSettings, help: openHelp })[a]();
  };
};
$('surveyBtn').onclick = () => openSurveys();

function openNotesList() {
  const b = openSheet('Notes & marks', S.obs.length ? `<div class="list">${S.obs.map((o) => `<button class="btn" data-id="${o.id}"><span><b>${o.num}</b> ${esc(o.category || 'Mark')}${o.reading != null ? ` · ${o.reading} ${esc(o.unit || '')}` : ''}
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
    <p class="muted">${S.points.length} GPS fixes · ${S.obs.length} notes · ${fmtDist(S.dist)}. Coordinates are WGS84 (EPSG:4326).</p>
    <div class="list">
      <button class="btn primary" data-a="zip">Everything (.zip)<small>All files below + photos + README. Unzip and drag into QGIS.</small></button>
      <button class="btn" data-a="csv">Track table (.csv)<small>One row per fix: time, lat/lon, raw lat/lon, accuracy</small></button>
      <button class="btn" data-a="geojson">Map layers (.geojson)<small>Plan, walked line and notes in one file</small></button>
      <button class="btn" data-a="gpx">GPX<small>Track, waypoints and planned route</small></button>
      <button class="btn" data-a="obs">Notes table (.csv)</button>
      <button class="btn" data-a="plan">Plan only (.geojson)<small>Boundary + route, re-importable for the next visit</small></button>
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
    <label class="field inline"><input type="checkbox" id="sCopy" ${S.survey.plan.route.length || S.survey.plan.boundary.length ? 'checked' : ''}>Copy boundary and route from “${esc(S.survey.name)}”</label>
    <div class="actions"><button class="btn primary" id="sNew">Create</button><button class="btn" id="sImport">Restore backup</button></div>
    <h3>On this device</h3>
    <div class="list">${list.map((s) => `<div class="survey-row ${s.id === S.survey.id ? 'cur' : ''}" data-id="${s.id}">
      <b>${esc(s.name)}</b><div class="muted">${ex.localStamp(s.created).slice(0, 16)}${s.id === S.survey.id ? ' · open' : ''}</div>
      <div class="row">${s.id === S.survey.id ? '' : '<button class="btn primary" data-a="open">Open</button>'}<button class="btn" data-a="rename">Rename</button><button class="btn danger" data-a="delete">Delete</button></div>
    </div>`).join('')}</div>`);
  const q = (s) => b.querySelector(s);
  q('#sNew').onclick = async () => {
    const s = await newSurvey(q('#sName').value.trim(), q('#sCopy').checked ? S.survey : null);
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
    <h3>Notes</h3>
    <label class="field">Categories (comma separated)<textarea id="oCats">${esc(settings.categories)}</textarea></label>
    <label class="field">Default reading unit<input id="oUnit" value="${esc(settings.unit)}"></label>
    <h3>Offline maps</h3>
    <p class="muted">Map tiles you have looked at are kept for offline use. To prepare a site, frame it on the map with the basemap you want, then:</p>
    <div class="actions"><button class="btn primary" id="oSaveMap">Save this map area</button><button class="btn" id="oClearMap">Clear saved maps</button></div>
    <p class="muted" id="oStore"></p>`, () => {
    const q = (s) => b.querySelector(s);
    const num = (s, min, def) => { const v = parseFloat(q(s).value); return v >= min ? v : def; };
    const tol = settings.tol;
    Object.assign(settings, {
      filterMode: q('#oMode').value, maxAcc: num('#oAcc', 5, 25), showRaw: q('#oRaw').checked, tol: num('#oTol', 0.5, 3),
      sound: q('#oSound').checked, vibrate: q('#oVib').checked, categories: q('#oCats').value, unit: q('#oUnit').value.trim(),
    });
    saveSettings();
    if (filter.o.mode !== settings.filterMode) { filter.o.mode = settings.filterMode; filter.reset(); }
    filter.o.maxAcc = settings.maxAcc;
    if (tol !== settings.tol) rebuildRoute(true);
    drawTrack();
  });
  b.querySelector('#oMode').value = settings.filterMode;
  b.querySelector('#oSaveMap').onclick = saveOffline;
  b.querySelector('#oClearMap').onclick = async () => { if (confirm('Remove all saved map tiles?')) { await caches.delete('sxyz-tiles'); toast('Saved maps cleared.'); } };
  navigator.storage?.estimate?.().then((e) => { const el = b.querySelector('#oStore'); if (el) el.textContent = `Storage used on this device: ${(e.usage / 1e6).toFixed(0)} MB of about ${(e.quota / 1e9).toFixed(1)} GB available.`; });
}

function openHelp() {
  openSheet('How it works', `
    <h3>1 · Plan</h3>
    <p>Tap <b>Plan</b>, tap the corners of the area (or walk the edge pressing <b>+ Here</b>), set a spacing and press <b>Fill with transects</b> for a back-and-forth walk pattern. Or switch to <b>Route</b> and tap out any path. Boundaries and routes can also be imported from GeoJSON, KML or GPX.</p>
    <h3>2 · Sync the instrument clock</h3>
    <p><b>Menu → Instrument clock sync</b> before you start. This is what makes the later merge line up.</p>
    <h3>3 · Record</h3>
    <p>Press <b>Record</b> and walk. The banner shows how far you are off the line and which way to steer; walked sections turn green. <b>Keep this app open with the screen on</b> — phones stop giving GPS to web apps when locked or in the background. Carry the phone the same way throughout (in hand or a chest pocket works best).</p>
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
  if (!localStorage.getItem('sxyz.seen')) { localStorage.setItem('sxyz.seen', '1'); openHelp(); }
});
// Debug/testing handle.
window.sxyz = { S, settings, filter, sensors, map };
