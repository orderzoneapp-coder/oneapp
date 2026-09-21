// Temporary integration follow-up, removed before PR.
import fs from 'node:fs';
import assert from 'node:assert/strict';
let main=fs.readFileSync('smartinput/smartinput.js','utf8');
const anchor='function mappingTargetWorkerLabel(target) {';
assert.equal(main.split(anchor).length,2);
main=main.replace(anchor,String.raw`// Left preparation uses mapping data directly; it never opens a hidden dialog
// or depends on the source-table view having been rendered first.
function sourcePreparationSnapshot() {
  const current=modeDraft();
  const session=inputMappingSession(current);
  if (!session || current.activeMethod !== 'excel') return null;
  const selected=new Set(session.mappings.map(mapping=>mapping.targetFieldId));
  const targets=inputMappingDefinitions().filter(target=>selected.has(target.id)
    || (target.pickerVisible !== false && !target.registryField));
  return {
    key: [state.draft.activeMode,current.documentId,session.sessionId].join(':'),
    fileName: session.fileName, templateName: session.templateName,
    headers: [...session.headers], mappings: session.mappings.map(mapping=>({...mapping})),
    targets: targets.map(target=>({id:target.id,label:target.label,projectionFieldId:target.projectionFieldId||target.id,
      scope:target.scope,advancedLabel:target.advancedLabel})),
    busy: Boolean(state.busy || state.activeFileInputAttemptId)
  };
}

function applySourcePreparationMappings(key, decisions) {
  const model=sourcePreparationSnapshot();
  if (!model || key !== model.key) throw new Error('원본 자료가 변경되었습니다. 현재 파일의 매핑을 확인하세요.');
  if (model.busy) throw new Error('진행 중인 작업이 끝난 뒤 적용하세요.');
  const current=modeDraft(), session=inputMappingSession(current);
  if (!Array.isArray(decisions) || decisions.length !== session.headers.length
    || new Set(decisions.map(item=>item.columnIndex)).size !== session.headers.length) {
    throw new Error('전체 원본 열의 매핑을 확인하세요.');
  }
  const byColumn=new Map(decisions.map(item=>[item.columnIndex,item]));
  const mappings=session.mappings.map(mapping=>{
    const choice=byColumn.get(mapping.columnIndex);
    if (!choice || !['MAPPED','UNMAPPED'].includes(choice.state)) throw new Error('사용할 항목 또는 사용 안 함을 선택하세요.');
    return {...mapping,state:choice.state,targetFieldId:choice.state==='MAPPED'?String(choice.targetFieldId||''):'',reviewed:true};
  });
  const targetDefinitions=inputMappingDefinitions();
  const next={...session,mappings};
  const validation=validateTemplateDraft(next,targetDefinitions);
  if (!validation.valid) throw new Error('연결 대상 누락 또는 중복 매핑을 확인하세요.');
  if (['INVALID_TEMPLATE','TEMPLATE_CONFLICT'].includes(session.status)) throw new Error('저장된 양식 연결 오류를 먼저 수정하세요.');
  const changed=mappings.some((mapping,index)=>mapping.state!==session.mappings[index].state
    || mapping.targetFieldId!==session.mappings[index].targetFieldId || session.mappings[index].reviewed!==true);
  if (!changed) return {applied:true,changed:false};
  next.templateDirty=Boolean(session.templateId) || Boolean(session.templateDirty);
  next.updatedAt=new Date().toISOString();
  const previous={inputMapping:current.inputMapping,rows:current.rows,batches:current.batches,delivery:current.delivery};
  try {
    current.inputMapping=next;
    projectInputMappingToVoucherRows();
  } catch(error) {
    Object.assign(current,previous);
    state.inputListSearchIndexes.delete(state.draft.activeMode);
    throw error;
  }
  renderRows({restoreFocus:false});
  saveDraftNow();
  return {applied:true,changed:true};
}

window.SMARTINPUT_SOURCE_PREPARATION=Object.freeze({snapshot:sourcePreparationSnapshot,apply:applySourcePreparationMappings});

`+anchor);
assert.ok(main.includes('function renderSourceSurface() {'));
main=main.replace('function renderSourceSurface() {',"function renderSourceSurface() {\n  window.dispatchEvent(new Event('smartinput:source-preparation-changed'));");
fs.writeFileSync('smartinput/smartinput.js',main);

const previous=fs.readFileSync('smartinput/source-preparation-ui-v2.js','utf8');
const style=previous.slice(previous.indexOf('  function installStyle()'),previous.indexOf('  function ensurePanel()'));
fs.writeFileSync('smartinput/source-preparation-ui-v2.js',String.raw`(() => {
  'use strict';
  if ((document.documentElement.dataset.nexusUiApp || '') !== 'smart-input') return;
  const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const byId=id=>document.getElementById(id);
  let model=null, modelKey='', staged=new Map(), applying=false, refreshQueued=false;
`+style+String.raw`
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
`);

let test=fs.readFileSync('scripts/test-smartinput-estimate-report-preset-browser.mjs','utf8');
const line=test.split('\n').find(line=>line.includes('data-source-column=')&&line.includes('await evaluate'));
assert.ok(line);
test=test.replace(line,String.raw`  await evaluate(client,'(()=>{const s=document.querySelectorAll("#sourcePreparationList select")[7];s.value="__UNMAPPED__";s.dispatchEvent(new Event("change",{bubbles:true}));})()');`);
const diagnostic=test.split('\n').find(line=>line.includes("console.error('BROWSER DIAGNOSTIC'"));
assert.ok(diagnostic);
test=test.replace(diagnostic,String.raw`  console.error('BROWSER FAILURE',error.stack);
  if(client) console.error('BROWSER DIAGNOSTIC',JSON.stringify(await evaluate(client,'(()=>{const s=window.__presetTest?.snapshot();return {ready:s?.ready,mode:s?.mode,rowCount:s?.draft.rows.length,firstRow:s?.draft.rows[0],mappings:s?.draft.inputMapping?.mappings,preparation:document.querySelector("#sourcePreparationMapping")?.innerText,headers:document.querySelectorAll("#mappingTableHeaders th").length};})()').catch(()=>null)));`);
test=test.replace('rmSync(profile,{recursive:true,force:true})','rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200})');
fs.writeFileSync('scripts/test-smartinput-estimate-report-preset-browser.mjs',test);
console.log('Left preparation now reads the live session and applies validated decisions in one projection.');
