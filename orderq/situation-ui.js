import { runCurrentSituation } from './situation-orchestrator.js?v=0.1.0';
import { defaultSituationRuntime,situationCapabilityReady } from './situation-runtime.js?v=0.1.0';

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const qty=value=>Number(value||0).toLocaleString('ko-KR',{maximumFractionDigits:3});
export function renderSituationAnalysis(analysis,{summary,alerts,rows}){
  const productRows=analysis.productWarehouseRows||analysis.rows||[],ready=productRows.filter(row=>row.status==='READY'),reviews=(analysis.issueRows||[]).length;
  summary.textContent=`현재상황 ${analysis.businessDate} · 품목·창고 ${productRows.length}개 · 주문 ${analysis.orderRows?.length||0}건 · 확인 ${reviews}개`;
  alerts.innerHTML=`<span>추가구매 <b>${qty(ready.reduce((s,r)=>s+Number(r.additionalPurchaseRequiredBaseQuantity||0),0))}</b></span><span>즉시출고 <b>${qty(ready.reduce((s,r)=>s+Number(r.dispatchNowRecognizedQuantity||0),0))}</b></span><span class="${reviews?'warn':''}">확인 <b>${reviews}</b></span>`;
  rows.innerHTML=productRows.length?productRows.map(row=>`<tr data-situation-row="1" title="${esc(JSON.stringify(row.evidence||{}))}"><td>${esc(row.productId)}</td><td>${esc(row.productName||'-')}</td><td>${esc(row.warehouseId||'미지정')}</td><td class="center">${esc(row.baseUnit)}</td><td class="num">${qty(row.remainingRecognizedQuantity)}</td><td class="num">${qty(row.dispatchNowRecognizedQuantity)}</td><td class="num">${qty(row.unshippedAfterDispatchRecognizedQuantity)}</td><td class="num">${qty(row.currentStockBaseQuantity)}</td><td class="num">${qty(row.additionalPurchaseRequiredBaseQuantity)}</td><td class="center">${esc(row.status)}</td><td class="num">${qty(row.alreadyPurchasedBaseQuantity)}</td><td>${esc((row.sourceLines||[]).map(line=>line.orderNo||line.orderId).filter(Boolean).join(', ')||row.key)}</td></tr>`).join(''):'<tr><td colspan="12" class="empty">현재상황 자료가 없습니다.</td></tr>';
}
export function attachSituationUi({button,summary,alerts,rows,message,onRendered,runtimeProvider=async()=>globalThis.ONEAPP_ORDERQ_SITUATION_RUNTIME||defaultSituationRuntime(),capabilityProvider=situationCapabilityReady,runProvider=runCurrentSituation}){
  if(!button||button.dataset.situationBound==='1')return;button.dataset.situationBound='1';
  button.disabled=true;button.title='공식 상황판 Cloud 배포를 확인하는 중입니다.';
  capabilityProvider().then(ready=>{button.disabled=!ready;button.title=ready?'DataOps와 ORDER Q의 최신 공식 상태를 다시 불러옵니다.':'공식 상황판 Cloud 배포 확인 후 사용할 수 있습니다.';});
  button.addEventListener('click',async()=>{button.disabled=true;try{const runtime=await runtimeProvider();if(!runtime)throw new Error('ORDERQ_SITUATION_READ_CAPABILITY_REQUIRED');const analysis=await runProvider(runtime);renderSituationAnalysis(analysis,{summary,alerts,rows});onRendered?.(analysis);message?.('현재상황을 불러왔습니다.','info');}catch(error){message?.(error.message||String(error),'error');}finally{button.disabled=!(await capabilityProvider());}});
}
