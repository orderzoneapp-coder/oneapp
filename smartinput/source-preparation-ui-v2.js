(() => {
  'use strict';
  if ((document.documentElement.dataset.nexusUiApp || '') !== 'smart-input') return;
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const byId=id=>document.getElementById(id);
  let model=null, modelKey='', staged=new Map(), applying=false, refreshQueued=false;
  function installStyle() {
    if (byId('smartInputSourcePreparationStyle')) return;
    const style = document.createElement('style');
    style.id = 'smartInputSourcePreparationStyle';
    style.textContent = `
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
    let panel=byId('sourcePreparationMapping');
    if(panel) return panel;
    const parser=byId('sourceInputPanel');
    if(!parser) return null;
    panel=document.createElement('section');
    panel.id='sourcePreparationMapping'; panel.className='source-preparation-mapping'; panel.hidden=true;
    panel.setAttribute('aria-label','원본 열 항목 매핑');
    panel.innerHTML='<header class="source-preparation-mapping__head"><div><strong>원본 열 → 사용할 항목</strong><small id="sourcePreparationMeta"></small></div></header><div class="source-preparation-mapping__list" id="sourcePreparationList"></div><div class="source-preparation-mapping__status" id="sourcePreparationStatus" role="status" aria-live="polite"></div><button class="source-preparation-mapping__apply" id="sourcePreparationApply" type="button"><strong>준비한 자료 적용</strong><small>매핑 완료 후 중앙 작업표에 한 번에 반영</small></button>';
    const progress=byId('parserProgress');
    if(progress?.parentNode===parser) progress.insertAdjacentElement('afterend',panel); else parser.appendChild(panel);
    byId('sourcePreparationList').addEventListener('change',event=>{
      const select=event.target.closest('[data-source-column]');
      if(!select) return;
      staged.set(Number(select.dataset.sourceColumn),select.value);
      const row=select.closest('.source-preparation-mapping__row');
      row.dataset.state=select.value==='__UNMAPPED__'?'UNMAPPED':select.value?'MAPPED':'UNDECIDED';
      updateStatus();
    });
    byId('sourcePreparationApply').addEventListener('click',applyStaged);
    return panel;
  }

  function refresh() {
    refreshQueued=false;
    if(applying) return;
    const panel=ensurePanel(); if(!panel) return;
    model=window.SMARTINPUT_SOURCE_PREPARATION?.snapshot()||null;
    if(!model) {panel.hidden=true;modelKey='';staged=new Map();return;}
    if(model.key!==modelKey) {modelKey=model.key;staged=new Map();}
    panel.hidden=false;
    const current=new Map(model.mappings.map(mapping=>[mapping.columnIndex,mapping]));
    model.headers.forEach((header,index)=>{
      if(staged.has(index))return;
      const mapping=current.get(index);
      staged.set(index,mapping?.state==='UNMAPPED'?'__UNMAPPED__':mapping?.targetFieldId||'');
    });
    byId('sourcePreparationMeta').textContent=[model.templateName,model.fileName,model.headers.length+'열'].filter(Boolean).join(' · ');
    byId('sourcePreparationList').innerHTML=model.headers.map((header,column)=>{
      const mapping=current.get(column), value=staged.get(column)||'';
      const state=value==='__UNMAPPED__'?'UNMAPPED':value?'MAPPED':'UNDECIDED';
      const detail=mapping?.informationGroup||(model.targets.find(target=>target.id===value)?.scope==='header'?'전표정보':'입력·참조정보');
      const options='<option value=""'+(!value?' selected':'')+'>항목 선택</option>'
        +'<option value="__UNMAPPED__"'+(value==='__UNMAPPED__'?' selected':'')+'>사용 안 함</option>'
        +model.targets.map(target=>'<option value="'+esc(target.id)+'"'+(target.id===value?' selected':'')+'>'+esc(target.label)+'</option>').join('');
      return '<label class="source-preparation-mapping__row" data-state="'+state+'"><span><b>'+String(column+1)+'. '+esc(header)+'</b><small>'+esc(detail)+'</small></span><select data-source-column="'+column+'">'+options+'</select></label>';
    }).join('');
    updateStatus();
  }

  function updateStatus(message='') {
    const button=byId('sourcePreparationApply'),status=byId('sourcePreparationStatus');
    if(!button||!status)return;
    const values=(model?.headers||[]).map((_,index)=>staged.get(index)||'');
    const mapped=values.filter(value=>value&&value!=='__UNMAPPED__');
    const excluded=values.filter(value=>value==='__UNMAPPED__').length;
    const missing=values.filter(value=>!value).length;
    const projections=mapped.map(id=>model.targets.find(target=>target.id===id)?.projectionFieldId||id);
    const duplicate=new Set(projections).size!==projections.length;
    status.textContent=message||(duplicate?'같은 사용할 항목이 중복 지정되었습니다.':missing?'매핑 '+mapped.length+' · 사용 안 함 '+excluded+' · 확인 필요 '+missing:'매핑 '+mapped.length+' · 사용 안 함 '+excluded+' · '+values.length+'열 확인 완료');
    button.disabled=applying||Boolean(model?.busy)||!values.length||duplicate||missing>0;
  }

  function applyStaged() {
    if(applying||!model)return;
    applying=true; updateStatus('매핑 적용 중');
    let message='';
    try {
      const decisions=model.headers.map((_,columnIndex)=>{
        const value=staged.get(columnIndex)||'';
        return {columnIndex,state:value==='__UNMAPPED__'?'UNMAPPED':'MAPPED',targetFieldId:value==='__UNMAPPED__'?'':value};
      });
      window.SMARTINPUT_SOURCE_PREPARATION.apply(modelKey,decisions);
      staged=new Map();
      message='중앙 작업표에 적용했습니다.';
    } catch(error) {message='적용 중단 · '+(error.message||'매핑을 적용하지 못했습니다.');}
    finally {applying=false;refresh();updateStatus(message);}
  }

  function queueRefresh() {
    if(refreshQueued)return;
    refreshQueued=true;setTimeout(refresh,50);
  }
  function boot() {installStyle();ensurePanel();queueRefresh();}
  window.addEventListener('smartinput:source-preparation-changed',queueRefresh);
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
