// Contaminated-land sampling: sample form, sampling point sheet and lists.
import * as db from './db.js';
import { S, settings, map, openSheet, closeSheet, toast, esc, saveSurvey, saveObs, deleteObs, drawPlan, refreshGuide,
  currentSpot, currentTarget, addPoint, photoEditor, fmtDist } from './app.js';
import { SAMPLE_FIELDS } from './modes.js';
import { haversine, LocalFrame } from './geo.js';
import { localStamp, samplesOnly } from './exporters.js';

const samplesAt = (id) => samplesOnly(S.obs).filter((o) => o.pointId === id);
const fieldOptions = (f) => (f.options === 'analytes' ? settings.analytes.split(',').map((s) => s.trim()).filter(Boolean) : f.options);
const refresh = () => { saveSurvey(); drawPlan(); refreshGuide(); };

/** Sample ID suggestion. Field duplicates and blanks get a neutral running number so the lab cannot pair them up. */
function suggestId(pointId, type, depthFrom) {
  const all = samplesOnly(S.obs);
  const run = (pre) => pre + String(all.filter((o) => (o.data.sampleId || '').startsWith(pre)).length + 1).padStart(2, '0');
  if (/Duplicate|Triplicate/.test(type)) return run('QC');
  if (/Rinsate/.test(type)) return run('RB');
  if (/Trip/.test(type)) return run('TB');
  return `${pointId}_${depthFrom === '' || depthFrom == null ? '0.0' : Number(depthFrom).toFixed(1)}`;
}

/** Sample button: pick the planned point you are standing at, or offer an unplanned one. */
export function startSample() {
  const spot = currentSpot();
  const pts = S.survey.plan.points;
  const near = (p) => haversine(spot.lat, spot.lon, p.lat, p.lon);
  const reach = Math.max(15, 3 * settings.arrive);
  const tgt = currentTarget();
  let pt = tgt && near(tgt) <= reach ? tgt : pts.filter((p) => near(p) <= reach).sort((a, b) => near(a) - near(b))[0];
  if (!pt) {
    const where = spot.from === 'map' ? 'the map centre (no GPS fix)' : 'your position';
    if (!confirm(`No planned sampling point within ${reach} m of ${where}.\n\nAdd an unplanned (targeted) location here and sample it?`)) return;
    pt = addPoint(spot.lat, spot.lon, 'targeted');
    refresh();
  }
  openSample(pt, null, null, spot);
}

/**
 * Sample form. pt: the sampling point (for a new sample); existing: a saved
 * sample to edit; carry: the sample just saved, when logging the next depth.
 */
export function openSample(pt, existing, carry, spot) {
  pt = pt || S.survey.plan.points.find((p) => p.id === existing?.pointId) || null;
  const last = S.survey.lastSample || {};
  const data = existing ? { ...existing.data } : {};
  if (!existing) {
    for (const f of SAMPLE_FIELDS) data[f.key] = f.sticky ? (last[f.key] ?? f.def ?? (f.type === 'multi' ? [] : '')) : f.def ?? (f.type === 'multi' ? [] : '');
    if (carry) {
      Object.assign(data, { method: carry.data.method, stratum: carry.data.stratum });
      data.depthFrom = carry.data.depthTo ?? '';
    } else data.depthFrom = '';
    data.depthTo = '';
    data.sampleId = '';
  }
  const o = existing ? { ...existing, photoIds: [...(existing.photoIds || [])] }
    : { id: db.uid(), surveyId: S.survey.id, kind: 'sample', t: Date.now(), ...(carry ? { lat: carry.lat, lon: carry.lon, acc: carry.acc, from: carry.from } : spot || currentSpot()), pointId: pt.id, note: '', photoIds: [] };
  let idTouched = !!existing, photos;

  const chips = (f) => {
    const sel = f.type === 'multi' ? data[f.key] || [] : [data[f.key]];
    const options = [...fieldOptions(f)];
    for (const v of sel) if (v && !options.includes(v)) options.push(v);
    return `<div class="field"><span>${esc(f.label)}</span><div class="chips" data-k="${f.key}" data-t="${f.type}">${options.map((x) => `<button data-v="${esc(x)}" class="${sel.includes(x) ? 'on' : ''}">${esc(x)}</button>`).join('')}</div></div>`;
  };
  const input = (f) => `<label class="field">${esc(f.label)}<input data-k="${f.key}" ${f.type === 'number' ? 'type="number" inputmode="decimal" step="any"' : ''} value="${esc(data[f.key] ?? '')}" placeholder="${esc(f.placeholder || '')}"></label>`;
  const offset = pt ? haversine(o.lat, o.lon, pt.plat ?? pt.lat, pt.plon ?? pt.lon) : null;

  const body = openSheet(existing ? `Sample ${data.sampleId || ''}` : `Sample at ${pt.id}`, `
    <p class="muted">${localStamp(o.t)} · ${o.lat.toFixed(6)}, ${o.lon.toFixed(6)} · ${o.from === 'map' || o.acc == null ? 'placed on map' : `GPS ±${Math.round(o.acc)} m`}${offset != null && !existing ? ` · ${offset.toFixed(1)} m from the planned position` : ''}</p>
    <div class="two">
      <label class="field">Depth from (m)<input id="sFrom" type="number" inputmode="decimal" step="0.05" min="0" value="${data.depthFrom ?? ''}"></label>
      <label class="field">Depth to (m)<input id="sTo" type="number" inputmode="decimal" step="0.05" min="0" value="${data.depthTo ?? ''}"></label>
    </div>
    ${chips(SAMPLE_FIELDS[0])}
    <label class="field">Sample ID (as written on the jar)<input id="sId" value="${esc(data.sampleId)}" autocapitalize="characters"></label>
    <div id="sPhotos"></div>
    ${SAMPLE_FIELDS.slice(1).map((f) => (f.type === 'chips' || f.type === 'multi' ? chips(f) : input(f))).join('')}
    <label class="field">Notes<textarea id="sNote" placeholder="Fill description, inclusions, refusal depth, groundwater…">${esc(o.note)}</textarea></label>
    <div class="actions">
      ${existing ? '<button class="btn danger" id="sDel">Delete</button>' : '<button class="btn" id="sNext">Save + next depth</button>'}
      <button class="btn primary" id="sSave">Save</button>
    </div>`, () => photos.dispose());
  const q = (s) => body.querySelector(s);
  photos = photoEditor(q('#sPhotos'), o);

  const autoId = () => { if (!idTouched) q('#sId').value = suggestId(o.pointId, data.type, q('#sFrom').value); };
  autoId();
  q('#sId').oninput = () => { idTouched = true; };
  q('#sFrom').oninput = autoId;
  body.querySelectorAll('.chips[data-k]').forEach((el) => {
    el.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const k = el.dataset.k, v = b.dataset.v;
      if (el.dataset.t === 'multi') {
        const set = new Set(data[k] || []);
        if (set.has(v)) set.delete(v); else set.add(v);
        data[k] = [...set];
      } else data[k] = data[k] === v ? '' : v;
      const sel = el.dataset.t === 'multi' ? data[k] : [data[k]];
      el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', sel.includes(x.dataset.v)));
      if (k === 'type') autoId();
    };
  });

  const save = async (next) => {
    const num = (s) => (q(s).value === '' ? null : Number(q(s).value));
    data.depthFrom = num('#sFrom'); data.depthTo = num('#sTo');
    if (data.depthFrom != null && data.depthTo != null && data.depthTo < data.depthFrom) return toast('“Depth to” is shallower than “depth from”.');
    data.sampleId = q('#sId').value.trim();
    const logOnly = /No sample/.test(data.type);
    if (!data.sampleId && !logOnly) return toast('Give the sample an ID.');
    const clash = samplesOnly(S.obs).find((x) => x.id !== o.id && x.data.sampleId && x.data.sampleId === data.sampleId);
    if (clash && !confirm(`Sample ID “${data.sampleId}” is already used at ${clash.pointId}. Sample IDs should be unique. Save anyway?`)) return;
    body.querySelectorAll('input[data-k]').forEach((el) => { data[el.dataset.k] = el.type === 'number' ? (el.value === '' ? null : Number(el.value)) : el.value.trim(); });
    o.note = q('#sNote').value.trim();
    o.data = data;
    o.category = data.type;
    await photos.save();
    if (existing) Object.assign(existing, o);
    const saved = existing || o;
    await saveObs(saved);
    S.survey.lastSample = Object.fromEntries(SAMPLE_FIELDS.filter((f) => f.sticky).map((f) => [f.key, data[f.key]]));
    if (pt && !existing) {
      if (pt.status !== 'done') {
        // Keep the planned position; the point moves to where the sample was really taken.
        if (pt.plat == null) { pt.plat = pt.lat; pt.plon = pt.lon; }
        pt.lat = o.lat; pt.lon = o.lon;
      }
      pt.status = 'done'; delete pt.why;
      if (S.survey.plan.target === pt.id) S.survey.plan.target = null;
    }
    refresh();
    closeSheet();
    if (next) return openSample(pt, null, saved);
    const tgt = currentTarget();
    toast(`${data.sampleId || 'Log'} saved.${!existing && tgt ? ` Next: ${tgt.id}.` : ''}`);
  };
  q('#sSave').onclick = () => save(false);
  if (!existing) q('#sNext').onclick = () => save(true);
  else q('#sDel').onclick = async () => {
    if (!confirm(`Delete sample ${data.sampleId} and its photos?`)) return;
    await deleteObs(existing);
    if (pt && !samplesAt(pt.id).length) pt.status = 'todo';
    refresh(); closeSheet();
  };
}

const areaName = (pt) => S.survey.plan.areas.find((a) => a.id === pt.area)?.name;
const KIND = { grid: 'Systematic grid', random: 'Random', targeted: 'Targeted', stepout: 'Step-out', imported: 'Imported' };
const statusText = (pt) => (pt.status === 'done' ? 'Sampled' : pt.status === 'skipped' ? `Not sampled${pt.why ? ': ' + pt.why : ''}` : 'To do');

/** Details and actions for one sampling point. */
export function openPoint(pt) {
  const taken = samplesAt(pt.id);
  const d = S.est ? haversine(S.est.lat, S.est.lon, pt.lat, pt.lon) : null;
  const b = openSheet(`Point ${pt.id}`, `
    <p>${esc(KIND[pt.kind] || pt.kind)} point${areaName(pt) ? ` in ${esc(areaName(pt))}` : ''} <span class="badge ${pt.status}">${esc(statusText(pt))}</span></p>
    <p class="muted">${pt.lat.toFixed(6)}, ${pt.lon.toFixed(6)}${d != null ? ` · ${fmtDist(d)} from you` : ''}${pt.plat != null ? ` · sampled ${haversine(pt.lat, pt.lon, pt.plat, pt.plon).toFixed(1)} m from the planned position` : ''}</p>
    ${taken.length ? `<h3>Samples here</h3><div class="list">${taken.map((o) => `<button class="btn" data-o="${o.id}"><span>${esc(o.data.sampleId || '(log only)')} <small>${esc(o.data.type || '')} · ${o.data.depthFrom ?? '?'}–${o.data.depthTo ?? '?'} m · ${localStamp(o.t).slice(11, 16)}</small></span></button>`).join('')}</div>` : ''}
    <h3>Actions</h3>
    <div class="list">
      <button class="btn primary" data-a="sample">${taken.length ? 'Add another sample here' : 'Sample here'}</button>
      ${pt.status !== 'done' ? '<button class="btn" data-a="go">Navigate to this point</button>' : ''}
      ${pt.status === 'todo' ? '<button class="btn" data-a="skip">Mark as not sampled<small>Obstruction, refusal, no access…</small></button>' : ''}
      ${pt.status === 'skipped' ? '<button class="btn" data-a="todo">Put back on the to-do list</button>' : ''}
      ${pt.status !== 'done' ? '<button class="btn" data-a="move">Move to the map crosshair<small>Pan the map first; use when the planned spot cannot be reached</small></button>' : ''}
      <button class="btn" data-a="step">Add step-out points around it<small>Four points N, E, S, W to delineate a result</small></button>
      <button class="btn danger" data-a="del">Delete point</button>
    </div>`, () => { document.getElementById('crosshair').hidden = !S.planShape; });
  document.getElementById('crosshair').hidden = false;
  b.onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const o = S.obs.find((x) => x.id === btn.dataset.o);
    if (o) return openSample(pt, o);
    const a = btn.dataset.a;
    if (!a) return;
    if (a === 'sample') {
      const spot = currentSpot();
      const far = haversine(spot.lat, spot.lon, pt.lat, pt.lon);
      if (far > Math.max(15, 3 * settings.arrive) && !confirm(`You appear to be ${fmtDist(far)} from ${pt.id}. The sample will be recorded at your current position. Continue?`)) return;
      return openSample(pt, null, null, spot);
    }
    if (a === 'go') { S.survey.plan.target = pt.id; toast(`Heading for ${pt.id}.`); }
    if (a === 'skip') {
      const why = prompt(`Why was ${pt.id} not sampled?`, 'Obstruction');
      if (why == null) return;
      pt.status = 'skipped'; pt.why = why.trim();
    }
    if (a === 'todo') { pt.status = 'todo'; delete pt.why; }
    if (a === 'move') {
      const c = map.getCenter();
      if (pt.plat == null) { pt.plat = pt.lat; pt.plon = pt.lon; }
      pt.lat = c.lat; pt.lon = c.lng;
      toast(`${pt.id} moved ${haversine(pt.lat, pt.lon, pt.plat, pt.plon).toFixed(1)} m from its planned position.`);
    }
    if (a === 'step') {
      const dist = parseFloat(prompt('Step-out distance in metres', String(Math.max(1, Math.round((S.survey.plan.spacing || 10) / 2)))));
      if (!(dist > 0)) return;
      const f = new LocalFrame(pt.lat, pt.lon);
      for (const [name, x, y] of [['N', 0, 1], ['E', 1, 0], ['S', 0, -1], ['W', -1, 0]]) addPoint(...f.toLL(x * dist, y * dist), 'stepout', `${pt.id}-${name}`);
      toast(`Four step-out points added ${dist} m from ${pt.id}.`);
    }
    if (a === 'del') {
      if (!confirm(`Delete point ${pt.id}?${taken.length ? ` Its ${taken.length} sample record(s) are kept in the sample register.` : ''}`)) return;
      S.survey.plan.points = S.survey.plan.points.filter((p) => p !== pt);
    }
    refresh(); closeSheet();
  };
}

/** All sampling points with status; tap one for its sheet. */
export function openPointList() {
  const pts = S.survey.plan.points;
  const tgt = currentTarget();
  const d = (p) => (S.est ? haversine(S.est.lat, S.est.lon, p.lat, p.lon) : null);
  const done = pts.filter((p) => p.status === 'done').length, skipped = pts.filter((p) => p.status === 'skipped').length;
  const b = openSheet('Sampling points', pts.length ? `
    <p class="muted">${done} sampled · ${skipped} not sampled · ${pts.length - done - skipped} to do. The arrow leads to the highlighted point; by default that is the next one in plan order.</p>
    <div class="actions"><button class="btn primary" id="pNear">Go to the nearest unsampled point</button></div>
    <h3>All points</h3>
    <div class="list">${pts.map((p) => `<button class="btn" data-id="${esc(p.id)}"><span><b>${esc(p.id)}</b>${p === tgt ? ' <span class="badge">heading here</span>' : ''}<span class="badge ${p.status}">${esc(statusText(p))}</span>
      <small>${esc(areaName(p) || KIND[p.kind] || p.kind)}${d(p) != null ? ' · ' + fmtDist(d(p)) : ''}${samplesAt(p.id).length ? ` · ${samplesAt(p.id).length} sample(s)` : ''}</small></span></button>`).join('')}</div>`
    : '<p class="muted">No sampling points yet. Tap <b>Plan</b> and draw the site: it fills with a sampling grid you can adjust, and you can add focus areas and targeted points. Or just tap <b>Sample</b> where you stand to log an unplanned location.</p>');
  if (!pts.length) return;
  b.querySelector('#pNear').onclick = () => {
    if (!S.est) return toast('No GPS fix yet.');
    const todo = pts.filter((p) => p.status === 'todo').sort((a, c) => d(a) - d(c))[0];
    if (!todo) return toast('Every point has been visited.');
    S.survey.plan.target = todo.id; refresh(); closeSheet();
    toast(`Heading for ${todo.id}, ${fmtDist(d(todo))} away.`);
  };
  b.querySelector('.list').onclick = (e) => {
    const p = pts.find((x) => x.id === e.target.closest('button')?.dataset.id);
    if (p) { map.setView([p.lat, p.lon], Math.max(map.getZoom(), 19)); openPoint(p); }
  };
}

export function openSamplesList() {
  const list = samplesOnly(S.obs);
  const b = openSheet('Samples', list.length ? `<div class="list">${list.map((o) => `<button class="btn" data-id="${o.id}"><span><b>${esc(o.data.sampleId || '(log only)')}</b> · ${esc(o.pointId || '')}
    <small>${esc(o.data.type || '')} · ${o.data.depthFrom ?? '?'}–${o.data.depthTo ?? '?'} m · ${localStamp(o.t).slice(5, 16)}${(o.data.analytes || []).length ? ' · ' + esc(o.data.analytes.join(', ')) : ''}</small></span></button>`).join('')}</div>`
    : '<p class="muted">No samples logged yet.</p>');
  b.onclick = (e) => {
    const o = list.find((x) => x.id === e.target.closest('button')?.dataset.id);
    if (o) openSample(null, o);
  };
}
