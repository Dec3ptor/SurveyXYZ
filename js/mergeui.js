/* global L */
// UI for merging an instrument CSV log with the recorded GPS track.
import { S, map, layers, openSheet, pickFile, deliver, toast, esc } from './app.js';
import { parseCSV, guessTimeColumns, detectDateOrder, mergeReadings, mergedTable, mergedGeoJSON, toCSV } from './merge.js';
import { localStamp, safeName } from './exporters.js';

/** Instrument logs often start with a few metadata lines; the header is the first "full width" row. */
function findHeader(rows) {
  const widths = rows.slice(0, 60).map((r) => r.length);
  const counts = {};
  widths.forEach((w) => { counts[w] = (counts[w] || 0) + 1; });
  const modal = +Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  return Math.max(0, widths.findIndex((w) => w === modal));
}

export async function openMerge() {
  const body = openSheet('Merge instrument readings', `
    <p>Choose the CSV log exported from your gas monitor. Each reading is given the position you were at when it was taken, by matching its timestamp to the GPS track of <b>${esc(S.survey.name)}</b> (${S.points.length} fixes).</p>
    <div class="actions"><button class="btn primary" id="mPick">Choose CSV file</button></div>
    <div id="mForm"></div>`);
  body.querySelector('#mPick').onclick = async () => {
    const file = await pickFile('.csv,.txt,.tsv,text/csv,text/plain');
    if (!file) return;
    const rows = parseCSV(await file.text());
    if (rows.length < 2) return toast('That file has no rows I can read.');
    form(body.querySelector('#mForm'), rows, file.name);
  };
}

function form(el, rows, fileName) {
  let headerIdx = findHeader(rows);
  const render = () => {
    const header = rows[headerIdx].map((h, i) => h.trim() || `col${i + 1}`);
    const data = rows.slice(headerIdx + 1);
    const guess = guessTimeColumns(header);
    const samples = data.slice(0, 200).map((r) => (guess.dateCol >= 0 ? r[guess.dateCol] : '') || '');
    const order = detectDateOrder(samples);
    const opts = (sel, none) => (none ? `<option value="-1">${none}</option>` : '') + header.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h)}</option>`).join('');
    const valGuess = header.findIndex((h) => /ch4|methane|ppm|conc|reading|value|lel/i.test(h));
    el.innerHTML = `
      <h3>${esc(fileName)} · ${data.length} readings</h3>
      <div class="scroll-x"><table class="preview"><tr>${header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>
        ${data.slice(0, 3).map((r) => `<tr>${header.map((_, i) => `<td>${esc(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}</table></div>
      <label class="field">Header is on line<input id="mHead" type="number" min="1" max="${rows.length - 1}" value="${headerIdx + 1}"></label>
      <div class="two">
        <label class="field">Date (or date+time) column<select id="mDate">${opts(guess.dateCol, '(none — time only)')}</select></label>
        <label class="field">Time column<select id="mTime">${opts(guess.timeCol, '(same column)')}</select></label>
      </div>
      <div class="two">
        <label class="field">Date style<select id="mOrder"><option value="dmy">Day first (14/11/2026)</option><option value="mdy" ${order === 'mdy' ? 'selected' : ''}>Month first (11/14/2026)</option></select></label>
        <label class="field">Instrument clock is in<select id="mZone"><option value="local">This device's time zone</option><option value="utc">UTC</option></select></label>
      </div>
      <div class="two">
        <label class="field">Clock offset (s, added to instrument time)<input id="mOff" type="number" step="1" value="${S.survey.clockOffsetS ?? 0}"></label>
        <label class="field">Max GPS gap to bridge (s)<input id="mGap" type="number" min="1" value="30"></label>
      </div>
      <label class="field">Value to colour on the map<select id="mVal">${opts(valGuess, '(none)')}</select></label>
      <div class="actions"><button class="btn primary" id="mGo">Match readings to GPS</button></div>
      <div id="mOut"></div>`;
    const q = (s) => el.querySelector(s);
    q('#mHead').onchange = () => { headerIdx = Math.max(0, Math.min(rows.length - 2, (parseInt(q('#mHead').value, 10) || 1) - 1)); render(); };
    q('#mGo').onclick = () => run(q, header, data);
  };
  render();
}

function run(q, header, data) {
  const first = S.points[0];
  const fd = new Date(first ? first.t : Date.now());
  const opts = {
    dateCol: +q('#mDate').value, timeCol: +q('#mTime').value, order: q('#mOrder').value, zone: q('#mZone').value,
    offsetS: Number(q('#mOff').value) || 0, maxGapS: Number(q('#mGap').value) || 30,
    fallbackDate: { y: fd.getFullYear(), m: fd.getMonth() + 1, d: fd.getDate() },
  };
  const merged = mergeReadings(data, S.points, opts);
  const times = merged.rows.map((r) => r.t).filter(Number.isFinite);
  const span = (a, b) => `${localStamp(a)} → ${localStamp(b).slice(11)}`;
  const tMin = times.reduce((m, t) => Math.min(m, t), Infinity), tMax = times.reduce((m, t) => Math.max(m, t), -Infinity);
  const out = q('#mOut');
  const ok = merged.matched > 0;
  out.innerHTML = `<div class="result">
      <b>${merged.matched} of ${merged.total} readings placed.</b>
      ${merged.badTime ? `<br>${merged.badTime} rows had no readable time (check the columns above).` : ''}
      ${merged.total - merged.matched - merged.badTime ? `<br>${merged.total - merged.matched - merged.badTime} fell outside GPS coverage (more than ${opts.maxGapS} s from any fix).` : ''}
      <br><span class="muted">Readings: ${times.length ? span(tMin, tMax) : 'no valid times'}<br>GPS track: ${S.points.length ? span(S.points[0].t, S.points[S.points.length - 1].t) : 'nothing recorded'}</span>
      ${!ok && times.length && S.points.length ? '<br>The two time ranges do not overlap — check the date style, time zone and clock offset.' : ''}
    </div>
    ${ok ? `<div class="actions"><button class="btn primary" id="mCsv">Save CSV</button><button class="btn primary" id="mGeo">Save GeoJSON</button></div>
    <div class="actions"><button class="btn" id="mMap">Show on map</button></div>` : ''}`;
  if (!ok) return;
  const name = safeName(S.survey.name) + '_readings';
  q('#mCsv').onclick = () => deliver(new Blob([toCSV(mergedTable(header, merged))], { type: 'text/csv' }), name + '.csv');
  q('#mGeo').onclick = () => deliver(new Blob([JSON.stringify(mergedGeoJSON(header, merged))], { type: 'application/geo+json' }), name + '.geojson');
  q('#mMap').onclick = () => showOnMap(header, merged, +q('#mVal').value);
  out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

const RAMP = ['#2c7bb6', '#abd9e9', '#ffffbf', '#fdae61', '#d7191c'];
function showOnMap(header, merged, valCol) {
  layers.readings.clearLayers();
  const placed = merged.rows.filter((r) => r.pos);
  const vals = valCol >= 0 ? placed.map((r) => parseFloat(r.cells[valCol])).filter(Number.isFinite).sort((a, b) => a - b) : [];
  // Quantile breaks so a few very high readings do not wash out everything else.
  const breaks = [0.2, 0.4, 0.6, 0.8].map((f) => vals[Math.floor(f * (vals.length - 1))]);
  const pts = [];
  for (const r of placed) {
    const v = valCol >= 0 ? parseFloat(r.cells[valCol]) : NaN;
    const color = Number.isFinite(v) ? RAMP[breaks.filter((b) => v > b).length] : '#ffd400';
    pts.push([r.pos.lat, r.pos.lon]);
    L.circleMarker([r.pos.lat, r.pos.lon], { radius: 6, color: '#000', weight: 1, fillColor: color, fillOpacity: 0.95 })
      .bindPopup(header.map((h, i) => `<b>${esc(h)}</b>: ${esc(r.cells[i] ?? '')}`).join('<br>') + `<br><span style="color:#666">${esc(r.pos.match)}, ±${Math.round(r.pos.acc ?? 0)} m</span>`)
      .addTo(layers.readings);
  }
  if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.2), { maxZoom: 20 });
  toast(`${pts.length} readings on the map${vals.length ? ` — blue (low) to red (high) by ${header[valCol]}` : ''}. Tap one for details.`, 6000);
}
