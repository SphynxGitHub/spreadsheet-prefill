/* global JFCustomWidget */
let SETTINGS = {};
let rows = [];
let headers = [];
let selected = null;

// mapping = [{ source, target, required, transform }]
let mapping = [];

const $ = id => document.getElementById(id);
const els = {
  csvUrl: $('csvUrl'),
  keyInput: $('keyInput'),
  searchBtn: $('searchBtn'),
  reloadBtn: $('reloadBtn'),
  list: $('list'),
  details: $('details'),
  useBtn: $('useBtn'),
  keyCol: $('keyCol'),
  showCols: $('showCols'),
  msg: $('msg'),
  addMap: $('addMap'),
  autoMap: $('autoMap'),
  importMap: $('importMap'),
  exportMap: $('exportMap'),
  mapBody: $('mapBody'),
  mapTable: $('mapTable'),
  mapStatus: $('mapStatus'),
};

function msg(text, ok=false) {
  els.msg.className = 'msg ' + (ok ? 'ok' : 'err');
  els.msg.textContent = text || '';
  if (!text) els.msg.className = 'msg';
}

function ok(text) { msg(text, true); }

async function fetchCsv(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const csv = await res.text();
  return parseCsv(csv);
}

function parseCsv(csv) {
  const out = [];
  let i = 0, field = '', row = [], inQ = false;
  function pushField(){ row.push(field); field=''; }
  function pushRow(){ out.push(row); row=[]; }
  while (i < csv.length) {
    const c = csv[i++];
    if (inQ) {
      if (c === '"') {
        if (csv[i] === '"'){ field += '"'; i++; } else { inQ = false; }
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') pushField();
      else if (c === '\n') { pushField(); pushRow(); }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length){ pushField(); pushRow(); }

  const hdr = out.shift() || [];
  const objs = out.map(r => {
    const o = {};
    hdr.forEach((h, idx) => o[h] = r[idx] ?? '');
    return o;
  });
  return { headers: hdr, rows: objs };
}

function normalizeKey(s){ return String(s || '').toLowerCase().trim(); }

function renderList() {
  const keyField = els.keyCol.value || headers[0] || '';
  const show = getSelectedShowColumns();
  els.list.innerHTML = '';

  const hr = document.createElement('div');
  hr.className = 'row';
  hr.innerHTML = `<div><b>${escapeHtml(keyField)}</b></div><div class="mini">(${rows.length} rows)</div>`;
  hr.style.cursor='default';
  els.list.appendChild(hr);

  rows.forEach(r => {
    const keyVal = String(r[keyField] ?? '').trim();
    const sub = show.length ? show.map(h => r[h]).filter(Boolean).join(' • ') : '';
    const div = document.createElement('div');
    div.className = 'row';
    div.innerHTML = `<div><div>${escapeHtml(keyVal || '(empty key)')}</div><div class="mini">${escapeHtml(sub)}</div></div><div class="pill">select</div>`;
    div.addEventListener('click', () => selectRow(r));
    els.list.appendChild(div);
  });
}

function selectRow(r) {
  selected = r;
  els.useBtn.disabled = false;
  renderDetails();
}

function renderDetails() {
  if (!selected) { els.details.style.display = 'none'; return; }
  els.details.style.display = '';

  const kv = Object.entries(selected).map(([k,v]) => (
    `<div class="kv"><div class="mini">${escapeHtml(k)}</div><div>${escapeHtml(v||'')}</div></div>`
  )).join('');

  const mappedObj = buildMapped(selected, mapping);
  const mkv = Object.entries(mappedObj).map(([k,v]) => (
    `<div class="kv"><div class="mini">${escapeHtml(k)}</div><div>${escapeHtml(v||'')}</div></div>`
  )).join('') || '<div class="mini">(no mapping defined yet)</div>';

  els.details.innerHTML = `
    <div class="mini">Selected Row</div>
    ${kv}
    <div style="height:10px"></div>
    <div class="mini">Mapped Preview</div>
    ${mkv}
  `;
}

function getSelectedShowColumns(){
  return Array.from(els.showCols.selectedOptions).map(o => o.value);
}

function fillHeaderSelectors() {
  els.keyCol.innerHTML = headers.map(h => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join('');
  const guess = headers.find(h => /email|id|code|key/i.test(h)) || headers[0] || '';
  els.keyCol.value = guess;

  els.showCols.innerHTML = headers.map(h => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join('');
  const defaults = headers.filter(h => /name|email|phone|status/i.test(h)).slice(0,3);
  Array.from(els.showCols.options).forEach(o => { o.selected = defaults.includes(o.value); });
  els.showCols.size = Math.min(6, Math.max(3, headers.length));
}

async function loadCsv(andSearch=false) {
  try {
    msg('');
    const url = (els.csvUrl.value || '').trim();
    if (!url) { msg('Enter a live CSV URL.'); return; }
    const { headers: hdrs, rows: rs } = await fetchCsv(url);
    headers = hdrs;
    rows = rs;
    if (!headers.length) { msg('No headers found in CSV.'); return; }
    fillHeaderSelectors();
    loadMappingForUrl(url); // hydrate mapping based on this URL
    renderMapping();
    if (andSearch && els.keyInput.value.trim()) {
      doSearch();
    } else {
      renderList();
    }
  } catch (e) {
    msg(`Load failed: ${e.message || e}`, false);
  }
}

function doSearch() {
  const keyField = els.keyCol.value;
  const q = els.keyInput.value.trim();
  if (!keyField) { msg('Choose a Key Column.'); return; }
  const exact = rows.find(r => normalizeKey(r[keyField]) === normalizeKey(q));
  if (exact) {
    selectRow(exact);
    rows = [exact, ...rows.filter(r => r !== exact)];
  } else {
    const list = rows.filter(r => normalizeKey(r[keyField]).includes(normalizeKey(q)));
    if (!list.length) { msg('No matches. Showing all rows.'); }
    rows = list.length ? list : rows;
  }
  renderList();
}

function sendToForm() {
  if (!selected) { msg('Pick a row first.'); return; }
  const mappedObj = buildMapped(selected, mapping);
  const reqMissing = requiredMissing(selected, mapping);
  if (reqMissing.length) {
    msg(`Required mapping missing data: ${reqMissing.join(', ')}`); return;
  }
  const payload = {
    spreadsheet: selected,
    mapped: mappedObj,
    mapping,
    meta: { sourceUrl: (els.csvUrl.value||'').trim(), timestamp: Date.now() }
  };
  try {
    JFCustomWidget.sendData({ value: JSON.stringify(payload) });
    ok('Row sent to form. Use Conditions to copy values from "mapped.*" into your fields.');
  } catch (_) {}
}

/* ========== Mapping ========== */
const TRANSFORMS = ['none','trim','lowercase','uppercase','titlecase'];

function titleCase(s){
  return String(s||'').toLowerCase().replace(/\b([a-z])/g, (m,c)=>c.toUpperCase());
}

function applyTransform(v, t){
  const s = String(v ?? '');
  switch (t){
    case 'trim': return s.trim();
    case 'lowercase': return s.toLowerCase();
    case 'uppercase': return s.toUpperCase();
    case 'titlecase': return titleCase(s);
    default: return s;
  }
}

function buildMapped(row, mapArr){
  const out = {};
  for (const m of mapArr){
    if (!m || !m.source || !m.target) continue;
    const raw = row[m.source];
    out[m.target] = applyTransform(raw, m.transform || 'none');
  }
  return out;
}

function requiredMissing(row, mapArr){
  const miss = [];
  for (const m of mapArr){
    if (m.required && (!row[m.source] || String(row[m.source]).trim() === '')) {
      miss.push(m.target || m.source);
    }
  }
  return miss;
}

function renderMapping(){
  els.mapBody.innerHTML = '';
  mapping.forEach((m, idx)=>{
    const tr = document.createElement('tr');

    // Source select
    const tdSource = document.createElement('td');
    const sel = document.createElement('select');
    sel.innerHTML = headers.map(h => `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`).join('');
    if (!headers.includes(m.source)) m.source = headers[0] || '';
    sel.value = m.source;
    sel.addEventListener('change', ()=>{ m.source = sel.value; persistMapping(); renderDetails(); });
    tdSource.appendChild(sel);

    // Target input
    const tdTarget = document.createElement('td');
    const t = document.createElement('input');
    t.type = 'text'; t.placeholder = 'Target name (for Jotform Conditions)';
    t.value = m.target || '';
    t.addEventListener('input', ()=>{ m.target = t.value; persistMapping(); renderDetails(); });
    tdTarget.appendChild(t);

    // Transform select
    const tdX = document.createElement('td');
    const ts = document.createElement('select');
    ts.innerHTML = TRANSFORMS.map(x=>`<option value="${x}">${x}</option>`).join('');
    ts.value = m.transform || 'none';
    ts.addEventListener('change', ()=>{ m.transform = ts.value; persistMapping(); renderDetails(); });
    tdX.appendChild(ts);

    // Required checkbox
    const tdReq = document.createElement('td');
    const c = document.createElement('input'); c.type='checkbox'; c.checked = !!m.required;
    c.addEventListener('change', ()=>{ m.required = c.checked; persistMapping(); });
    tdReq.appendChild(c);

    // Remove
    const tdDel = document.createElement('td');
    const del = document.createElement('button'); del.textContent = 'Delete'; del.className='danger';
    del.addEventListener('click', ()=>{ mapping.splice(idx,1); persistMapping(); renderMapping(); renderDetails(); });
    tdDel.appendChild(del);

    tr.appendChild(tdSource); tr.appendChild(tdTarget); tr.appendChild(tdX); tr.appendChild(tdReq); tr.appendChild(tdDel);
    els.mapBody.appendChild(tr);
  });

  // status
  els.mapStatus.textContent = mapping.length ? `${mapping.length} mapping${mapping.length>1?'s':''}` : 'No mappings yet';
}

function addMappingRow(){
  const guess = headers.find(h => /email|name|phone/i.test(h)) || headers[0] || '';
  mapping.push({ source: guess, target: guess, required:false, transform:'none' });
  persistMapping();
  renderMapping();
  renderDetails();
}

function autoMap(){
  if (!headers.length) return;
  const guesses = [
    { rx:/^email/i, target:'Client Email' },
    { rx:/^full\s*name|^name$/i, target:'Client Name' },
    { rx:/^first/i, target:'First Name' },
    { rx:/^last/i, target:'Last Name' },
    { rx:/phone|mobile|cell/i, target:'Phone' },
    { rx:/company|employer/i, target:'Company' },
    { rx:/address/i, target:'Address' }
  ];
  const newMaps = [];
  for (const h of headers){
    const g = guesses.find(g => g.rx.test(h));
    if (g) newMaps.push({ source:h, target:g.target, required:false, transform:'none' });
  }
  if (!newMaps.length){ msg('No obvious matches to auto-map.'); return; }
  // merge without duplicating targets
  const existingTargets = new Set(mapping.map(m=>m.target));
  for (const m of newMaps){ if (!existingTargets.has(m.target)) mapping.push(m); }
  persistMapping();
  renderMapping();
  renderDetails();
  ok('Auto-mapped likely fields.');
}

function exportMapping(){
  const blob = new Blob([JSON.stringify(mapping, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'mapping.json';
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 0);
}

function importMapping(){
  const inp = document.createElement('input'); inp.type='file'; inp.accept='application/json';
  inp.addEventListener('change', async ()=>{
    const f = inp.files?.[0]; if (!f) return;
    try {
      const text = await f.text();
      const arr = JSON.parse(text);
      if (!Array.isArray(arr)) throw new Error('JSON must be an array');
      // sanitize
      mapping = arr.map(m => ({
        source: String(m.source || ''),
        target: String(m.target || ''),
        required: !!m.required,
        transform: TRANSFORMS.includes(m.transform) ? m.transform : 'none'
      })).filter(m => m.source && m.target);
      persistMapping();
      renderMapping();
      renderDetails();
      ok('Mapping imported.');
    } catch (e){
      msg(`Import failed: ${e.message || e}`);
    }
  });
  inp.click();
}

function persistMapping(){
  const key = mapStorageKey((els.csvUrl.value||'').trim());
  if (key) {
    try { localStorage.setItem(key, JSON.stringify(mapping)); } catch(_) {}
  }
}

function loadMappingForUrl(url){
  // Preference: widget setting MappingJSON, else localStorage per URL
  const fromSettings = (SETTINGS.MappingJSON || '').trim();
  if (fromSettings) {
    try {
      const arr = JSON.parse(fromSettings);
      if (Array.isArray(arr)) { mapping = sanitizeMapping(arr); return; }
    } catch(_) {}
  }
  const key = mapStorageKey(url);
  let arr = [];
  try {
    arr = JSON.parse(localStorage.getItem(key) || '[]');
  } catch(_) {}
  mapping = sanitizeMapping(arr);
}

function sanitizeMapping(arr){
  return (Array.isArray(arr) ? arr : []).map(m => ({
    source: headers.includes(m.source) ? m.source : (headers[0] || ''),
    target: String(m.target || ''),
    required: !!m.required,
    transform: TRANSFORMS.includes(m.transform) ? m.transform : 'none'
  })).filter(m => m.source && m.target);
}

function mapStorageKey(url){
  if (!url) return null;
  try { return 'map::' + btoa(url); } catch(_) { return 'map::' + encodeURIComponent(url); }
}

function wire() {
  els.reloadBtn.addEventListener('click', () => loadCsv(false));
  els.searchBtn.addEventListener('click', () => doSearch());
  els.keyCol.addEventListener('change', () => renderList());
  els.showCols.addEventListener('change', () => renderList());
  els.useBtn.addEventListener('click', () => sendToForm());

  els.addMap.addEventListener('click', addMappingRow);
  els.autoMap.addEventListener('click', autoMap);
  els.exportMap.addEventListener('click', exportMapping);
  els.importMap.addEventListener('click', importMapping);
}

/* ========== Jotform lifecycle ========== */
JFCustomWidget.subscribe('ready', function(formData){
  SETTINGS = JFCustomWidget.getWidgetSettings() || {};
  const presetUrl = SETTINGS.DataUrl || '';
  const presetKey = SETTINGS.KeyColumn || '';
  if (presetUrl) els.csvUrl.value = presetUrl;
  wire();
  if (presetUrl) {
    loadCsv(true).then(() => {
      if (presetKey && headers.includes(presetKey)) {
        els.keyCol.value = presetKey;
        renderList();
      }
    });
  }
});

JFCustomWidget.subscribe('submit', function(){
  const mappedObj = selected ? buildMapped(selected, mapping) : {};
  const reqMissing = selected ? requiredMissing(selected, mapping) : [];
  const valid = !!selected && reqMissing.length === 0;
  const value = JSON.stringify({
    spreadsheet: selected || null,
    mapped: mappedObj,
    mapping,
    meta: { sourceUrl: (els.csvUrl.value||'').trim(), timestamp: Date.now() }
  });
  JFCustomWidget.sendSubmit({ valid, value });
});

/* ========== helpers ========== */
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
