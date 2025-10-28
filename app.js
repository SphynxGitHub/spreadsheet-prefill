/* globals JFCustomWidget, JF */
(function(){
  // ---------- State ----------
  let formId = null;
  let apiKey = localStorage.getItem('lf_apiKey') || '';
  let apiBase = localStorage.getItem('lf_apiBase') || 'https://api.jotform.com';

  /** sources: [{id,name,url,keyCol, headers:[], rows:[{}]}] */
  let sources = JSON.parse(localStorage.getItem('lf_sources')||'[]');
  /** mapping: { [qid]: { sourceId, column } } */
  let mapping = JSON.parse(localStorage.getItem('lf_mapping')||'{}');

  let questions = []; // [{qid,label,type,name,order}]
  let activeSourceId = sources[0]?.id || null;
  let selectedRow = null; // raw row object from the chosen source

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const flashOk = $('flashOk'), flashErr = $('flashErr');
  const formIdLabel = $('formIdLabel');
  const loginBtn = $('loginBtn'), saveKey = $('saveKey'), loadFields = $('loadFields');
  const apiKeyIn = $('apiKey'), apiBaseSel = $('apiBase');

  const srcName = $('srcName'), srcUrl = $('srcUrl'), srcKeyCol = $('srcKeyCol');
  const addSource = $('addSource'), activeSource = $('activeSource');
  const lookupVal = $('lookupVal'), btnSearch = $('btnSearch'), btnReloadCsv = $('btnReloadCsv');
  const rowsList = $('rowsList');

  const mapTableBody = document.querySelector('#mapTable tbody');
  const clearMap = $('clearMap'), autoMap = $('autoMap');
  const rowPreview = $('rowPreview'), payloadPreview = $('payloadPreview');
  const createSubmit = $('createSubmit'), resultBox = $('resultBox');

  apiKeyIn.value = apiKey;
  apiBaseSel.value = apiBase;

  // ---------- Helpers ----------
  function ok(msg='Done.'){ flashOk.textContent=msg; flashOk.style.display='block'; setTimeout(()=>flashOk.style.display='none',1200); }
  function err(msg){ flashErr.textContent=msg; flashErr.style.display='block'; setTimeout(()=>flashErr.style.display='none',4000); }

  function uid(){ return 's_' + Math.random().toString(36).slice(2,10); }
  function saveSources(){ localStorage.setItem('lf_sources', JSON.stringify(sources)); emitWidgetValue(); }
  function saveMapping(){ localStorage.setItem('lf_mapping', JSON.stringify(mapping)); emitWidgetValue(); }

  function getSource(id){ return sources.find(s=>s.id===id) || null; }
  function allHeadersGrouped(){
    // [{label:'[Contacts] Email', sourceId, column, rawLabel}]
    const opts = [];
    sources.forEach(s=>{
      (s.headers||[]).forEach(h=>{
        opts.push({ label:`[${s.name}] ${h}`, sourceId:s.id, column:h, rawLabel:h });
      });
    });
    return opts;
  }

  function setActiveSource(id){
    activeSourceId = id;
    renderSourcesDropdown();
    renderRowsList();
  }

  function pickRow(row){ selectedRow = row; renderPreviews(); }

  function debounce(fn,ms=400){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

  // ---------- Form ID------------------
  let formId = null;  // stays
  let apiKey = localStorage.getItem('lf_apiKey') || '';
  let apiBase = localStorage.getItem('lf_apiBase') || 'https://api.jotform.com';
  let manualFormId = localStorage.getItem('lf_manualFormId') || '';
  
  const manualFormIdIn = document.getElementById('manualFormId');
  const saveFormIdBtn  = document.getElementById('saveFormId');
  if (manualFormIdIn) manualFormIdIn.value = manualFormId;
  
  // Try to pull a form id out of a URL string (live or builder)
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
  
      // Preview or other editors sometimes use /edit/… with ?formID=
      const q = u.searchParams.get('formID') || u.searchParams.get('formId');
      if (q && /^\d{8,20}$/.test(q)) return q;
    } catch (e) {}
    return null;
  }
  
  // Decide the best formId available
  function resolveFormId(payload) {
    // 1) widget payload
    if (payload && (payload.formId || payload.formID)) return String(payload.formId || payload.formID);
  
    // 2) referrer (parent page that loaded the widget)
    const fromRef = extractFormIdFromUrl(document.referrer);
    if (fromRef) return fromRef;
  
    // 3) manual override
    if (manualFormId && /^\d{8,20}$/.test(manualFormId)) return manualFormId;
  
    return null;
  }
  if (saveFormIdBtn) {
    saveFormIdBtn.addEventListener('click', () => {
      manualFormId = (manualFormIdIn?.value || '').trim();
      localStorage.setItem('lf_manualFormId', manualFormId);
      formId = manualFormId || formId; // adopt it immediately
      formIdLabel.textContent = formId ? `Form ID: ${formId}` : 'Form ID not available';
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
    // if keyCol missing, guess common ones
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
    questions = Object.keys(map).map(qid=>({
      qid,
      label: map[qid].text || '',
      type: map[qid].type || '',
      name: map[qid].name || '',
      order: map[qid].order || 0
    })).sort((a,b)=>a.order - b.order);
  }

  function buildSubmissionBody(rowBySource){
    // rowBySource: { [sourceId]: selectedRowObj }
    // mapping: { [qid]: { sourceId, column } }
    // For now: simple fields => submission[qid] = row[column]
    const data=new URLSearchParams();
    Object.keys(mapping).forEach(qid=>{
      const m = mapping[qid]; if(!m) return;
      const r = rowBySource[m.sourceId]; if(!r) return;
      const val = r[m.column] ?? '';
      data.append(`submission[${qid}]`, val);
    });
    return data;
  }

  async function createSubmission(body){
    if(!apiKey) throw new Error('Paste an API key or Login first.');
    if(!formId) throw new Error('Form ID not available.');
    const url = `${apiBase}/form/${formId}/submissions?apiKey=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
    if(!resp.ok) throw new Error(`Create submission failed: ${resp.status}`);
    const json=await resp.json();
    const c = json.content || {};
    const sid = c.id || c.submissionID || c.sid || null;
    if(!sid) throw new Error('Submission created but ID not found.');
    return String(sid);
  }

  // ---------- UI: Auth ----------
  JFCustomWidget.subscribe('ready', payload => {
    formId = resolveFormId(payload);
  
    formIdLabel.textContent = formId
      ? `Form ID: ${formId}`
      : 'Form ID not available — paste it above and click “Save Form ID”.';
  
    renderSourcesDropdown();
    renderRowsList();
    renderMappingTable();
    emitWidgetValue(); // push current saved config to parent
  });

  loginBtn.addEventListener('click', ()=>{
    JF.login(()=>{
      try{
        const k = JF.getAPIKey();
        if(k){ apiKey = k; apiKeyIn.value = k; localStorage.setItem('lf_apiKey', apiKey); ok('Authorized.'); }
        else err('Login ok, but API key not returned.');
      }catch(e){ err('Login ok, but API key not returned.'); }
    }, ()=> err('Login failed or canceled.'));
  });

  saveKey.addEventListener('click', ()=>{
    apiKey = apiKeyIn.value.trim();
    apiBase = apiBaseSel.value;
    localStorage.setItem('lf_apiKey', apiKey);
    localStorage.setItem('lf_apiBase', apiBase);
    ok('Saved.');
  });

  loadFields.addEventListener('click', async ()=>{
    try{
      await getQuestions();
      renderMappingTable();
      ok('Questions loaded.');
    }catch(e){ err(e.message||'Failed to load questions.'); }
  });

  // ---------- UI: Sources ----------
  function renderSourcesDropdown(){
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

  addSource.addEventListener('click', async ()=>{
    const name = (srcName.value||'').trim();
    const url = (srcUrl.value||'').trim();
    const keyCol = (srcKeyCol.value||'').trim();
    if(!name || !url){ err('Enter a tab name and CSV URL.'); return; }
    const s = { id:uid(), name, url, keyCol:keyCol||null, headers:null, rows:null };
    sources.push(s); saveSources();
    try{
      await loadSourceData(s);
      activeSourceId = s.id; renderSourcesDropdown(); renderRowsList(); renderMappingTable();
      ok('Source added.');
    }catch(e){
      err(e.message||'Failed to load CSV.');
    }
  });

  activeSource.addEventListener('change', ()=> setActiveSource(activeSource.value));

  btnReloadCsv.addEventListener('click', async ()=>{
    const s = getSource(activeSourceId); if(!s) return;
    try{ await loadSourceData(s); renderRowsList(); renderMappingTable(); ok('CSV reloaded.'); }
    catch(e){ err(e.message||'Reload failed.'); }
  });

  btnSearch.addEventListener('click', ()=> renderRowsList());

  lookupVal.addEventListener('keydown', e=>{
    if(e.key==='Enter') renderRowsList();
  });

  function renderRowsList(){
    const s = getSource(activeSourceId);
    rowsList.innerHTML = '';
    if(!s){ rowsList.innerHTML='<div class="mini">Pick or add a source.</div>'; return; }
    if(!s.headers){ rowsList.innerHTML='<div class="mini">No data loaded yet. Click “Reload CSV”.</div>'; return; }

    const q = (lookupVal.value||'').toLowerCase().trim();
    const keyCol = s.keyCol && s.headers.includes(s.keyCol) ? s.keyCol : s.headers[0];

    const subset = (s.rows||[]).filter(r=>{
      if(!q) return true;
      const v = String(r[keyCol]??'').toLowerCase();
      return v.includes(q);
    }).slice(0,200); // cap display

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
      d.textContent = q ? `No matches for "${lookupVal.value}" in ${keyCol}.` : 'No rows found.';
      rowsList.appendChild(d);
    }
  }

  // ---------- UI: Mapping ----------
  function renderMappingTable(){
    mapTableBody.innerHTML='';
    if(!questions.length){
      mapTableBody.innerHTML='<tr><td colspan="3" class="muted">Load Jotform questions first.</td></tr>';
      return;
    }
    const grouped = {}; // sourceId -> [columns]
    sources.forEach(s=> grouped[s.id] = (s.headers||[]).map(h=>({ column:h, source:s })) );

    questions.forEach(q=>{
      // Filter to common types first; you can loosen this if you want all
      const supported = true; // let’s allow mapping to any QID; advanced types can be enhanced later
      if(!supported) return;

      const tr=document.createElement('tr');
      const td1=document.createElement('td'); td1.textContent = `${q.label} (${q.type})`;
      const td2=document.createElement('td'); td2.textContent = q.qid;
      const td3=document.createElement('td');

      const sel=document.createElement('select');
      sel.innerHTML = `<option value="">— no mapping —</option>`;
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

      // restore saved mapping
      if(mapping[q.qid]){
        sel.value = JSON.stringify(mapping[q.qid]);
      }

      sel.addEventListener('change', ()=>{
        if(!sel.value){ delete mapping[q.qid]; }
        else mapping[q.qid] = JSON.parse(sel.value);
        saveMapping();
        renderPreviews();
      });

      td3.appendChild(sel);
      tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3);
      mapTableBody.appendChild(tr);
    });
  }

  clearMap.addEventListener('click', ()=>{
    mapping = {};
    saveMapping();
    renderMappingTable();
    renderPreviews();
  });

  autoMap.addEventListener('click', ()=>{
    // naive: match question label → column (case-insensitive exact)
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
    // Selected row may belong to one source. But mapping can reference multiple sources.
    // Build a per-source selected row object: use the clicked row for its source; for other sources, pick first row or none.
    const rowBySource = {};

    if(selectedRow && selectedRow.__sourceId){
      rowBySource[selectedRow.__sourceId] = selectedRow;
    }
    // If a mapping references other sources and we don't have a picked row there, just leave undefined.
    // (You could enhance to let user pick a row per source.)

    // Row preview = the clicked row only
    rowPreview.textContent = selectedRow ? JSON.stringify(selectedRow, null, 2) : '(no row selected)';

    // Payload preview
    const preview = {};
    Object.keys(mapping).forEach(qid=>{
      const m = mapping[qid];
      const r = rowBySource[m.sourceId];
      if(r) preview[`submission[${qid}]`] = r[m.column] ?? '';
    });
    payloadPreview.textContent = Object.keys(preview).length ? JSON.stringify(preview, null, 2) : '(no mapped values or no selected row)';
  }

  createSubmit.addEventListener('click', async ()=>{
    try{
      if(!selectedRow){ err('Pick a row first.'); return; }
      // We only have a row for its source; any mappings for other sources will be skipped in this minimal flow.
      const rowBySource = { [selectedRow.__sourceId]: selectedRow };
      const body = buildSubmissionBody(rowBySource);
      const sid = await createSubmission(body);
      const editUrl = `https://www.jotform.com/edit/${encodeURIComponent(sid)}`;
      resultBox.innerHTML = `<div class="ok" style="display:block">Created submission <b>${sid}</b>. <a href="${editUrl}" target="_top" rel="noopener">Open Edit Page</a></div>`;
      try{ window.top.location.href = editUrl; }catch(_){}
    }catch(e){ err(e.message||'Failed to create submission.'); }
  });

  // ---------- Widget value emitter (so you can capture config in the form) ----------
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

  // re-emit on notable changes
  window.addEventListener('storage', emitWidgetValue);

  // ---------- Kick things off ----------
  function boot(){
    renderSourcesDropdown();
    renderRowsList();
    renderMappingTable();
    renderPreviews();
  }
  boot();
})();
