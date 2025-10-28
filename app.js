/* global JFCustomWidget */
let SETTINGS = {};
let rows = [];       // array of objects keyed by header
let headers = [];    // column headers
let selected = null; // currently selected row

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
  msg: $('msg')
};

function msg(text, ok=false) {
  els.msg.className = 'msg ' + (ok ? 'ok' : 'err');
  els.msg.textContent = text || '';
  if (!text) els.msg.className = 'msg';
}

async function fetchCsv(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const csv = await res.text();
  return parseCsv(csv);
}

function parseCsv(csv) {
  // very light CSV parser supporting quotes
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
      else if (c === '\r') {/* ignore */}
      else field += c;
    }
  }
  // flush
  if (field.length || row.length){ pushField(); pushRow(); }

  const hdr = out.shift() || [];
  const objs = out.map(r => {
    const o = {};
    hdr.forEach((h, idx) => o[h] = r[idx] ?? '');
    return o;
  });
  return { headers: hdr, rows: objs };
}

function renderList() {
  const keyField = els.keyCol.value || headers[0] || '';
  const show = getSelectedShowColumns();
  els.list.innerHTML = '';

  // header row
  const hr = document.createElement('div');
  hr.className = 'row';
  hr.innerHTML = `<div><b>${keyField}</b></div><div class="mini">(${rows.length} rows)</div>`;
  hr.style.cursor='default';
  els.list.appendChild(hr);

  rows.forEach(r => {
    const keyVal = String(r[keyField] ?? '').trim();
    const sub = show.length ? show.map(h => r[h]).filter(Boolean).join(' • ') : '';
    const div = document.createElement('div');
    div.className = 'row';
    div.innerHTML = `<div><div>${keyVal || '(empty key)'}</div><div class="mini">${sub}</div></div><div class="pill">select</div>`;
    div.addEventListener('click', () => selectRow(r));
    els.list.appendChild(div);
  });
}

function selectRow(r) {
  selected = r;
  els.useBtn.disabled = false;
  els.details.style.display = '';
  const kv = Object.entries(r).map(([k,v]) => `<div class="kv"><div class="mini">${escapeHtml(k)}</div><div>${escapeHtml(v||'')}</div></div>`).join('');
  els.details.innerHTML = `<div class="mini">Selected Row</div>${kv}`;
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function getSelectedShowColumns(){
  return Array.from(els.showCols.selectedOptions).map(o => o.value);
}

function fillHeaderSelectors() {
  // key column selector
  els.keyCol.innerHTML = headers.map(h => `<option value="${h}">${h}</option>`).join('');
  // pick a likely key
  const guess = headers.find(h => /email|id|code|key/i.test(h)) || headers[0] || '';
  els.keyCol.value = guess;

  // show columns multi
  els.showCols.innerHTML = headers.map(h => `<option value="${h}">${h}</option>`).join('');
  // preselect a few
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

    // optional search-on-load
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
  const norm = s => String(s||'').toLowerCase().trim();
  const exact = rows.find(r => norm(r[keyField]) === norm(q));
  if (exact) {
    selectRow(exact);
    // also scroll it into view by reordering list with selected first
    rows = [exact, ...rows.filter(r => r !== exact)];
  } else {
    // fallback: filter contains
    const list = rows.filter(r => norm(r[keyField]).includes(norm(q)));
    if (!list.length) { msg('No matches. Showing all rows.'); }
    rows = list.length ? list : rows;
  }
  renderList();
}

function sendToForm() {
  if (!selected) { msg('Pick a row first.'); return; }
  // We emit JSON with keys == your column headers.
  // In Jotform, add Update/Calculate Field conditions to copy e.g. value.name → your Name field, etc.
  const payload = JSON.stringify({ spreadsheet: selected });
  try {
    JFCustomWidget.sendData({ value: payload });
    msg('Row sent to form. Use Conditions to copy values into your fields.', true);
  } catch (_) {}
}

function wire() {
  els.reloadBtn.addEventListener('click', () => loadCsv(false));
  els.searchBtn.addEventListener('click', () => doSearch());
  els.keyCol.addEventListener('change', () => renderList());
  els.showCols.addEventListener('change', () => renderList());
  els.useBtn.addEventListener('click', () => sendToForm());
}

JFCustomWidget.subscribe('ready', function(formData){
  SETTINGS = JFCustomWidget.getWidgetSettings() || {};
  // Settings you can define in the Jotform widget config:
  //  - DataUrl: live CSV URL
  //  - KeyColumn: preferred key column (optional)
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
  // Make the field "required" safe: valid when a row is selected
  const value = JSON.stringify({ spreadsheet: selected || null });
  const valid = !!selected;
  JFCustomWidget.sendSubmit({ valid, value });
});
