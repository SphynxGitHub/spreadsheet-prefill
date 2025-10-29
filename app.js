/* globals JFCustomWidget, JF */
(function(){
  // ---------- Safe shims for local testing ----------
  if (typeof window.JFCustomWidget === 'undefined') {
    window.JFCustomWidget = { subscribe: () => {}, sendData: () => {}, setFieldsValueByLabel: ()=>{}, hideWidgetError:()=>{}, requestFrameResize:()=>{}, getEnterprise:()=>({}), getWidgetData:()=>({}), getWidgetSettings:()=>({}), isWidgetRequired:()=>false, isFromCardform:()=>false };
  }
  if (typeof window.JF === 'undefined') {
    window.JF = { login: (ok, fail)=>fail&&fail(), getAPIKey: ()=>null };
  }

  // ---------- State ----------
  let formId = null;
  let apiKey  = localStorage.getItem('lf_apiKey')  || '';
  let apiBase = localStorage.getItem('lf_apiBase') || 'https://api.jotform.com';
  let manualFormId = localStorage.getItem('lf_manualFormId') || '';

  /** sources: [{id,name,url,keyCol, headers:[], rows:[{}]}] */
  let sources = JSON.parse(localStorage.getItem('lf_sources')||'[]');
  /** mapping: { [qid]: { mode:'sheet'|'choice'|'manual', sourceId?, column?, value? } } */
  let mapping = JSON.parse(localStorage.getItem('lf_mapping_v2')||'{}');

  /** per-source current selection: { [sourceId]: rowObj } */
  let selectedRows = JSON.parse(localStorage.getItem('lf_selectedRows')||'{}');

  /** questions loaded from JF */
  let questions = []; // [{qid,label,type,name,order, options?:[], allowOther?:bool}]
  let activeSourceId = sources[0]?.id || null;

  // mapping collapse persisted state
  let mapCollapsed = (localStorage.getItem('lf_mapCollapsed') || 'false') === 'true';

  // question types to exclude (static/widget/system)
  const EXCLUDE_TYPES = new Set([
    'control_head','control_text','control_image','control_button',
    'control_collapse','control_pagebreak','control_widget'
  ]);

  const CHOICE_TYPES = new Set(['control_dropdown','control_radio','control_checkbox']);

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const flashOk = $('flashOk'), flashErr = $('flashErr');
  const formIdLabel = $('formIdLabel');
  const loginBtn = $('loginBtn'), saveKey = $('saveKey'), loadFields = $('loadFields');
  const apiKeyIn = $('apiKey'), apiBaseSel = $('apiBase');

  const manualFormIdIn = $('manualFormId'), saveFormIdBtn = $('saveFormId');

  const srcName = $('srcName'), srcUrl = $('srcUrl'), srcKeyCol = $('srcKeyCol');
  const addSource = $('addSource'), activeSource = $('activeSource');
  const btnRemoveSource = $('btnRemoveSource');
  const lookupVal = $('lookupVal'), btnSearch = $('btnSearch'), btnReloadCsv = $('btnReloadCsv');
  const rowsList = $('rowsList');
  const selectedHint = $('selectedHint'), selectedChips = $('selectedChips');

  const mappingCard = $('mappingCard');
  const mapTableBody = document.querySelector('#mapTable tbody');
  const clearMap = $('clearMap'), autoMap = $('autoMap');
  const toggleMap = $('toggleMap');
  const mapSummary = $('mapSummary');

  const rowPreview = $('rowPreview'), payloadPreview = $('payloadPreview');
  const prefillBtn = $('prefillBtn'), resultBox = $('resultBox');

  apiKeyIn && (apiKeyIn.value = apiKey);
  apiBaseSel && (apiBaseSel.value = apiBase);
  if (manualFormIdIn) manualFormIdIn.value = manualFormId;

  // ---------- Helpers ----------
  function ok(msg='Done.'){ if(!flashOk) return; flashOk.textContent=msg; flashOk.style.display='block'; setTimeout(()=>flashOk.style.display='none',1200); }
  function err(msg){ if(!flashErr) return; flashErr.textContent=msg; flashErr.style.display='block'; setTimeout(()=>flashErr.style.display='none',4500); }

  function uid(){ return 's_' + Math.random().toString(36).slice(2,10); }
  function saveSources(){ localStorage.setItem('lf_sources', JSON.stringify(sources)); emitWidgetValue(); }
  function saveMapping(){ localStorage.setItem('lf_mapping_v2', JSON.stringify(mapping)); emitWidgetValue(); updateMapSummary(); }
  function saveSelections(){ localStorage.setItem('lf_selectedRows', JSON.stringify(selectedRows)); emitWidgetValue(); }
  function saveMapCollapsed(){ localStorage.setItem('lf_mapCollapsed', String(mapCollapsed)); }

  function getSource(id){ return sources.find(s=>s.id===id) || null; }
  function setActiveSource(id){ activeSourceId = id; renderSourcesDropdown(); renderRowsList(); }
  function debounce(fn,ms=400){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

  // ---------- Form ID utilities ----------
  function extractFormIdFromUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url);
      const liveMatch = u.pathname.match(/\/(\d{8,20})(\/|$)/);
      if (liveMatch) return liveMatch[1];
      const buildMatch = u.pathname.match(/\/build\/(\d{8,20})(\/|$)/);
      if (buildMatch) return buildMatch[1];
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

  saveFormIdBtn && saveFormIdBtn.addEventListener('click', ()=>{
    manualFormId = (manualFormIdIn?.value || '').trim();
    localStorage.setItem('lf_manualFormId', manualFormId);
    formId = manualFormId || formId;
    if (formIdLabel) formIdLabel.textContent = formId ? `Form ID: ${formId}` : 'Form ID not available';
    ok('Form ID saved.');
  });

  // ---------- CSV Fetch/Parse ----------
  async function fetchCsv(url){
    const res = await fetch(url, { mode:'cors' });
    const text = await res.text();
    const looksHtml = /^\s*</.test(text) && /<html|<head|<body/i.test(text);
    if (!res.ok || looksHtml) throw new Error('CSV not accessible. Publish the tab as CSV (or use /export?format=csv&gid=).');
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

  // ---------- Jotform API ----------
  async function getQuestions(){
    if(!apiKey) throw new Error('Paste an API key or Login first.');
    if(!formId) throw new Error('Form ID not available.');
    const url = `${apiBase}/form/${formId}/questions?apiKey=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, { mode:'cors' });
    if(!resp.ok) throw new Error(`Questions fetch failed: ${resp.status}`);
    const json = await resp.json();
    const map = json.content || {};

    questions = Object.keys(map).map(qid=>{
      const q = map[qid] || {};
      let opts = [];
      if (q.options && typeof q.options === 'string'){
        opts = q.options.split('|').map(s=>s.trim()).filter(Boolean);
      } else if (Array.isArray(q.options)) {
        opts = q.options.map(String);
      }
      return {
        qid,
        label: q.text || '',
        type: q.type || '',
        name: q.name || '',
        order: q.order || 0,
        options: opts,
        allowOther: !!q.allowOther
      };
    }).filter(q => !EXCLUDE_TYPES.has(q.type))
      .sort((a,b)=>a.order - b.order);
  }

  // ---------- UI: Auth ----------
  JFCustomWidget.subscribe('ready', payload => {
    formId = resolveFormId(payload);
    if (formIdLabel) {
      formIdLabel.textContent = formId ? `Form ID: ${formId}` : 'Form ID not available — paste it & Save.';
    }
    applyMapCollapsed();
    renderSourcesDropdown();
    renderRowsList();
    renderSelectedHint();
    renderSelectedChips();
    renderMappingTable();
    renderPreviews();
    emitWidgetValue();
  });

  loginBtn && loginBtn.addEventListener('click', ()=>{
    JF.login(()=>{
      try{
        const k = JF.getAPIKey();
        if(k){ apiKey = k; apiKeyIn && (apiKeyIn.value = k); localStorage.setItem('lf_apiKey', apiKey); ok('Authorized.'); }
        else err('Login ok, but API key not returned.');
      }catch(e){ err('Login ok, but API key not returned.'); }
    }, ()=> err('Login failed or canceled.'));
  });

  saveKey && saveKey.addEventListener('click', ()=>{
    apiKey = (apiKeyIn?.value || '').trim();
    apiBase = (apiBaseSel?.value || 'https://api.jotform.com');
    localStorage.setItem('lf_apiKey', apiKey);
    localStorage.setItem('lf_apiBase', apiBase);
    ok('Saved.');
  });

  loadFields && loadFields.addEventListener('click', async ()=>{
    try{
      await getQuestions();
      renderMappingTable();
      ok('Questions loaded.');
    }catch(e){ err(e.message||'Failed to load questions.'); }
  });

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

  addSource && addSource.addEventListener('click', async ()=>{
    const name  = (srcName?.value || '').trim();
    const url   = (srcUrl?.value  || '').trim();
    const keyCol= (srcKeyCol?.value || '').trim();
    if (!name || !url) { err('Enter a tab name and CSV URL.'); return; }

    const existing = sources.find(x => x.url === url);
    if (existing) {
      existing.name = name;
      if (keyCol) existing.keyCol = keyCol;
      try {
        await loadSourceData(existing);
        activeSourceId = existing.id;
        renderSourcesDropdown(); renderRowsList(); renderMappingTable();
        ok('Updated existing source.');
      } catch (e) { err(e.message || 'Failed to refresh existing source.'); }
      return;
    }

    const s = { id: uid(), name, url, keyCol: keyCol || null, headers: null, rows: null };
    sources.push(s); saveSources();
    try {
      await loadSourceData(s);
      activeSourceId = s.id;
      renderSourcesDropdown(); renderRowsList(); renderMappingTable();
      ok('Source added.');
    } catch (e) { err(e.message || 'Failed to load CSV.'); }
  });

  activeSource && activeSource.addEventListener('change', ()=> setActiveSource(activeSource.value));

  btnReloadCsv && btnReloadCsv.addEventListener('click', async ()=>{
    const s = getSource(activeSourceId); if(!s) return;
    try{ await loadSourceData(s); renderRowsList(); renderMappingTable(); ok('CSV reloaded.'); }
    catch(e){ err(e.message||'Reload failed.'); }
  });

  btnRemoveSource && btnRemoveSource.addEventListener('click', ()=>{
    const s = getSource(activeSourceId);
    if (!s) { err('No source selected.'); return; }
    if (!confirm(`Remove source "${s.name}"? This also clears mappings using it.`)) return;

    sources = sources.filter(x => x.id !== s.id);

    Object.keys(mapping).forEach(qid => {
      if (mapping[qid]?.sourceId === s.id) delete mapping[qid];
    });

    if (selectedRows[s.id]) delete selectedRows[s.id];

    activeSourceId = sources[0]?.id || null;

    saveSources(); saveMapping(); saveSelections();
    renderSourcesDropdown(); renderRowsList(); renderMappingTable(); renderPreviews(); renderSelectedHint(); renderSelectedChips();
    ok('Source removed.');
  });

  btnSearch && btnSearch.addEventListener('click', ()=> renderRowsList());
  lookupVal && lookupVal.addEventListener('keydown', e=>{ if(e.key==='Enter') renderRowsList(); });

  function pickRowFromSource(source, row){
    selectedRows[source.id] = { __sourceId: source.id, ...row };
    saveSelections();
    renderSelectedHint();
    renderSelectedChips();
    renderPreviews();
  }

  function unselectSource(id){
    if (selectedRows[id]) { delete selectedRows[id]; saveSelections(); renderSelectedHint(); renderSelectedChips(); renderPreviews(); }
  }

  $('btnClearSelection') && $('btnClearSelection').addEventListener('click', ()=>{
    selectedRows = {};
    saveSelections();
    renderSelectedHint(); renderSelectedChips(); renderPreviews();
    ok('Selection cleared.');
  });

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
        const td=document.createElement('td'); td.textContent = r[h]; tr.appendChild(td);
      });
      tr.addEventListener('click', ()=>{ pickRowFromSource(s, r); ok(`Row selected from "${s.name}".`); });
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

  function renderSelectedHint(){
    const ids = Object.keys(selectedRows);
    if (selectedHint) selectedHint.textContent = ids.length ? `Selected rows: ${ids.length} source${ids.length>1?'s':''}` : '';
  }
  function renderSelectedChips(){
    if (!selectedChips) return;
    selectedChips.innerHTML = '';
    const ids = Object.keys(selectedRows);
    if (!ids.length) return;
    ids.forEach(id=>{
      const s = getSource(id);
      const c = document.createElement('span'); c.className='chip';
      c.innerHTML = `<b>${s?.name || id}</b><button title="Unselect" aria-label="Unselect">×</button>`;
      c.querySelector('button').addEventListener('click', ()=> unselectSource(id));
      selectedChips.appendChild(c);
    });
  }

  // ---------- Mapping ----------
  function renderMappingTable(){
    if(!mapTableBody) return;
    mapTableBody.innerHTML='';
    if(!questions.length){
      mapTableBody.innerHTML='<tr><td colspan="3" class="muted">Load Jotform questions first.</td></tr>';
      updateMapSummary();
      return;
    }

    const grouped = {};
    sources.forEach(s=> grouped[s.id] = (s.headers||[]).map(h=>({ column:h, source:s })) );

    questions.forEach(q=>{
      const tr=document.createElement('tr');

      const td1=document.createElement('td'); td1.textContent = `${q.label} (${q.type.replace('control_','')})`;
      const td2=document.createElement('td'); td2.textContent = q.qid;
      const td3=document.createElement('td');

      const sel=document.createElement('select');
      sel.innerHTML = `<option value="">— no mapping —</option>`;

      // Sheet columns (grouped by source)
      Object.keys(grouped).forEach(sid=>{
        const s = getSource(sid); if(!s || !s.headers) return;
        const og = document.createElement('optgroup'); og.label = `Sheet: ${s.name}`;
        grouped[sid].forEach(o=>{
          const opt=document.createElement('option');
          opt.value = JSON.stringify({ mode:'sheet', sourceId:sid, column:o.column });
          opt.textContent = o.column;
          og.appendChild(opt);
        });
        sel.appendChild(og);
      });

      // Choices (if applicable)
      if (CHOICE_TYPES.has(q.type) && (q.options?.length)){
        const ogc = document.createElement('optgroup'); ogc.label = 'Choices';
        q.options.forEach(ch=>{
          const opt=document.createElement('option');
          opt.value = JSON.stringify({ mode:'choice', value: ch });
          opt.textContent = `Choice: ${ch}`;
          ogc.appendChild(opt);
        });
        sel.appendChild(ogc);
      }

      // Manual
      const ogm = document.createElement('optgroup'); ogm.label = 'Manual';
      const optMan = document.createElement('option');
      optMan.value = JSON.stringify({ mode:'manual', value:'' });
      optMan.textContent = 'Custom value…';
      ogm.appendChild(optMan);
      sel.appendChild(ogm);

      if(mapping[q.qid]) sel.value = JSON.stringify(mapping[q.qid]);

      sel.addEventListener('change', ()=>{
        if(!sel.value){ delete mapping[q.qid]; saveMapping(); renderPreviews(); return; }
        let chosen = JSON.parse(sel.value);
        if (chosen.mode === 'manual'){
          const v = prompt(`Enter custom value for "${q.label}"`, mapping[q.qid]?.value || '');
          if (v == null) {
            if (mapping[q.qid]) sel.value = JSON.stringify(mapping[q.qid]);
            else sel.value = '';
            return;
          }
          chosen.value = v;
        }
        mapping[q.qid] = chosen;
        saveMapping();
        renderPreviews();
      });

      td3.appendChild(sel);
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      mapTableBody.appendChild(tr);
    });

    updateMapSummary();
  }

  clearMap && clearMap.addEventListener('click', ()=>{
    mapping = {};
    saveMapping();
    renderMappingTable();
    renderPreviews();
  });

  autoMap && autoMap.addEventListener('click', ()=>{
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
      if(cand) mapping[q.qid] = { mode:'sheet', ...cand };
    });
    saveMapping();
    renderMappingTable();
    renderPreviews();
    ok('Auto-mapped where labels matched.');
  });

  // collapse/expand mapping
  function applyMapCollapsed(){
    if (!mappingCard || !toggleMap) return;
    mappingCard.classList.toggle('collapsed', mapCollapsed);
    toggleMap.textContent = mapCollapsed ? 'Expand' : 'Shrink';
    updateMapSummary();
    // ask JF to resize frame to current content
    try{ JFCustomWidget.requestFrameResize && JFCustomWidget.requestFrameResize({ height: document.body.clientHeight + 10 }); }catch(_){}
  }

  function updateMapSummary(){
    if (!mapSummary) return;
    const totalQs = questions.length || 0;
    const mapped = Object.keys(mapping).length || 0;
    mapSummary.textContent = `Mapping hidden — ${mapped} of ${totalQs} fields mapped.`;
  }

  toggleMap && toggleMap.addEventListener('click', ()=>{
    mapCollapsed = !mapCollapsed;
    saveMapCollapsed();
    applyMapCollapsed();
  });

  // ---------- Prefill ----------
  function buildLabelValuePairs(rowBySource){
    const byLabel = {};
    questions.forEach(q=>{
      const map = mapping[q.qid]; if(!map) return;
      let value = '';

      if (map.mode === 'manual'){
        value = String(map.value ?? '');
      } else if (map.mode === 'choice'){
        value = String(map.value ?? '');
      } else if (map.mode === 'sheet'){
        const r = rowBySource[map.sourceId];
        if (r) value = r[map.column] ?? '';
      }

      if (value === '') return;

      if (q.type === 'control_checkbox'){
        const parts = String(value).split(/[;,]/).map(s=>s.trim()).filter(Boolean);
        if (parts.length) byLabel[q.label] = parts;
      } else {
        byLabel[q.label] = value;
      }
    });

    return Object.keys(byLabel).map(label=>({ label, value: byLabel[label] }));
  }

  function renderPreviews(){
    if (rowPreview){
      const compact = {};
      Object.keys(selectedRows).forEach(sid=>{
        const r = selectedRows[sid];
        const keys = Object.keys(r).filter(k=>k!=='__sourceId').slice(0,8);
        const small = {}; keys.forEach(k=>small[k]=r[k]);
        const s = getSource(sid);
        compact[s?.name || sid] = small;
      });
      rowPreview.textContent = Object.keys(compact).length ? JSON.stringify(compact, null, 2) : '(no rows selected)';
    }

    const pairs = buildLabelValuePairs(selectedRows);
    const obj = {};
    pairs.forEach(p=> obj[p.label] = p.value);
    if (payloadPreview) payloadPreview.textContent = Object.keys(obj).length ? JSON.stringify(obj, null, 2) : '(nothing mapped or no selections)';
  }

  prefillBtn && prefillBtn.addEventListener('click', async ()=>{
    const original = prefillBtn.textContent;
    prefillBtn.disabled = true;
    prefillBtn.textContent = 'Filling…';
    try{
      if(!Object.keys(selectedRows).length) throw new Error('Pick at least one row from a source.');
      const pairs = buildLabelValuePairs(selectedRows);
      if(!pairs.length) throw new Error('No mapped values derived from selections.');

      JFCustomWidget.hideWidgetError && JFCustomWidget.hideWidgetError();
      JFCustomWidget.setFieldsValueByLabel(pairs);
      resultBox && (resultBox.innerHTML = '<div class="ok" style="display:block">Fields have been auto-filled from selected sources.</div>');
      ok('Prefilled.');
    }catch(e){
      resultBox && (resultBox.innerHTML = `<div class="err" style="display:block">${e?.message||'Prefill failed.'}</div>`);
      err(e?.message||'Prefill failed.');
    }finally{
      prefillBtn.disabled = false;
      prefillBtn.textContent = original;
    }
  });

  // ---------- Widget value emitter ----------
  const emit = debounce(()=>{
    const payload = {
      formId,
      apiBase,
      sources: sources.map(s=>({ id:s.id, name:s.name, url:s.url, keyCol:s.keyCol, headers:s.headers || [], rowsCount:(s.rows||[]).length })),
      mapping,
      selectedRows: Object.keys(selectedRows).map(sid=>({ sourceId:sid })),
      mapCollapsed
    };
    try{ JFCustomWidget.sendData({ value: JSON.stringify(payload) }); }catch(_){}
  }, 600);
  function emitWidgetValue(){ emit(); }
  window.addEventListener('storage', emitWidgetValue);

  // ---------- Boot ----------
  function boot(){
    if (formIdLabel) formIdLabel.textContent = formId ? `Form ID: ${formId}` : 'Form ID not available';
    applyMapCollapsed();
    renderSourcesDropdown();
    renderRowsList();
    renderSelectedHint();
    renderSelectedChips();
    renderMappingTable();
    renderPreviews();
  }
  boot();
})();
