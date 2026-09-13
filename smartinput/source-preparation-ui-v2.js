(() => {
  'use strict';
  if ((document.documentElement.dataset.nexusUiApp || '') !== 'smart-input') return;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const byId = id => document.getElementById(id);
  let targets = [];
  let staged = new Map();
  let probing = false;
  let applying = false;
  let refreshQueued = false;

  function installStyle() {
    if (byId('smartInputSourcePreparationStyle')) return;
    const style = document.createElement('style');
    style.id = 'smartInputSourcePreparationStyle';
    style.textContent = `
      #mappingWorktable { display:none !important; }
      #tableViewSwitch { display:none !important; }
      .smartinput-mapping-probe .field-mapping-dialog { visibility:hidden !important; pointer-events:none !important; }
      .source-preparation-mapping { margin-top:8px; min-height:0; display:flex; flex-direction:column; overflow:hidden; border:1px solid var(--border-strong); border-radius:9px; background:var(--surface-muted); }
      .source-preparation-mapping[hidden] { display:none !important; }
      .source-preparation-mapping__head { padding:9px 10px; border-bottom:1px solid var(--border); background:var(--surface-strong); }
      .source-preparation-mapping__head div { min-width:0; display:grid; gap:2px; }
      .source-preparation-mapping__head strong { color:var(--navy); font-size:11px; }
      .source-preparation-mapping__head small { overflow:hidden; color:var(--text-faint); font-size:9px; text-overflow:ellipsis; white-space:nowrap; }
      .source-preparation-mapping__list { max-height:340px; padding:6px; overflow:auto; display:grid; gap:4px; }
      .source-preparation-mapping__row { min-width:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(118px,42%); align-items:center; gap:6px; padding:5px 6px; border:1px solid var(--border); border-radius:6px; background:var(--surface); }
      .source-preparation-mapping__row > span { min-width:0; display:grid; gap:1px; }
      .source-preparation-mapping__row b { overflow:hidden; color:var(--text); font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
      .source-preparation-mapping__row small { overflow:hidden; color:var(--text-faint); font-size:8px; text-overflow:ellipsis; white-space:nowrap; }
      .source-preparation-mapping__row select { min-width:0; width:100%; height:28px; padding:0 6px; border:1px solid var(--border-strong); border-radius:5px; color:var(--text); background:var(--surface); font-size:10px; }
      .source-preparation-mapping__row[data-state="MAPPED"] { border-color:color-mix(in srgb,var(--success) 42%,var(--border)); }
      .source-preparation-mapping__row[data-state="RECOMMENDED"] { border-color:color-mix(in srgb,var(--warning) 48%,var(--border)); }
      .source-preparation-mapping__status { min-height:28px; padding:7px 10px; color:var(--text-soft); border-top:1px solid var(--border); font-size:9px; }
      .source-preparation-mapping__apply { margin:0 7px 7px; min-height:46px; display:grid; place-content:center; gap:1px; border:0; border-radius:7px; color:#fff; background:var(--accent-fill); }
      .source-preparation-mapping__apply strong { font-size:11px; }
      .source-preparation-mapping__apply small { color:#cce9e5; font-size:8px; }
      .source-preparation-mapping__apply:disabled { opacity:.48; cursor:not-allowed; }
      #voucherInputTable .nexus-table-column-tool { width:auto; min-width:0; height:20px; margin:-1px 0 -1px 4px; padding:0 5px; opacity:0; pointer-events:none; border-color:transparent; background:transparent; transition:opacity .12s ease,background .12s ease; font-size:9px; }
      #voucherInputTable .nexus-table-column-tool::before { content:"필터" !important; }
      #voucherInputTable thead th:hover > .nexus-table-column-tool,
      #voucherInputTable thead th:focus-within > .nexus-table-column-tool,
      #voucherInputTable .nexus-table-column-tool[aria-expanded="true"],
      #voucherInputTable .nexus-table-column-tool[data-active="true"] { opacity:1; pointer-events:auto; }
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    let panel = byId('sourcePreparationMapping');
    if (panel) return panel;
    const parser = byId('sourceInputPanel');
    if (!parser) return null;
    panel = document.createElement('section');
    panel.id = 'sourcePreparationMapping';
    panel.className = 'source-preparation-mapping';
    panel.hidden = true;
    panel.setAttribute('aria-label', '원본 열 항목 매핑');
    panel.innerHTML = `<header class="source-preparation-mapping__head"><div><strong>원본 열 → 사용할 항목</strong><small id="sourcePreparationMeta">Excel·불러온 데이터의 항목을 좌측에서 확정합니다.</small></div></header><div class="source-preparation-mapping__list" id="sourcePreparationList"></div><div class="source-preparation-mapping__status" id="sourcePreparationStatus" role="status" aria-live="polite"></div><button class="source-preparation-mapping__apply" id="sourcePreparationApply" type="button"><strong>준비한 자료 적용</strong><small>매핑 완료 후 중앙 작업표에 한 번에 반영</small></button>`;
    const progress = byId('parserProgress');
    if (progress?.parentNode === parser) progress.insertAdjacentElement('afterend', panel); else parser.appendChild(panel);
    byId('sourcePreparationList').addEventListener('change', event => {
      const select = event.target.closest('[data-source-column]');
      if (!select) return;
      staged.set(Number(select.dataset.sourceColumn), select.value);
      updateStatus();
    });
    byId('sourcePreparationApply').addEventListener('click', () => void applyStaged());
    return panel;
  }

  const mappingHeaders = () => [...document.querySelectorAll('#mappingTableHeaders th[data-mapping-column]')];
  const guessedTargetId = stateText => targets.filter(target => String(stateText || '').includes(target.label)).sort((a,b)=>b.label.length-a.label.length)[0]?.id || '';

  async function probeTargets() {
    if (targets.length || probing || applying) return;
    const first = mappingHeaders()[0]?.querySelector('[data-open-field-mapping]');
    if (!first) return;
    probing = true;
    document.documentElement.classList.add('smartinput-mapping-probe');
    try {
      first.click();
      for (let i=0;i<20;i+=1) {
        const dialog = document.querySelector('.field-mapping-dialog[open]');
        if (dialog) {
          targets = [...dialog.querySelectorAll('[data-mapping-target]')].map(button => ({id:button.dataset.mappingTarget,label:button.querySelector('strong')?.textContent?.trim() || button.dataset.mappingTarget})).filter(target=>target.id);
          dialog.querySelector('[data-close]')?.click();
          if (dialog.open) dialog.close();
          break;
        }
        await sleep(25);
      }
    } finally {
      document.documentElement.classList.remove('smartinput-mapping-probe');
      probing = false;
    }
  }

  function renderPanel() {
    const panel = ensurePanel();
    if (!panel) return;
    const headers = mappingHeaders();
    if (!headers.length) { panel.hidden = true; return; }
    panel.hidden = false;
    const fileName = byId('sourceSheetTitle')?.textContent?.trim() || '불러온 자료';
    byId('sourcePreparationMeta').textContent = `${fileName} · ${headers.length}열 · 매핑을 확정한 뒤 적용하세요.`;
    byId('sourcePreparationList').innerHTML = headers.map((header, order) => {
      const column = Number(header.dataset.mappingColumn);
      const source = header.querySelector('strong')?.textContent?.trim() || `${order+1}열`;
      const stateText = header.querySelector('small')?.textContent?.trim() || '매핑을 지정하세요';
      const state = header.dataset.mappingState || 'UNDECIDED';
      let value = staged.get(column) || '';
      if (!staged.has(column)) {
        if (/비매핑/.test(stateText)) value = '__UNMAPPED__'; else value = guessedTargetId(stateText);
        if (state === 'MAPPED' || state === 'UNMAPPED') staged.set(column, value);
      }
      const options = [`<option value="" ${value===''?'selected':''}>항목 선택</option>`,`<option value="__UNMAPPED__" ${value==='__UNMAPPED__'?'selected':''}>비매핑 · 제외</option>`,...targets.map(target=>`<option value="${esc(target.id)}" ${value===target.id?'selected':''}>${esc(target.label)}</option>`)].join('');
      return `<label class="source-preparation-mapping__row" data-state="${esc(state)}"><span><b>${order+1}. ${esc(source)}</b><small>${esc(stateText)}</small></span><select data-source-column="${column}">${options}</select></label>`;
    }).join('');
    updateStatus();
  }

  function updateStatus() {
    const headers = mappingHeaders();
    const values = headers.map(header => staged.get(Number(header.dataset.mappingColumn)) || '');
    const undecided = values.filter(value=>!value).length;
    const mapped = values.filter(value=>value && value!=='__UNMAPPED__').length;
    const excluded = values.filter(value=>value==='__UNMAPPED__').length;
    const ids = values.filter(value=>value && value!=='__UNMAPPED__');
    const duplicate = ids.length !== new Set(ids).size;
    const status = byId('sourcePreparationStatus');
    const apply = byId('sourcePreparationApply');
    if (!status || !apply) return;
    status.textContent = duplicate ? '같은 사용할 항목이 중복 지정되었습니다.' : undecided ? `매핑 ${mapped} · 제외 ${excluded} · 확인 필요 ${undecided}` : `매핑 ${mapped} · 제외 ${excluded} · ${headers.length}열 확인 완료`;
    apply.disabled = applying || duplicate || undecided > 0 || headers.length === 0;
  }

  async function openDialog(column) {
    const button = document.querySelector(`#mappingTableHeaders [data-mapping-column="${column}"] [data-open-field-mapping]`);
    if (!button) throw new Error(`${column+1}열 매핑 항목을 찾지 못했습니다.`);
    button.click();
    for (let i=0;i<30;i+=1) { const dialog=document.querySelector('.field-mapping-dialog[open]'); if (dialog) return dialog; await sleep(20); }
    throw new Error(`${column+1}열 매핑 창을 열지 못했습니다.`);
  }

  async function choose(column, value) {
    const dialog = await openDialog(column);
    if (value === '__UNMAPPED__') {
      const button = dialog.querySelector('[data-unmap]');
      if (!button) throw new Error(`${column+1}열 비매핑 기능을 찾지 못했습니다.`);
      button.click();
    } else {
      let button = [...dialog.querySelectorAll('[data-mapping-target]')].find(node=>node.dataset.mappingTarget===value);
      if (!button) {
        const target = targets.find(item=>item.id===value), search=dialog.querySelector('[data-mapping-search]');
        if (search && target) { search.value=target.label; search.dispatchEvent(new Event('input',{bubbles:true})); await sleep(20); button=[...dialog.querySelectorAll('[data-mapping-target]')].find(node=>node.dataset.mappingTarget===value); }
      }
      if (!button || button.disabled) throw new Error(`${column+1}열 선택 항목을 적용할 수 없습니다.`);
      button.click();
    }
    await sleep(25);
    if (dialog.open) dialog.close();
  }

  async function applyStaged() {
    if (applying) return;
    const desired = mappingHeaders().map(header=>({column:Number(header.dataset.mappingColumn),state:header.dataset.mappingState||'',value:staged.get(Number(header.dataset.mappingColumn))||'',currentText:header.querySelector('small')?.textContent?.trim()||''}));
    const ids = desired.map(item=>item.value).filter(value=>value && value!=='__UNMAPPED__');
    if (desired.some(item=>!item.value) || ids.length!==new Set(ids).size) return updateStatus();
    applying = true; updateStatus();
    const status = byId('sourcePreparationStatus');
    try {
      const changed = desired.filter(item=>item.state!=='MAPPED' || guessedTargetId(item.currentText)!==item.value);
      status.textContent = `매핑 적용 중 · ${changed.length}열 확인`;
      for (const item of changed) if (item.state==='MAPPED' || item.state==='RECOMMENDED') await choose(item.column,'__UNMAPPED__');
      for (const item of changed) if (item.value!=='__UNMAPPED__') await choose(item.column,item.value);
      document.querySelector('[data-table-view="input"]')?.click();
      await sleep(40);
      staged = new Map();
      status.textContent = '매핑 저장 완료 · 중앙 작업표에 적용했습니다.';
      queueRefresh(true);
    } catch (error) { status.textContent = `적용 중단 · ${error.message || '매핑을 적용하지 못했습니다.'}`; }
    finally { applying=false; updateStatus(); }
  }

  async function refresh(forceProbe=false) {
    refreshQueued=false;
    const headers=mappingHeaders();
    if (!headers.length) { renderPanel(); return; }
    if ((forceProbe || !targets.length) && !probing && !applying) await probeTargets();
    renderPanel();
    if (byId('mappingWorktable')) byId('mappingWorktable').hidden=true;
    if (byId('voucherInputTable') && !applying) byId('voucherInputTable').hidden=false;
  }

  function queueRefresh(forceProbe=false) {
    if (refreshQueued || applying || probing) return;
    refreshQueued=true;
    setTimeout(()=>void refresh(forceProbe),50);
  }

  function boot() {
    installStyle();
    ensurePanel();
    const headers=byId('mappingTableHeaders');
    if (headers) new MutationObserver(()=>queueRefresh()).observe(headers,{childList:true,subtree:true,attributes:true,attributeFilter:['data-mapping-state']});
    queueRefresh(true);
  }

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot,{once:true}); else boot();
})();
