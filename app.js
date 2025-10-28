/* globals JFCustomWidget, JF */
(function(){
  // ---------- Safe shims when testing outside Jotform ----------
  if (typeof window.JFCustomWidget === 'undefined') {
    window.JFCustomWidget = { subscribe: () => {}, sendData: () => {} };
  }
  if (typeof window.JF === 'undefined') {
    window.JF = { login: (ok, fail) => fail && fail(), getAPIKey: () => null };
  }

  // ---------- State ----------
  let formId = null;
  let apiKey  = localStorage.getItem('lf_apiKey')  || '';
  let apiBase = localStorage.getItem('lf_apiBase') || 'https://api.jotform.com';
  let manualFormId = localStorage.getItem('lf_manualFormId') || '';

  /** sources: [{id,name,url,keyCol, headers:[], rows:[{}]}] */
  let sources = JSON.parse(localStorage.getItem('lf_sources')||'[]');
  /** mapping: { [qid]: { sourceId, column } } */
  let mapping = JSON.parse(localStorage.getItem('lf_mapping')||'{}');

  // questions: [{qid,label,type,name,order, raw, isStatic, choices:[...], allowsMultiple:boolean}]
  let questions = [];
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

  // ---------- Helpers ----------
  function ok(msg='Done.'){ if(!flashOk) return; flashOk.textContent=msg; flashOk.style.display='block'; setTimeout(()=>flashOk.style.display='none',1600); }
  function err(msg){ if(!flashErr) return; flashErr.textContent=msg; flashErr.style.display='block'; setTimeout(()=>flashErr.style.display='none',6000); }

  function uid(){ return 's_' + Math.random().toString(36).slice(2,10); }
  function saveSources(){ localStorage.setItem('lf_sources', JSON.stringify(sources)); emitWidgetValue(); }
  function saveMapping(){ localStorage.setItem('lf_mapping', JSON.stringify(mapping)); emitWidgetValue(); }

  function getSource(id){ return sources.find(s=>s.id===id) || null; }
  function setActiveSource(id){ activeSourceId = id; renderSourcesDropdown(); renderRowsList(); }
  function pickRow(row){ selectedRow = row; renderPreviews(); emitWidgetValue(); }
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

  // ---------- Jotform question helpers ----------
  const STATIC_TYPES = new Set([
    'control_head','control_text','control_image','control_button','control_divider',
    'control_collapse','control_pagebreak','control_separator'
  ]);
  const MULTI_TYPES = new Set(['control_checkbox']); // allows multiple choices
  const SINGLE_TYPES_WITH_CHOICES = new Set(['control_dropdown','control_radio']);
  function isStaticType(t){ return STATIC_TYPES.has((t||'').toLowerCase()); }
  function allowsMultiple(t){ return MULTI_TYPES.has((t||'').toLowerCase()); }
  function hasChoices(t){ const tt=(t||'').toLowerCase(); return SINGLE_TYPES_WITH_CHOICES.has(tt) || MULTI_TYPES.has(tt); }

  function extractChoicesFromRaw(raw){
    // Jotform question raw often has "options" as:
    // - array of strings, or
    // - string "A|B|C", or
    // - object with .options or .items etc. We'll be defensive.
    const r = raw || {};
    let opts = [];

    if (Array.isArray(r.options)) {
      opts = r.options.slice();
    } else if (typeof r.options === 'string') {
      opts = r.options.split('|').map(s=>s.trim()).filter(Boolean);
    } else if (Array.isArray(r.items)) {
      opts = r.items.map(x => (typeof x==='string'?x:(x?.text||''))).filter(Boolean);
    } else if (typeof r.specialOptions === 'string') { // fallback if provided
      opts = r.specialOptions.split('|').map(s=>s.trim()).filter(Boolean);
    }

    // Dedup & clean
    const seen = new Set();
    const clean = [];
    opts.forEach(o=>{
      const k = String(o||'').trim();
      if (k && !seen.has(k)) { seen.add(k); clean.push(k); }
    });
    return clean;
  }

  async function getQuestions(){
    if(!apiKey) throw new Error('Paste an API key or Login first.');
    if(!formId) throw new Error('Form ID not available.');
  
    const url = `${apiBase}/form/${formId}/questions?apiKey=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, { mode:'cors' });
    if(!resp.ok) throw new Error(`Questions fetch failed: ${resp.status}`);
    const json = await resp.json();
    const map = json.content || {};
  
    // types to EXCLUDE from mapping (static / widget / layout)
    const EXCLUDE = new Set([
      'control_head','control_text','control_image','control_button',
      'control_pagebreak','control_collapse','control_widget'
    ]);
  
    // choice types we’ll add fixed values for
    const CHOICE_TYPES = new Set([
      'control_dropdown','control_radio','control_checkbox'
    ]);
  
    questions = Object.keys(map).map(qid => {
      const q = map[qid] || {};
      const type = q.type || '';
      const label = q.text || '';
      // parse options if any (Jotform usually pipes options, e.g. "A|B|C")
      const choices = CHOICE_TYPES.has(type)
        ? String(q.options || '')
            .split('|')
            .map(s => s.trim())
            .filter(Boolean)
        : [];
      return {
        qid,
        label,
        type,
        name: q.name || '',
        order: q.order || 0,
        choices
      };
    })
    .filter(q => !EXCLUDE.has(q.type)) // drop static/widget types
    .sort((a,b)=>a.order - b.order);
  }

  // Normalize a value for choice questions (respect allowed choices; support multi via comma/semicolon/pipe)
  function normalizeChoiceValue(q, rawVal){
    if (!hasChoices(q.type)) return rawVal;
    const choicesSet = new Set(q.choices.map(c => c.toLowerCase()));
    const splitIfMulti = v => String(v).split(/[;,|]/).map(s=>s.trim()).filter(Boolean);

    if (q.allowsMultiple) {
      const parts = Array.isArray(rawVal) ? rawVal : splitIfMulti(rawVal);
      const picked = parts
        .map(p => p.trim())
        .filter(p => choicesSet.has(p.toLowerCase()));
      // Jotform accepts comma-separated for checkbox
      return picked.join(', ');
    } else {
      const v = String(rawVal||'').trim();
      if (choicesSet.has(v.toLowerCase())) return v;
      // attempt loose match by case-insensitive contains
      const loose = q.choices.find(c => c.toLowerCase() === v.toLowerCase());
      return loose || ''; // if not valid, send empty to avoid API rejecting
    }
  }

  // ---------- Submission build/post ----------
  function buildSubmissionBody(rowBySource){
    const data = new URLSearchParams();
  
    Object.keys(mapping).forEach(qid=>{
      const m = mapping[qid]; if(!m) return;
  
      if (m.kind === 'sheet') {
        const r = rowBySource[m.sourceId]; if(!r) return;
        const val = r[m.column] ?? '';
        data.append(`submission[${qid}]`, val);
        return;
      }
  
      if (m.kind === 'fixed') {
        data.append(`submission[${qid}]`, m.value ?? '');
        return;
      }
  
      if (m.kind === 'fixedMulti') {
        const arr = Array.isArray(m.values) ? m.values : [];
        // Jotform checkboxes accept comma-separated values
        data.append(`submission[${qid}]`, arr.join(', '));
        return;
      }
  
      if (m.kind === 'text') {
        data.append(`submission[${qid}]`, m.value ?? '');
        return;
      }
    });
  
    return data;
  }
  
  createSubmit && createSubmit.addEventListener('click', async ()=>{
    if(!selectedRow){ err('Pick a row first.'); return; }
  
    createSubmit.disabled = true;
    const originalLabel = createSubmit.textContent;
    createSubmit.textContent = 'Creating…';
  
    try{
      const rowBySource = { [selectedRow.__sourceId]: selectedRow };
      const body = buildSubmissionBody(rowBySource);
      const sid = await createSubmission(body);
      const editUrl = `https://www.jotform.com/edit/${encodeURIComponent(sid)}`;
  
      if (resultBox) {
        resultBox.innerHTML = `
          <div class="ok" style="display:block">
            Created submission <b>${sid}</b>.
            <a href="${editUrl}" target="_blank" rel="noopener">Open Edit Page</a>
          </div>`;
      }
  
      // Try opening in a new tab and also attempt top redirect (may be blocked by sandbox; new tab is safer)
      try { window.open(editUrl, '_blank', 'noopener'); } catch(_) {}
      try { window.top.location.href = editUrl; } catch(_) {} // harmless if blocked
    }catch(e){
      err(e.message || 'Failed to create submission.');
    }finally{
      createSubmit.disabled = false;
      createSubmit.textContent = originalLabel;
    }
  });

  async function createSubmission(body){
    if(!apiKey) throw new Error('Paste an API key or Login first.');
    if(!formId) throw new Error('Form ID not available.');
    const url = `${apiBase}/form/${formId}/submissions?apiKey=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
    let text;
    try { text = await resp.text(); } catch(_){}
    if(!resp.ok){
      // Try to surface API error content
      let msg = `Create submission failed: ${resp.status}`;
      if (text) {
        try {
          const j = JSON.parse(text);
          if (j && (j.message || j.error || j.details)) {
            msg += ` — ${j.message || j.error || j.details}`;
          } else {
            msg += ` — ${text.slice(0,300)}`;
          }
        } catch(_) {
          msg += ` — ${text.slice(0,300)}`;
        }
      }
      throw new Error(msg);
    }
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch(_){}
    const c = json.content || {};
    const sid = c.id || c.submissionID || c.sid || null;
    if(!sid) throw new Error('Submission created but ID not found.');
    return String(sid);
  }

  // ---------- UI: Auth ----------
  JFCustomWidget.subscribe('ready', payload => {
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
          await loadSourceData(existing); // refresh headers/rows
          activeSourceId = existing.id;
          renderSourcesDropdown(); renderRowsList(); renderMappingTable();
          ok('Updated existing source.');
        } catch (e) { err(e.message || 'Failed to refresh the existing source.'); }
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
      } catch (e) { err(e.message || 'Failed to load CSV.'); }
    });
  }

  activeSource && activeSource.addEventListener('change', ()=> setActiveSource(activeSource.value));

  btnReloadCsv && btnReloadCsv.addEventListener('click', async ()=>{
    const s = getSource(activeSourceId); if(!s) return;
    try{ await loadSourceData(s); renderRowsList(); renderMappingTable(); ok('CSV reloaded.'); }
    catch(e){ err(e.message||'Reload failed.'); }
  });

  btnSearch && btnSearch.addEventListener('click', ()=> renderRowsList());

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
    emitWidgetValue();
    ok('Source removed.');
  });

  lookupVal && lookupVal.addEventListener('keydown', e=>{
    if(e.key==='Enter') renderRowsList();
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

  // ---------- UI: Mapping ----------
  function renderMappingTable(){
    if(!mapTableBody) return;
    mapTableBody.innerHTML='';
  
    if(!questions.length){
      mapTableBody.innerHTML='<tr><td colspan="3" class="muted">Load Jotform questions first.</td></tr>';
      return;
    }
  
    // group sheet columns per source
    const grouped = {}; // sourceId -> [columns]
    sources.forEach(s => grouped[s.id] = (s.headers||[]).map(h => ({ column:h, source:s })) );
  
    questions.forEach(q=>{
      const tr=document.createElement('tr');
  
      const td1=document.createElement('td'); td1.textContent = `${q.label} (${q.type})`;
      const td2=document.createElement('td'); td2.textContent = q.qid;
      const td3=document.createElement('td');
  
      const sel=document.createElement('select');
      sel.style.minWidth = '260px';
  
      // default
      sel.innerHTML = `<option value="">— no mapping —</option>`;
  
      // From Sheets (optgroups by source)
      Object.keys(grouped).forEach(sid=>{
        const s = getSource(sid); if(!s || !s.headers) return;
        const og = document.createElement('optgroup'); og.label = `From Sheets — ${s.name}`;
        grouped[sid].forEach(o=>{
          const opt=document.createElement('option');
          opt.value = JSON.stringify({ kind:'sheet', sourceId:sid, column:o.column });
          opt.textContent = o.column;
          og.appendChild(opt);
        });
        sel.appendChild(og);
      });
  
      // Fixed values from the form’s own choices (if applicable)
      if ((q.choices||[]).length) {
        const og = document.createElement('optgroup');
        og.label = 'Fixed values — Form choices';
        q.choices.forEach(choice=>{
          const opt=document.createElement('option');
          opt.value = JSON.stringify({ kind:'fixed', value:choice });
          opt.textContent = choice;
          og.appendChild(opt);
        });
  
        // If multi-select allowed (checkbox), add a special "Multiple…" option
        if (q.type === 'control_checkbox') {
          const multiOpt = document.createElement('option');
          multiOpt.value = JSON.stringify({ kind:'fixedMultiPrompt' });
          multiOpt.textContent = 'Multiple…';
          og.appendChild(multiOpt);
        }
  
        sel.appendChild(og);
      }
  
      // "Other…" free-entry option (always available)
      {
        const og = document.createElement('optgroup');
        og.label = 'Custom';
        const otherOpt = document.createElement('option');
        otherOpt.value = JSON.stringify({ kind:'textPrompt' });
        otherOpt.textContent = 'Other… (type in a custom value)';
        og.appendChild(otherOpt);
        sel.appendChild(og);
      }
  
      // restore saved mapping
      if(mapping[q.qid]){
        sel.value = JSON.stringify(mapping[q.qid]);
      }
  
      // inline editor area for multi/other (appears when chosen)
      const inlineWrap = document.createElement('div');
      inlineWrap.style.marginTop = '6px';
      inlineWrap.style.display = 'none';
  
      function showInlineEditor(config){
        inlineWrap.innerHTML = '';
        inlineWrap.style.display = 'block';
  
        if (config.kind === 'text') {
          // single free-text
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.placeholder = 'Enter custom value…';
          inp.style.minWidth = '260px';
          inp.value = config.value || '';
          inlineWrap.appendChild(inp);
  
          const saveBtn = document.createElement('button');
          saveBtn.textContent = 'Save';
          saveBtn.className = 'btn';
          saveBtn.style.marginLeft = '6px';
          inlineWrap.appendChild(saveBtn);
  
          saveBtn.addEventListener('click', ()=>{
            mapping[q.qid] = { kind:'text', value: inp.value || '' };
            saveMapping();
            // reflect in <select> too
            sel.value = JSON.stringify(mapping[q.qid]);
            ok('Saved.');
          });
        }
  
        if (config.kind === 'fixedMulti') {
          // multi-choice chooser (checkboxes)
          const choices = q.choices || [];
          if (!choices.length) {
            inlineWrap.textContent = 'This field has no defined choices.';
            return;
          }
  
          const holder = document.createElement('div');
          holder.style.display = 'grid';
          holder.style.gridTemplateColumns = 'repeat(auto-fit, minmax(160px, 1fr))';
          holder.style.gap = '4px';
  
          const selected = new Set(config.values || []);
          choices.forEach(ch=>{
            const lab = document.createElement('label');
            lab.style.display = 'flex'; lab.style.alignItems = 'center'; lab.style.gap = '6px';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = selected.has(ch);
            cb.addEventListener('change', ()=> {
              if (cb.checked) selected.add(ch); else selected.delete(ch);
            });
            lab.appendChild(cb);
            lab.appendChild(document.createTextNode(ch));
            holder.appendChild(lab);
          });
          inlineWrap.appendChild(holder);
  
          const saveBtn = document.createElement('button');
          saveBtn.textContent = 'Save';
          saveBtn.className = 'btn';
          saveBtn.style.marginTop = '6px';
          inlineWrap.appendChild(saveBtn);
  
          saveBtn.addEventListener('click', ()=>{
            mapping[q.qid] = { kind:'fixedMulti', values: Array.from(selected) };
            saveMapping();
            sel.value = JSON.stringify(mapping[q.qid]);
            ok('Saved.');
          });
        }
      }
  
      sel.addEventListener('change', ()=>{
        if(!sel.value){
          delete mapping[q.qid];
          inlineWrap.style.display = 'none';
          saveMapping();
          renderPreviews();
          return;
        }
  
        const chosen = JSON.parse(sel.value);
  
        // trigger prompts/editors
        if (chosen.kind === 'textPrompt') {
          inlineWrap.style.display = 'block';
          showInlineEditor({ kind:'text', value: '' });
          return;
        }
        if (chosen.kind === 'fixedMultiPrompt') {
          inlineWrap.style.display = 'block';
          showInlineEditor({ kind:'fixedMulti', values: [] });
          return;
        }
  
        // normal selections (sheet column or single fixed choice)
        mapping[q.qid] = chosen;
        inlineWrap.style.display = 'none';
        saveMapping();
        renderPreviews();
      });
  
      td3.appendChild(sel);
      td3.appendChild(inlineWrap);
  
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
      if(cand) mapping[q.qid] = cand;
    });
    saveMapping();
    renderMappingTable();
    renderPreviews();
    ok('Auto-mapped where labels matched.');
  });

  // ---------- Preview & Submit ----------
  function renderPreviews(){
    const rowBySource = {};
    if(selectedRow && selectedRow.__sourceId){
      rowBySource[selectedRow.__sourceId] = selectedRow;
    }
    if (rowPreview) rowPreview.textContent = selectedRow ? JSON.stringify(selectedRow, null, 2) : '(no row selected)';

    // Build preview respecting choice normalization
    const preview = {};
    Object.keys(mapping).forEach(qid=>{
      const m = mapping[qid];
      const r = rowBySource[m?.sourceId];
      if(!r) return;
      const q = questions.find(qq => qq.qid === qid);
      const rawVal = r[m.column] ?? '';
      const val = q ? normalizeChoiceValue(q, rawVal) : rawVal;
      preview[`submission[${qid}]`] = val;
    });
    if (payloadPreview) payloadPreview.textContent = Object.keys(preview).length ? JSON.stringify(preview, null, 2) : '(no mapped values or no selected row)';
  }

  // Button loading helper
  function setBusy(btn, busy=true){
    if (!btn) return;
    if (busy){
      btn.disabled = true;
      btn.dataset.label = btn.textContent;
      btn.textContent = 'Submitting…';
    } else {
      btn.disabled = false;
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
      delete btn.dataset.label;
    }
  }

  createSubmit && createSubmit.addEventListener('click', async ()=>{
    try{
      if(!selectedRow){ err('Pick a row first.'); return; }
      if(!apiKey){ err('Authorize or paste API key first.'); return; }
      if(!formId){ err('Form ID not available. Click “Save Form ID” or open from a form page.'); return; }

      setBusy(createSubmit, true);
      const rowBySource = { [selectedRow.__sourceId]: selectedRow };
      const body = buildSubmissionBody(rowBySource);
      const sid = await createSubmission(body);
      const editUrl = `https://www.jotform.com/edit/${encodeURIComponent(sid)}`;
      if (resultBox) resultBox.innerHTML = `<div class="ok" style="display:block">Created submission <b>${sid}</b>. <a href="${editUrl}" target="_top" rel="noopener">Open Edit Page</a></div>`;
      try{ window.top.location.href = editUrl; }catch(_){}
    }catch(e){
      err(e.message||'Failed to create submission.');
    }finally{
      setBusy(createSubmit, false);
    }
  });

  // ---------- Widget value emitter ----------
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
