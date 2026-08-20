import { analyzeExcelFile, analyzeHistoricalText } from './history-collector/collector-importer.js?v=0.8.0';
import { SOURCE_LABEL, COLLECTOR_SOURCE } from './history-collector/collector-schema.js?v=0.8.0';
import {
  getCollectorSnapshot, rebuildFulfillmentEvidence, saveCollectorSettings,
  confirmParserEvidence, cancelParserEvidenceConfirmation,
  confirmFulfillmentLink, replaceFulfillmentLink, unlinkFulfillmentLink
} from './history-collector/history-repository.js?v=0.8.0';
import {
  commitPreparedImportV2,
  rollbackImportBatchByContract
} from './history-collector/collector-contracts.js?v=0.8.1';
import { syncNow } from './orderq-sync-engine.js?v=0.8.0';
import { getCloudUrl, getCloudAccessToken } from './orderq-cloud-adapter.js?v=0.8.0';
import { resolveCustomerInput } from './customer-master.js?v=0.12.0';
import { openCustomerPicker } from './customer-picker.js?v=0.12.0';

const prepared = [];
const photoDrafts = [];
let activeWork = 'order';
let activeOrderMethod = 'excel';
let lastMismatch = null;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const number = value => Number(value || 0).toLocaleString('ko-KR');
const formatTime = value => value ? new Date(value).toLocaleString('ko-KR', { hour12:false }) : '';

const WORK = Object.freeze({
  order: { label:'주문자료', source:[COLLECTOR_SOURCE.ORDER, COLLECTOR_SOURCE.KAKAO], description:'카카오·문자·텍스트·Excel·사진 주문을 후보로 분석한 뒤 주문자료로 확정합니다.', action:'주문자료 수집' },
  sales: { label:'판매현황', source:[COLLECTOR_SOURCE.SALES], description:'실제 판매 결과를 수집합니다. 주문자료가 없으면 매칭은 실행하지 않습니다.', action:'판매현황 수집' },
  purchase: { label:'구매현황', source:[COLLECTOR_SOURCE.PURCHASE], description:'실제 구매 결과를 수집합니다. 구매 수집은 주문↔판매 매칭을 재계산하지 않습니다.', action:'구매현황 수집' },
  inventory: { label:'기초재고', source:[COLLECTOR_SOURCE.INVENTORY], description:'현재 재고의 시작 기준을 적용합니다. 다른 이력자료와 분리해서 관리합니다.', action:'기초재고 적용' },
  ledger: { label:'거래처원장', source:[COLLECTOR_SOURCE.CUSTOMER_LEDGER], description:'거래처원장 이력을 수집합니다. 현재 채권·채무 확정값으로 직접 사용하지 않습니다.', action:'거래처원장 수집' }
});

function show(text, type='info') { const el=$('#message'); el.textContent=text; el.className=`message show ${type}`; }
function stateBadge(status) { return `<span class="link-state ${esc(status)}">${esc(status)}</span>`; }
function sourceMatchesWork(sourceType, work=activeWork) { return (WORK[work]?.source || []).includes(sourceType); }
function matchingReady(snapshot) { return snapshot.orderLines.length > 0 && snapshot.salesLines.length > 0; }
function currentPrepared() { return prepared.filter(item => sourceMatchesWork(item.sourceType)); }

function renderPrepared() {
  const rows = currentPrepared();
  const config = WORK[activeWork];
  $('#commitBtn').disabled = !rows.length;
  $('#commitBtn').textContent = config?.action || '수집';
  $('#preparedSummary').textContent = rows.length ? `${rows.length}개 자료 · ${number(rows.reduce((sum,item)=>sum+item.rows.length,0))}행` : '분석 후 수집할 자료가 없습니다.';
  $('#sourceCards').innerHTML = rows.length ? rows.map(item => {
    const index = prepared.indexOf(item);
    return `<article class="source-card"><header><span class="type">${esc(SOURCE_LABEL[item.sourceType] || item.sourceType)}</span><strong>${esc(item.fileName)}</strong></header><p>시트 ${esc(item.sheetName || '-')} · ${number(item.rows.length)}행</p><p>자동 인식: ${esc(SOURCE_LABEL[item.sourceType] || item.sourceType)}${item.confidence ? ` · 자료형 신뢰도 ${number(item.confidence)}%` : ''}</p>${(item.warnings||[]).map(w=>`<p class="warning">${esc(w)}</p>`).join('')}<button class="btn danger" data-remove="${index}" type="button">제외</button></article>`;
  }).join('') : '<div class="empty-card">대기 중인 자료가 없습니다.</div>';
}

function renderMismatch() {
  const box=$('#mismatchBox');
  if (!lastMismatch) { box.classList.add('hidden'); box.innerHTML=''; return; }
  const target = Object.entries(WORK).find(([,cfg])=>cfg.source.includes(lastMismatch.result.sourceType))?.[0];
  box.classList.remove('hidden');
  box.innerHTML = `<strong>이 파일은 ${esc(SOURCE_LABEL[lastMismatch.result.sourceType] || '다른 자료')}로 인식되었습니다.</strong><span>${esc(lastMismatch.result.fileName || '')}</span><div><button class="btn" data-mismatch-detail type="button">내용 확인</button>${target ? `<button class="btn primary" data-mismatch-move="${target}" type="button">${esc(WORK[target].label)}에서 열기</button>` : ''}<button class="btn danger" data-mismatch-exclude type="button">제외</button></div>`;
}

async function analyzeFiles(files) {
  for (const file of files) {
    try {
      let result;
      if (/\.txt$/i.test(file.name)) result = await analyzeHistoricalText({rawText:await file.text(),fileName:file.name,sourceId:file.name,defaultDate:$('#textDate').value});
      else if (/\.xlsx?$/i.test(file.name)) result = await analyzeExcelFile(file, window.XLSX);
      else { show(`${file.name}: xlsx, xls, txt 파일만 수집할 수 있습니다.`, 'warn'); continue; }
      if (!sourceMatchesWork(result.sourceType)) { lastMismatch={file,result}; renderMismatch(); continue; }
      const existing=prepared.findIndex(item=>item.fileHash===result.fileHash && item.sheetName===result.sheetName);
      if(existing>=0) prepared.splice(existing,1,result); else prepared.push(result);
    } catch(error) { show(error.message || String(error),'error'); }
  }
  renderPrepared();
}

function fulfillmentActions(link,snapshot){
  if(!link.historicalOrderLineId||!link.salesLineId||Number(link.allocatedQuantity||0)<0)return'';
  const docs=new Map(snapshot.salesDocuments.map(r=>[r.salesDocumentId,r]));
  const choices=snapshot.salesLines.filter(r=>Number(r.quantity||0)>0&&r.salesLineId!==link.salesLineId).map(r=>`<option value="${esc(r.salesLineId)}">${esc((docs.get(r.salesDocumentId)?.salesDate||'')+' · '+(r.productName||r.productCode||'상품미상')+' · '+number(r.quantity))}</option>`).join('');
  return `<div class="admin-actions">${link.requiresReview?`<button class="btn primary" data-confirm-link="${esc(link.fulfillmentLinkId)}">확정</button>`:''}<select class="control link-replacement"><option value="">판매행 변경…</option>${choices}</select><button class="btn" data-replace-link="${esc(link.fulfillmentLinkId)}">변경</button><button class="btn danger" data-unlink="${esc(link.fulfillmentLinkId)}">해제</button></div>`;
}

function renderWorkSummary(s) {
  let box=$('#currentDataSummary');
  if(!box){
    box=document.createElement('section'); box.id='currentDataSummary'; box.className='current-data-summary';
    $('#mismatchBox').insertAdjacentElement('afterend', box);
  }
  if(activeWork==='sales'){
    const normal=s.salesLines.filter(r=>Number(r.quantity||0)>=0).length;
    const reversal=s.salesLines.filter(r=>Number(r.quantity||0)<0).length;
    box.innerHTML=`<div><span>정상판매</span><strong>${number(normal)}</strong></div><div><span>반품·취소</span><strong>${number(reversal)}</strong></div>`;
  } else if(activeWork==='purchase') box.innerHTML=`<div><span>구매행</span><strong>${number(s.purchaseLines.length)}</strong></div>`;
  else if(activeWork==='inventory') box.innerHTML=`<div><span>기초재고행</span><strong>${number(s.inventoryLines.length)}</strong></div>`;
  else if(activeWork==='ledger') box.innerHTML=`<div><span>거래처원장행</span><strong>${number(s.sourceRecords.filter(r=>r.sourceType===COLLECTOR_SOURCE.CUSTOMER_LEDGER).length)}</strong></div>`;
  else box.innerHTML=`<div><span>주문행</span><strong>${number(s.orderLines.length)}</strong></div>`;
}

async function renderSnapshot(){
  const s=await getCollectorSnapshot();
  $('#chip-order').textContent=s.orderLines.length?number(s.orderLines.length):'없음';
  $('#chip-sales').textContent=s.salesLines.length?number(s.salesLines.length):'없음';
  $('#chip-purchase').textContent=s.purchaseLines.length?number(s.purchaseLines.length):'없음';
  $('#chip-inventory').textContent=s.inventoryLines.length?number(s.inventoryLines.length):'없음';
  const ledgerCount=s.sourceRecords.filter(r=>r.sourceType===COLLECTOR_SOURCE.CUSTOMER_LEDGER).length;
  $('#chip-ledger').textContent=ledgerCount?number(ledgerCount):'없음';
  if(WORK[activeWork]) renderWorkSummary(s);

  const ready=matchingReady(s);
  const reviewCount=s.links.filter(r=>r.requiresReview && r.historicalOrderLineId && r.salesLineId && Number(r.allocatedQuantity||0)>=0).length;
  $('#chip-matching').textContent=ready?(reviewCount?`확인필요 ${number(reviewCount)}`:'분석완료'):'분석대기';
  $('#matchingReadyContent').classList.toggle('hidden',!ready); $('#matchingNotReady').classList.toggle('hidden',ready);
  if(!ready){
    const missing=s.orderLines.length===0?'주문자료':'판매현황'; const target=s.orderLines.length===0?'order':'sales';
    $('#matchingNotReady').innerHTML=`<strong>매칭분석 대기</strong><p>${missing}가 없습니다. 필요한 자료를 먼저 수집해 주세요.</p><button class="btn primary" data-go-work="${target}" type="button">${missing} 수집으로 이동</button>`;
    $('#linkRows').innerHTML=''; $('#balanceRows').innerHTML=''; $('#evidenceRows').innerHTML='';
  } else {
    $('#cutoffTime').value=`${String(s.settings.cutoffHour).padStart(2,'0')}:${String(s.settings.cutoffMinute).padStart(2,'0')}`; $('#holidays').value=(s.settings.holidays||[]).join(', ');
    const validLinks=s.links.filter(link=>link.historicalOrderLineId&&link.salesLineId&&Number(link.allocatedQuantity||0)>=0&&link.status!=='EXCLUDED').sort((a,b)=>Number(b.requiresReview)-Number(a.requiresReview)||String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,300);
    const orderById=new Map(s.orderLines.map(r=>[r.historicalOrderLineId,r])); const salesById=new Map(s.salesLines.map(r=>[r.salesLineId,r]));
    const matchedOrderIds=new Set(validLinks.filter(r=>!r.requiresReview).map(r=>r.historicalOrderLineId)); const autoRate=s.orderLines.length?Math.round(matchedOrderIds.size/s.orderLines.length*100):0;
    $('#matchingSummary').innerHTML=`<div><span>주문행</span><strong>${number(s.orderLines.length)}</strong></div><div><span>판매행</span><strong>${number(s.salesLines.length)}</strong></div><div><span>자동매칭률</span><strong>${autoRate}%</strong></div><div><span>확인필요</span><strong>${number(reviewCount)}</strong></div>`;
    $('#linkRows').innerHTML=validLinks.length?validLinks.map(link=>`<tr><td>${stateBadge(link.status)}</td><td>${esc(link.customerName||'')}</td><td>${esc(orderById.get(link.historicalOrderLineId)?.rawExpression||'')}</td><td>${esc(salesById.get(link.salesLineId)?.productName||link.productName||link.productCode||'')}</td><td>${esc(link.orderDate||'')}</td><td>${esc(link.salesDate||'')}</td><td class="num">${number(link.allocatedQuantity)}</td><td>${esc((link.evidence||[]).join(' · '))}</td><td>${fulfillmentActions(link,s)}</td></tr>`).join(''):'<tr><td colspan="9" class="empty">확인할 주문↔판매 연결이 없습니다.</td></tr>';
    const balances=s.balances.slice().sort((a,b)=>Number(b.remainingQuantity)-Number(a.remainingQuantity));
    $('#balanceRows').innerHTML=balances.length?balances.map(r=>`<tr class="${r.status==='UNFULFILLED'?'balance-open':''}"><td>${stateBadge(r.status)}</td><td>${esc(r.customerName||'')}</td><td>${esc(r.rawExpression||r.productName||r.productCode||'')}</td><td class="num">${number(r.orderedQuantity)}</td><td class="num">${number(r.grossShippedQuantity)}</td><td class="num reversal">${number(r.reversalQuantity)}</td><td class="num">${number(r.netShippedQuantity)}</td><td class="num remaining">${number(r.remainingQuantity)}</td></tr>`).join(''):'<tr><td colspan="8" class="empty">연결된 주문 잔량이 없습니다.</td></tr>';
    const evidence=s.evidence.slice().sort((a,b)=>b.distinctDateCount-a.distinctDateCount||b.supportCount-a.supportCount);
    $('#evidenceRows').innerHTML=evidence.length?evidence.map(r=>`<tr><td>${stateBadge(r.status)}</td><td>${esc(r.customerName||r.customerId)}</td><td>${esc(r.rawExpressions?.join(' / ')||r.normalizedExpression)}</td><td>${esc(r.productCode||(r.conflictingProductCodes||[]).join(', '))}</td><td>${number(r.distinctDateCount)}</td><td>${number(r.supportCount)}</td><td>${r.status==='ADMIN_CONFIRMED'?`<button class="btn danger" data-cancel-evidence="${esc(r.parserEvidenceId)}">확정 취소</button>`:r.status==='READY_FOR_ADMIN_CONFIRMATION'?`<button class="btn" data-confirm-evidence="${esc(r.parserEvidenceId)}">관리자 확정</button>`:r.status==='CONFLICT'?'검수 필요':'근거 축적 중'}</td></tr>`).join(''):'<tr><td colspan="7" class="empty">파서사전 후보가 없습니다.</td></tr>';
  }
  $('#historyRows').innerHTML=s.batches.length?s.batches.map(r=>`<tr><td>${esc(formatTime(r.importedAt))}</td><td>${esc(SOURCE_LABEL[r.sourceType]||r.sourceType)}</td><td>${esc(r.fileName)} / ${esc(r.sheetName)}</td><td class="num">${number(r.insertedRowCount??r.rowCount)}</td><td>${stateBadge(r.status)}</td><td>${r.status==='COMMITTED'?`<button class="btn" data-history-detail="${esc(r.importBatchId)}">상세</button> <button class="btn danger" data-rollback="${esc(r.importBatchId)}">롤백</button>`:''}</td></tr>`).join(''):'<tr><td colspan="6" class="empty">수집 이력이 없습니다.</td></tr>';
  return s;
}

function applyWorkTab(work){
  activeWork=work; const isCollection=!!WORK[work];
  document.querySelectorAll('[data-work-tab]').forEach(b=>b.classList.toggle('active',b.dataset.workTab===work));
  document.querySelectorAll('.work-panel').forEach(p=>p.classList.toggle('active',p.dataset.workPanel===(isCollection?'collection':work)));
  if(isCollection){ const c=WORK[work]; $('#workTitle').textContent=c.label; $('#workDescription').textContent=c.description; $('#dropTitle').textContent=`${c.label} 파일을 여기에 놓으세요`; $('#commitBtn').textContent=c.action; $('#orderMethodTabs').classList.toggle('hidden',work!=='order'); if(work!=='order'){activeOrderMethod='excel';showOrderMethod();} renderPrepared(); renderSnapshot().catch(e=>show(e.message||String(e),'error')); }
}
function showOrderMethod(){ const isOrder=activeWork==='order'; $('#fileCollector').classList.toggle('hidden',isOrder&&activeOrderMethod!=='excel'); $('#textCollector').classList.toggle('hidden',!isOrder||activeOrderMethod!=='text'); $('#photoCollector').classList.toggle('hidden',!isOrder||activeOrderMethod!=='photo'); document.querySelectorAll('[data-order-method]').forEach(b=>b.classList.toggle('active',b.dataset.orderMethod===activeOrderMethod)); }
async function bestEffortSync(){ if(!getCloudUrl()||!getCloudAccessToken())return; try{await syncNow();}catch(e){show(`수집은 완료됐지만 클라우드 동기화가 남았습니다: ${e.message||e}`,'warn');} }
async function maybeRebuildAfterSourceChange(sourceTypes){ const relevant=sourceTypes.some(t=>[COLLECTOR_SOURCE.ORDER,COLLECTOR_SOURCE.KAKAO,COLLECTOR_SOURCE.SALES].includes(t)); if(!relevant)return null; const s=await getCollectorSnapshot(); if(!matchingReady(s))return null; return rebuildFulfillmentEvidence(); }

async function resolvePreparedCustomers(items){
  const groups=new Map();
  items.forEach(item=>(item.rows||[]).forEach(row=>{const name=String(row.customerName||row.supplierName||'').trim();if(!name)return;if(!groups.has(name))groups.set(name,[]);groups.get(name).push(row);}));
  for(const [name,rows] of groups){
    const resolution=await resolveCustomerInput({customerName:name});
    let customer=resolution.status==='MATCHED'?resolution.customer:null;
    if(!customer) customer=await openCustomerPicker({initialName:name,source:'COLLECTOR_QUICK_CREATE',title:`${name} 거래처 확인`});
    if(!customer) throw new Error(`거래처 확인이 필요합니다: ${name}`);
    rows.forEach(row=>{row.customerId=customer.customerId;row.customerName=row.customerName||customer.customerName;if(row.supplierName)row.supplierName=customer.customerName;});
  }
}

$('.collector-work-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-work-tab]');if(b)applyWorkTab(b.dataset.workTab);});
$('#orderMethodTabs').addEventListener('click',e=>{const b=e.target.closest('[data-order-method]');if(!b)return;activeOrderMethod=b.dataset.orderMethod;showOrderMethod();});
const dz=$('#dropZone'); ['dragenter','dragover'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.add('dragover');})); ['dragleave','drop'].forEach(t=>dz.addEventListener(t,e=>{e.preventDefault();dz.classList.remove('dragover');})); dz.addEventListener('drop',e=>analyzeFiles([...e.dataTransfer.files])); $('#fileInput').addEventListener('change',e=>{analyzeFiles([...e.target.files]);e.target.value='';});
$('#sourceCards').addEventListener('click',e=>{const b=e.target.closest('[data-remove]');if(!b)return;prepared.splice(Number(b.dataset.remove),1);renderPrepared();});
$('#mismatchBox').addEventListener('click',e=>{const detail=e.target.closest('[data-mismatch-detail]');const move=e.target.closest('[data-mismatch-move]');const exclude=e.target.closest('[data-mismatch-exclude]');if(detail&&lastMismatch){const sample=(lastMismatch.result.rows||[]).slice(0,5).map(r=>JSON.stringify(r.normalizedRecord||{})).join(' / ');show(`${lastMismatch.result.fileName}: ${SOURCE_LABEL[lastMismatch.result.sourceType]||lastMismatch.result.sourceType} · ${number(lastMismatch.result.rows.length)}행 · 샘플 ${sample}`,'info');}if(move&&lastMismatch){const result=lastMismatch.result;prepared.push(result);lastMismatch=null;renderMismatch();applyWorkTab(move.dataset.mismatchMove);}if(exclude){lastMismatch=null;renderMismatch();}});
$('#analyzeTextBtn').addEventListener('click',async()=>{try{const result=await analyzeHistoricalText({rawText:$('#historyText').value,sourceId:$('#textSource').value||'DIRECT_TEXT',fileName:`${$('#textSource').value||'직접입력'}.txt`,defaultDate:$('#textDate').value});prepared.push(result);renderPrepared();show(`주문 후보 ${number(result.rows.length)}행을 분석했습니다. 아직 매칭에는 사용되지 않습니다.`);}catch(e){show(e.message||String(e),'error');}});
$('#photoInput').addEventListener('change',e=>{for(const file of e.target.files){photoDrafts.push({file,name:file.name,text:''});}$('#photoCandidates').innerHTML=photoDrafts.map((d,i)=>`<article class="photo-draft"><strong>${esc(d.name)}</strong><textarea class="control" data-photo-text="${i}" rows="3" placeholder="사진에서 확인한 주문 내용을 검수 입력하세요.">${esc(d.text)}</textarea><button class="btn" data-photo-analyze="${i}" type="button">주문 후보 만들기</button></article>`).join('');e.target.value='';});
$('#photoCandidates').addEventListener('input',e=>{if(e.target.matches('[data-photo-text]'))photoDrafts[Number(e.target.dataset.photoText)].text=e.target.value;});
$('#photoCandidates').addEventListener('click',async e=>{const b=e.target.closest('[data-photo-analyze]');if(!b)return;const d=photoDrafts[Number(b.dataset.photoAnalyze)];if(!d?.text.trim())return show('현재 자동 이미지 분석 서버가 연결되지 않았습니다. 사진 주문내용을 확인해 입력한 뒤 후보를 만들어 주세요.','warn');try{const result=await analyzeHistoricalText({rawText:d.text,sourceId:`PHOTO:${d.name}`,fileName:`${d.name}.txt`,defaultDate:$('#textDate').value});prepared.push(result);renderPrepared();show(`사진 주문 후보 ${number(result.rows.length)}행을 만들었습니다. 수집 확정 전에는 매칭하지 않습니다.`);}catch(err){show(err.message||String(err),'error');}});
$('#commitBtn').addEventListener('click',async()=>{const items=currentPrepared();if(!items.length)return;const button=$('#commitBtn');button.disabled=true;try{await resolvePreparedCustomers(items);let inserted=0,skipped=0;const types=[];for(const item of items){const r=await commitPreparedImportV2(item);inserted+=r.inserted;skipped+=r.skipped;types.push(item.sourceType);prepared.splice(prepared.indexOf(item),1);}renderPrepared();await maybeRebuildAfterSourceChange(types);const snapshot=await renderSnapshot();await bestEffortSync();const label=WORK[activeWork].label;const suffix=activeWork==='sales'?(snapshot.orderLines.length?' · 주문자료와 자동매칭했습니다.':' · 주문자료를 수집하면 판매결과와 자동매칭합니다.') : '';show(`${label} 수집 완료: ${number(inserted)}행 · 중복제외 ${number(skipped)}행${suffix}`);}catch(e){show(`수집 실패: ${e.message||e}`,'error');}finally{button.disabled=!currentPrepared().length;}});
$('#saveSettingsBtn').addEventListener('click',async()=>{try{const [h,m]=$('#cutoffTime').value.split(':').map(Number);const holidays=$('#holidays').value.split(',').map(v=>v.trim()).filter(Boolean);await saveCollectorSettings({cutoffHour:h,cutoffMinute:m,holidays});const s=await getCollectorSnapshot();if(matchingReady(s))await rebuildFulfillmentEvidence();await renderSnapshot();show('매칭 기준을 저장하고 가능한 경우 매칭을 다시 계산했습니다.');}catch(e){show(e.message||String(e),'error');}});
$('#rebuildBtn').addEventListener('click',async()=>{try{const s=await getCollectorSnapshot();if(!matchingReady(s))return show('주문자료와 판매현황이 모두 있어야 매칭을 계산할 수 있습니다.','warn');const r=await rebuildFulfillmentEvidence();await renderSnapshot();show(`매칭 계산 완료: 연결 ${number(r.summary.linkedCount)} · 확인필요 ${number(r.summary.reviewRequiredCount)}`);}catch(e){show(e.message||String(e),'error');}});
$('#matchingNotReady').addEventListener('click',e=>{const b=e.target.closest('[data-go-work]');if(b)applyWorkTab(b.dataset.goWork);});
$('#historyRows').addEventListener('click',async e=>{const detail=e.target.closest('[data-history-detail]');if(detail){const s=await getCollectorSnapshot();const b=s.batches.find(r=>r.importBatchId===detail.dataset.historyDetail);if(b)show(`${SOURCE_LABEL[b.sourceType]||b.sourceType} · ${b.fileName}/${b.sheetName} · ${number(b.insertedRowCount??b.rowCount)}행 · 중복제외 ${number(b.skippedRowCount||0)}행 · ${formatTime(b.importedAt)}`);return;}const b=e.target.closest('[data-rollback]');if(!b||!confirm('이 수집 배치를 롤백할까요? 원본 감사기록은 유지됩니다.'))return;try{await rollbackImportBatchByContract(b.dataset.rollback);await renderSnapshot();await bestEffortSync();show('수집 배치를 롤백했습니다.');}catch(err){show(err.message||String(err),'error');}});
$('#linkRows').addEventListener('click',async e=>{const c=e.target.closest('[data-confirm-link]'),r=e.target.closest('[data-replace-link]'),u=e.target.closest('[data-unlink]');if(!c&&!r&&!u)return;try{if(c){if(!confirm('이 주문·판매 후보를 확정할까요?'))return;await confirmFulfillmentLink(c.dataset.confirmLink);}else if(r){const sel=r.closest('.admin-actions').querySelector('.link-replacement');if(!sel.value)throw new Error('변경할 판매행을 선택해 주세요.');await replaceFulfillmentLink(r.dataset.replaceLink,sel.value);}else{if(!confirm('이 연결을 해제할까요?'))return;await unlinkFulfillmentLink(u.dataset.unlink);}await renderSnapshot();await bestEffortSync();}catch(err){show(err.message||String(err),'error');}});
$('#evidenceRows').addEventListener('click',async e=>{const c=e.target.closest('[data-confirm-evidence]'),x=e.target.closest('[data-cancel-evidence]');if(!c&&!x)return;try{if(c)await confirmParserEvidence(c.dataset.confirmEvidence);else await cancelParserEvidenceConfirmation(x.dataset.cancelEvidence);await renderSnapshot();await bestEffortSync();}catch(err){show(err.message||String(err),'error');}});

$('#textDate').value=new Date().toISOString().slice(0,10);showOrderMethod();renderMismatch();renderPrepared();renderSnapshot().catch(e=>show(e.message||String(e),'error'));
