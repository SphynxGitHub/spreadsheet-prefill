/* globals JFCustomWidget, JF */
(function(){
  // ---------- Safe shims when testing outside Jotform ----------
  if (typeof window.JFCustomWidget === 'undefined') {
    window.JFCustomWidget = {
      subscribe: () => {},
      sendData: () => {},
      setFieldsValueByLabel: () => {},
      requestFrameResize: () => {},
      hideWidgetError: () => {},
      clearFields: () => {}
    };
  }
  if (typeof window.JF === 'undefined') {
    window.JF = {
      login: (ok, fail) => fail && fail(),
      getAPIKey: () => null
    };
  }

  // ---------- State ----------
  let formId = null;
  let apiKey  = localStorage.getItem('lf_apiKey')  || '';
  let apiBase = localStorage.getItem('lf_apiBase') || 'https://api.jotform.com';
  let manualFormId = localStorage.getItem('lf_manualFormId') || '';

  /** sources: [{id,name,url,keyCol, headers:[], rows:[{}]}] */
  let sources = JSON.parse(localStorage.getItem('lf_sources')||'[]');
  /** mapping: { [qid]: { kind: 'sheet'|'choice'|'other', sourceId?, column?, value?(string|string[]), otherValue? } } */
  let mapping = JSON.parse(localStorage.getItem('lf_mapping')||'{}');

  /** questions: [{qid,label,type,name,order,options[]}] — excludes headers/paragraphs/widgets */
  let questions = [];
  let rawQuestionsMap = {}; // original API map for reference (if needed)

  let activeSourceId = sources[0]?.id || null;
  let selectedRow = null; // raw row object from the chosen source

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const flashOk = $('flashOk'), flashErr = $('flashErr');
  const formIdLabel = $('formIdLabel');
  const loginBtn = $('loginBtn'), saveKey = $('saveKey'), loadFields = $('loadFields');
  const apiKeyIn = $('apiKey'), apiBaseSel = $('apiBase');

  const manualFormIdIn = $('manualFormId');
  const saveFormIdBtn  = $('saveFormId');
  if (manualFormIdIn) manualFormIdIn.value = manualFormId;

  const srcName = $('srcName'), srcUrl = $('srcUrl'), srcKeyCol = $('srcKeyCol');
  const addSource = $('addSource'), activeSource = $('activeSource');
  const btnRemoveSource = $('btnRemoveSource');
  const lookupVal = $('lookupVal'), btnSearch = $('btnSearch'), btnReloadCsv = $('btnReloadCsv');
  const rowsList = $('rowsList');

  const mapTableBody = document.querySelector('#mapTable tbody');
  const clearMap = $('clearMap'), autoMap = $('autoMap');
  const rowPreview = $('rowPreview'), payloadPreview = $('payloadPreview');
  const createSubmit = $('createSubmit'), resultBox = $('resultBox');

  apiKeyIn && (apiKeyIn.value = apiKey);
  apiBaseSel && (apiBaseSel.value = apiBase);
  const prefillBtn = $('prefillBtn');


  // ---------- Helpers ----------
  function ok(msg='Done.'){ if(!flashOk) return; flashOk.textContent=msg; flashOk.style.display='block'; setTimeout(()=>flashOk.style.display='none',1500); }
  function err(msg){ if(!flashErr) return; flashErr.textContent=msg; flashErr.style.display='block'; setTimeout(()=>flashErr.style.display='none',5000); }
  function showStatus(type, msg){ if(type==='ok') ok(msg); else err(msg); }

  function uid(){ return 's_' + Math.random().toString(36).slice(2,10); }
  function saveSources(){ localStorage.setItem('lf_sources', JSON.stringify(sources)); emitWidgetValue(); }
  function saveMapping(){ localStorage.setItem('lf_mapping', JSON.stringify(mapping)); emitWidgetValue(); }

  function getSource(id){ return sources.find(s=>s.id===id) || null; }
  function setActiveSource(id){ activeSourceId = id; renderSourcesDropdown(); renderRowsList(); }
  function pickRow(row){ selectedRow = row; renderPreviews(); }
  function debounce(fn,ms=400){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

  // ---------- Choice helpers ----------
  const CHOICE_TYPES = new Set(['control_dropdown','control_radio','control_checkbox']);
  const EXCLUDE_TYPES = new Set(['control_head','control_text','control_widget']);
  function isChoiceType(t){ return CHOICE_TYPES.has(t); }
  function isExcludedType(t){ return EXCLUDE_TYPES.has(t); }

  // ---------- Form ID utilities ----------
  function extractFormIdFromUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      // Live form: https://form.jotform.com/123456789012345
      const liveMatch = u.pathname.match(/\/(\d{8,20})(\/|$)/);
      if (liveMatch) return liveMatch[1];
      // Builder: https://www.jotform.com/build/123456789012345
      const buildMatch = u.pathname.match(/\/build\/(\d{8,20})(\/|$)/);
      if (buildMatch) return buildMatch[1];
      // Query param
      const q = u.searchParams.get('formID') || u.searchParams.get('formId');
      if (q && /^\d{8,20}$/.test(q)) return q;
    } catch(_) {}
    return null;
  }
  function resolveFormId(payload) {
    if (payload && (payload.formId || payload.formID)) return String(payload.formId || payload.formID);
    const fromRef = extractFormIdFromUrl(document.referrer);
    if (fromRef) return fromRef;
    if (manualFormId && /^\d{8,20}$/.test(manualFormId)) return manualFormId;
    return null;
  }

  if (saveFormIdBtn) {
    saveFormIdBtn.addEventListener('click', () => {
      manualFormId = (manualFormIdIn?.value || '').trim();
      localStorage.setItem('lf_manualFormId', manualFormId);
      formId = manualFormId || formId; // adopt it immediately
      if (formIdLabel) formIdLabel.textContent = formId ? `Form ID: ${formId}` : 'Form ID not available';
      ok('Form ID saved.');
    });
  }

  // ---------- CSV Fetch/Parse ----------
  async function fetchCsv(url){
    const res = await fetch(url, { mode:'cors' });
    const text = await res.text();
    const looksHtml = /^\s*</.test(text) && /<html|<head|<body/i.test(text);
    if (!res.ok || looksHtml) throw new Error('CSV not accessible. Publish the sheet/tab as CSV (or use /export?format=csv&gid=).');
    return parseCsvAuto(text);
  }
  function parseCsvAuto(raw){
    const first = raw.split(/\r?\n/,1)[0]||'';
    const candidates=[',',';','\t'];
    let delim=',', best=0;
    for(const d of candidates){
      const c=(first.match(new RegExp(`\\${d}`,'g'))||[]).length;
      if(c>best){best=c;delim=d;}
    }
    return parseDelimited(raw,delim);
  }
  function parseDelimited(text,delim){
    const out=[]; let i=0, field='', row=[], inQ=false; const N=text.length;
    const pushF=()=>{ row.push(field); field=''; };
    const pushR=()=>{ out.push(row); row=[]; };
    while(i<N){
      const c=text[i++];
      if(inQ){
        if(c==='"'){ if(text[i]==='"'){ field+='"'; i++; } else { inQ=false; } }
        else field+=c;
      }else{
        if(c==='"') inQ=true;
        else if(c==='\r'){/*skip*/}
        else if(c==='\n'){ pushF(); pushR(); }
        else if(c===delim){ pushF(); }
        else field+=c;
      }
    }
    if(field.length||row.length){ pushF(); pushR(); }
    const headers=(out.shift()||[]).map(h=>(h||'').trim());
    const rows=out
      .filter(r=>r.some(cell=>String(cell||'').trim().length))
      .map(r=>{ const o={}; headers.forEach((h,idx)=>o[h]=r[idx]??''); return o; });
    return { headers, rows };
  }
  async function loadSourceData(s){
    const { headers, rows } = await fetchCsv(s.url);
    s.headers = headers;
    s.rows = rows;
    if(!s.keyCol){
      const guess = headers.find(h=>/^(email|id|code)$/i.test(h)) || headers[0];
      s.keyCol = guess;
    }
    saveSources();
  }

  // ---------- Jotform API (Questions only; prefill uses labels) ----------
  async function getQuestions(){
    if(!formId) throw new Error('Form ID not available.');

    // You can fetch without API key for many forms; if 401 appears, user can login/paste API key.
    const url = `${apiBase}/form/${formId}/questions${apiKey?`?apiKey=${encodeURIComponent(apiKey)}`:''}`;
    const resp = await fetch(url, { mode:'cors' });
    if(!resp.ok) throw new Error(`Questions fetch failed (${resp.status}). Login may be required.`);

    const json = await resp.json();
    const map = json.content || {};
    rawQuestionsMap = map;

    const parsed = Object.keys(map).map(qid => {
      const q = map[qid] || {};
      const optRaw = q.options || q.items || q.choices || '';
      const options = Array.isArray(optRaw) ? optRaw
        : String(optRaw||'').split('|');
      return {
        qid,
        label: q.text || '',
        type: q.type || '',
        name: q.name || '',
        order: q.order || 0,
        options: options.map(s => String(s||'').trim()).filter(Boolean)
      };
    });

    questions = parsed
      .filter(q => !isExcludedType(q.type))
      .sort((a,b) => a.order - b.order);
  }

  // ---------- UI: Auth ----------
  JFCustomWidget.subscribe('ready', payload => {
    // Try to get formId
    formId = resolveFormId(payload);
    if (formIdLabel) {
      formIdLabel.textContent = formId
        ? `Form ID: ${formId}`
        : 'Form ID not available — paste it above and click “Save Form ID”.';
    }
    renderSourcesDropdown();
    renderRowsList();
    renderMappingTable();
    emitWidgetValue();
  });

  if (loginBtn) {
    loginBtn.addEventListener('click', ()=>{
      JF.login(()=>{
        try{
          const k = JF.getAPIKey();
          if(k){ apiKey = k; if(apiKeyIn) apiKeyIn.value = k; localStorage.setItem('lf_apiKey', apiKey); ok('Authorized.'); }
          else err('Login ok, but API key not returned.');
        }catch(e){ err('Login ok, but API key not returned.'); }
      }, ()=> err('Login failed or canceled.'));
    });
  }

  if (saveKey) {
    saveKey.addEventListener('click', ()=>{
      apiKey = (apiKeyIn?.value || '').trim();
      apiBase = (apiBaseSel?.value || 'https://api.jotform.com');
      localStorage.setItem('lf_apiKey', apiKey);
      localStorage.setItem('lf_apiBase', apiBase);
      ok('Saved.');
    });
  }

  if (loadFields) {
    loadFields.addEventListener('click', async ()=>{
      try{
        await getQuestions();
        renderMappingTable();
        ok('Questions loaded.');
      }catch(e){ err(e.message||'Failed to load questions.'); }
    });
  }

  // ---------- UI: Sources ----------
  function renderSourcesDropdown(){
    if(!activeSource) return;
    activeSource.innerHTML = '';
    if(!sources.length){
      activeSource.appendChild(new Option('— no sources —',''));
      return;
    }
    sources.forEach(s=>{
      const o=new Option(`${s.name} ${s.headers?`(${s.rows?.length||0})`:''}`, s.id);
      activeSource.appendChild(o);
    });
    if(!activeSourceId || !getSource(activeSourceId)) activeSourceId = sources[0].id;
    activeSource.value = activeSourceId;
  }

  if (addSource) {
    addSource.addEventListener('click', async ()=>{
      const name  = (srcName?.value || '').trim();
      const url   = (srcUrl?.value  || '').trim();
      const keyCol= (srcKeyCol?.value || '').trim();
      if (!name || !url) { err('Enter a tab name and CSV URL.'); return; }

      // If a source with the same URL exists, update it instead of duplicating
      const existing = sources.find(x => x.url === url);
      if (existing) {
        existing.name = name;
        if (keyCol) existing.keyCol = keyCol;
        try {
          await loadSourceData(existing);
          activeSourceId = existing.id;
          renderSourcesDropdown(); renderRowsList(); renderMappingTable();
          ok('Updated existing source.');
        } catch (e) {
          err(e.message || 'Failed to refresh the existing source.');
        }
        return;
      }

      // Otherwise create a new source
      const s = { id: uid(), name, url, keyCol: keyCol || null, headers: null, rows: null };
      sources.push(s); saveSources();
      try {
        await loadSourceData(s);
        activeSourceId = s.id;
        renderSourcesDropdown(); renderRowsList(); renderMappingTable();
        ok('Source added.');
      } catch (e) {
        err(e.message || 'Failed to load CSV.');
      }
    });
  }

  activeSource && activeSource.addEventListener('change', ()=> setActiveSource(activeSource.value));

  btnReloadCsv && btnReloadCsv.addEventListener('click', async ()=>{
    const s = getSource(activeSourceId); if(!s) return;
    try{ await loadSourceData(s); renderRowsList(); renderMappingTable(); ok('CSV reloaded.'); }
    catch(e){ err(e.message||'Reload failed.'); }
  });

  btnRemoveSource && btnRemoveSource.addEventListener('click', ()=>{
    const s = getSource(activeSourceId);
    if (!s) { err('No source selected.'); return; }
    if (!confirm(`Remove source "${s.name}"? This will also clear any field mappings that use it.`)) return;

    // 1) remove from sources
    sources = sources.filter(x => x.id !== s.id);

    // 2) clear mappings that referenced this source
    Object.keys(mapping).forEach(qid => {
      if (mapping[qid]?.sourceId === s.id) delete mapping[qid];
    });

    // 3) clear selected row if it came from this source
    if (selectedRow?.__sourceId === s.id) selectedRow = null;

    // 4) pick a new active source (if any)
    activeSourceId = sources[0]?.id || null;

    // 5) persist + repaint
    saveSources();
    saveMapping();
    renderSourcesDropdown();
    renderRowsList();
    renderMappingTable();
    renderPreviews();
    ok('Source removed.');
  });

  btnSearch && btnSearch.addEventListener('click', ()=> renderRowsList());
  lookupVal && lookupVal.addEventListener('keydown', e=>{ if(e.key==='Enter') renderRowsList(); });

  function renderRowsList(){
    const s = getSource(activeSourceId);
    if(!rowsList) return;
    rowsList.innerHTML = '';
    if(!s){ rowsList.innerHTML='<div class="mini">Pick or add a source.</div>'; return; }
    if(!s.headers){ rowsList.innerHTML='<div class="mini">No data loaded yet. Click “Reload CSV”.</div>'; return; }

    const q = (lookupVal?.value||'').toLowerCase().trim();
    const keyCol = s.keyCol && s.headers.includes(s.keyCol) ? s.keyCol : s.headers[0];

    const subset = (s.rows||[]).filter(r=>{
      if(!q) return true;
      const v = String(r[keyCol]??'').toLowerCase();
      return v.includes(q);
    }).slice(0,200);

    const tbl=document.createElement('table');
    const thead=document.createElement('thead'), tbody=document.createElement('tbody');

    const trh=document.createElement('tr');
    s.headers.slice(0,6).forEach(h=>{
      const th=document.createElement('th'); th.textContent=h; trh.appendChild(th);
    });
    thead.appendChild(trh);
    tbl.appendChild(thead);

    subset.forEach(r=>{
      const tr=document.createElement('tr'); tr.style.cursor='pointer';
      s.headers.slice(0,6).forEach(h=>{
        const td=document.createElement('td'); td.textContent = r[h];
        tr.appendChild(td);
      });
      tr.addEventListener('click', ()=>{ pickRow({ __sourceId:s.id, ...r }); ok('Row selected.'); });
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    rowsList.appendChild(tbl);

    if(!subset.length){
      const d=document.createElement('div'); d.className='mini';
      d.textContent = q ? `No matches for "${lookupVal?.value}" in ${keyCol}.` : 'No rows found.';
      rowsList.appendChild(d);
    }
  }

  // ---------- Mapping UI (Sheet / Choice / Other) ----------
  function renderMappingTable(){
    if(!mapTableBody) return;
    mapTableBody.innerHTML='';
    if(!questions.length){
      mapTableBody.innerHTML='<tr><td colspan="3" class="muted">Load Jotform questions first.</td></tr>';
      return;
    }

    // Build a grouped source → columns map
    const grouped = {};
    sources.forEach(s=> grouped[s.id] = (s.headers||[]).map(h=>({ column:h, source:s })) );

    questions.forEach(q=>{
      // Row scaffolding
      const tr=document.createElement('tr');

      const td1=document.createElement('td'); td1.textContent = `${q.label} (${q.type})`;
      const td2=document.createElement('td'); td2.textContent = q.qid;
      const td3=document.createElement('td');

      // Mode select
      const modeSel = document.createElement('select');
      modeSel.innerHTML = `
        <option value="">— no mapping —</option>
        <option value="sheet">Sheet Column</option>
        ${isChoiceType(q.type) ? `<option value="choice">Pick Choice(s)</option>` : ''}
        <option value="other">Other (free text)</option>
      `;

      // Container for the mode-specific control
      const ctrlBox = document.createElement('div');
      ctrlBox.style.marginTop = '6px';

      // Build Sheet Column selector
      function buildSheetPicker(){
        const wrap = document.createElement('div');
        const sel = document.createElement('select');
        sel.innerHTML = `<option value="">— pick a column —</option>`;

        Object.keys(grouped).forEach(sid=>{
          const s = getSource(sid); if(!s || !s.headers) return;
          const og = document.createElement('optgroup'); og.label = `${s.name}`;
          grouped[sid].forEach(o=>{
            const opt=document.createElement('option');
            opt.value = JSON.stringify({ sourceId:sid, column:o.column });
            opt.textContent = o.column;
            og.appendChild(opt);
          });
          sel.appendChild(og);
        });

        // Restore
        const m = mapping[q.qid];
        if (m && m.kind==='sheet') {
          sel.value = JSON.stringify({ sourceId:m.sourceId, column:m.column });
        }

        sel.addEventListener('change', ()=>{
          if(!sel.value){
            delete mapping[q.qid];
          } else {
            const { sourceId, column } = JSON.parse(sel.value);
            mapping[q.qid] = { kind:'sheet', sourceId, column };
          }
          saveMapping(); renderPreviews();
        });

        wrap.appendChild(sel);
        return wrap;
      }

      // Build Choice picker (single or multi depending on type)
      function buildChoicePicker(){
        const wrap = document.createElement('div');
        const helper = document.createElement('div');
        helper.className = 'mini';
        helper.textContent = (q.type==='control_checkbox')
          ? 'Multi-select: Ctrl/Cmd-click to pick multiple.'
          : 'Single-select.';
        const sel = document.createElement('select');
        if (q.type==='control_checkbox') sel.multiple = true;

        // Options
        q.options.forEach(opt=>{
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          sel.appendChild(o);
        });

        // Restore
        const m = mapping[q.qid];
        if (m && m.kind==='choice') {
          const val = m.value;
          if (Array.isArray(val)) {
            [...sel.options].forEach(o => { o.selected = val.includes(o.value); });
          } else if (typeof val === 'string') {
            [...sel.options].forEach(o => { o.selected = (o.value === val); });
          }
        }

        sel.addEventListener('change', ()=>{
          let value;
          if (q.type==='control_checkbox') {
            value = [...sel.options].filter(o=>o.selected).map(o=>o.value);
          } else {
            value = sel.value || '';
          }
          mapping[q.qid] = { kind:'choice', value };
          saveMapping(); renderPreviews();
        });

        wrap.appendChild(helper);
        wrap.appendChild(sel);
        return wrap;
      }

      // Build Other (free text) input
      function buildOtherBox(){
        const wrap = document.createElement('div');
        const inp = document.createElement('input');
        inp.type = 'text'; inp.placeholder = 'Type a value…';
        // Restore
        const m = mapping[q.qid];
        if (m && m.kind==='other') inp.value = m.otherValue || '';

        inp.addEventListener('input', ()=>{
          const v = inp.value;
          if (!v) delete mapping[q.qid];
          else mapping[q.qid] = { kind:'other', otherValue: v };
          saveMapping(); renderPreviews();
        });

        wrap.appendChild(inp);
        return wrap;
      }

      // Switcher
      function paintCtrlFor(mode){
        ctrlBox.innerHTML = '';
        if (!mode) { delete mapping[q.qid]; saveMapping(); renderPreviews(); return; }
        if (mode==='sheet') ctrlBox.appendChild(buildSheetPicker());
        if (mode==='choice') ctrlBox.appendChild(buildChoicePicker());
        if (mode==='other') ctrlBox.appendChild(buildOtherBox());
      }

      // Restore mode
      if (mapping[q.qid]?.kind) modeSel.value = mapping[q.qid].kind;
      modeSel.addEventListener('change', ()=>{ paintCtrlFor(modeSel.value); });

      // Initial paint
      paintCtrlFor(modeSel.value);

      td3.appendChild(modeSel);
      td3.appendChild(ctrlBox);

      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      mapTableBody.appendChild(tr);
    });
  }

  clearMap && clearMap.addEventListener('click', ()=>{
    mapping = {};
    saveMapping();
    renderMappingTable();
    renderPreviews();
  });

  autoMap && autoMap.addEventListener('click', ()=>{
    // Naive: if a question label matches any column (case-insensitive), choose sheet mode
    const colsByLower = {};
    sources.forEach(s=>{
      (s.headers||[]).forEach(h=>{
        const key = h.toLowerCase();
        if(!colsByLower[key]) colsByLower[key] = [];
        colsByLower[key].push({ sourceId:s.id, column:h });
      });
    });
    questions.forEach(q=>{
      const k = (q.label||'').toLowerCase().trim();
      const cand = colsByLower[k] && colsByLower[k][0];
      if(cand) mapping[q.qid] = { kind:'sheet', sourceId:cand.sourceId, column:cand.column };
    });
    saveMapping();
    renderMappingTable();
    renderPreviews();
    ok('Auto-mapped where labels matched.');
  });

  // ---------- Build Prefill Pairs & Preview ----------
  function buildLabelValuePairs(rowBySource){
    const pairs = [];
    questions.forEach(q => {
      const m = mapping[q.qid];
      if (!m) return;

      let val = '';
      if (m.kind === 'sheet') {
        const r = rowBySource[m.sourceId];
        if (!r) return;
        val = r[m.column] ?? '';
      } else if (m.kind === 'choice') {
        val = m.value ?? '';
        if (Array.isArray(val)) {
          // For checkbox (multi), join with comma (Jotform accepts comma-separated)
          if (q.type === 'control_checkbox') val = val.join(', ');
          else val = val.join(' ');
        }
      } else if (m.kind === 'other') {
        val = m.otherValue ?? '';
      }

      if (String(val).trim().length === 0) return;
      pairs.push({ label: q.label, value: val });
    });
    return pairs;
  }

  function renderPreviews(){
    const rowBySource = {};
    if(selectedRow && selectedRow.__sourceId){
      rowBySource[selectedRow.__sourceId] = selectedRow;
    }
    if (rowPreview) rowPreview.textContent = selectedRow ? JSON.stringify(selectedRow, null, 2) : '(no row selected)';

    const preview = {};
    const pairs = buildLabelValuePairs(rowBySource);
    pairs.forEach(p => { preview[p.label] = p.value; });

    if (payloadPreview) {
      payloadPreview.textContent = Object.keys(preview).length
        ? JSON.stringify(preview, null, 2)
        : '(no mapped values or no selected row)';
    }
  }

  // Prefill the live form via labels (no API call)
  prefillBtn && prefillBtn.addEventListener('click', async ()=>{
    const original = prefillBtn.textContent;
    prefillBtn.disabled = true;
    prefillBtn.textContent = 'Filling…';
    try {
      if (!selectedRow) throw new Error('Pick a row first.');
      const rowBySource = { [selectedRow.__sourceId]: selectedRow };
      const pairs = buildLabelValuePairs(rowBySource);
      if (!pairs.length) throw new Error('No mapped values to fill.');
  
      // Fill the parent form
      JFCustomWidget.hideWidgetError && JFCustomWidget.hideWidgetError();
      JFCustomWidget.setFieldsValueByLabel(pairs);
  
      // UX: flash success
      if (resultBox) resultBox.innerHTML = '<div class="ok" style="display:block">Fields have been auto-filled.</div>';
    } catch (e) {
      if (resultBox) resultBox.innerHTML = `<div class="err" style="display:block">${e?.message || 'Prefill failed.'}</div>`;
    } finally {
      prefillBtn.disabled = false;
      prefillBtn.textContent = original;
    }
  });

  // ---------- Widget value emitter (so config is stored with the form) ----------
  const emit = debounce(()=>{
    const payload = {
      formId,
      apiBase,
      sources: sources.map(s=>({ id:s.id, name:s.name, url:s.url, keyCol:s.keyCol, headers:s.headers || [], rowsCount:(s.rows||[]).length })),
      mapping,
      selectedRow: selectedRow ? { sourceId:selectedRow.__sourceId, row:selectedRow } : null
    };
    try{ JFCustomWidget.sendData({ value: JSON.stringify(payload) }); }catch(_){}
  }, 600);
  function emitWidgetValue(){ emit(); }
  window.addEventListener('storage', emitWidgetValue);

  // ---------- Auto-resize (like Spreadsheet-to-Form) ----------
  (function enableAutoResize(){
    if (!('ResizeObserver' in window)) return;
    let lastH = 0;
    const ro = new ResizeObserver(() => {
      const h = document.body.clientHeight + 10;
      if (h !== lastH) {
        lastH = h;
        try { JFCustomWidget.requestFrameResize({ height: h }); } catch(_) {}
      }
    });
    ro.observe(document.body);
  })();

  // ---------- Kick things off ----------
  function boot(){
    if (formIdLabel) formIdLabel.textContent = formId ? `Form ID: ${formId}` : 'Form ID not available';
    renderSourcesDropdown();
    renderRowsList();
    renderMappingTable();
    renderPreviews();
  }
  boot();
})();
