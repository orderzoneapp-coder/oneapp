(async () => {
  const {state:s,workbench:w}=__ops, e=ShippingManagementEngine;
  const equal=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(label+': '+JSON.stringify(a)+' != '+JSON.stringify(b));};
  const ok=(value,label)=>{if(!value)throw new Error(label);};
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const until=async(fn,label)=>{for(let i=0;i<200;i++){if(fn())return;await sleep(30);}throw Error(label);};
  const settled=async()=>{await sleep(250);await __ops.flushOrderOpsBeforeWorkspaceLeave();};
  const source=await import('/orderops/orderq-order-source-adapter.js');
  const commands=await import('/orderops/shipment-result-command-adapter.js');
  const reads=await import('/orderops/shipment-result-read-adapter.js');
  await source.listOrderQOrderSources();
  const db=await new Promise((r,j)=>{const q=indexedDB.open('oneapp-orderq-pre-m1-v6');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
  const ownerWrite=callback=>new Promise((r,j)=>{const tx=db.transaction(['orders','orderItems','orderEvents'],'readwrite');callback(tx);tx.oncomplete=r;tx.onabort=()=>j(tx.error);tx.onerror=()=>j(tx.error);});
  await ownerWrite(tx=>{
    tx.objectStore('orders').put({orderId:'WB-ORDER',orderNo:'20260912-9001',orderDate:'2026-09-12',customerId:'WB-C',customerName:'격리 거래처',warehouseId:'W3',warehouseCode:'3',warehouseName:'3서울',assigneeName:'담당1',orderStatus:'ORDER',adminStatus:'CHECKED',opsStatus:'ACTIVE',sourceType:'SMART_INPUT',inputChannel:'SMART_INPUT',revision:1,createdAt:'2026-09-12T01:00:00Z',updatedAt:'2026-09-12T01:00:00Z'});
    for(const [id,code,line]of[['WB-I1','0001',1],['WB-I2','0002',2]])tx.objectStore('orderItems').put({orderItemId:id,orderId:'WB-ORDER',lineNo:line,sourceLineKey:'L'+line,productId:code,itemCode:code,itemName:'격리상품'+line,specification:'EA',finalQuantity:10,rawQuantity:10,finalUnit:'EA',rawUnit:'EA',matchStatus:'MATCHED',price:100,memo:'일반 원본',description:'직원 원본'});
    tx.objectStore('orderEvents').put({eventId:'WB-CREATE',orderId:'WB-ORDER',revision:1,eventType:'ORDER_CREATED',createdAt:'2026-09-12T01:00:00Z',detail:{}});
  });
  const changeOwner=async(patch,itemPatch={})=>ownerWrite(tx=>{const q=tx.objectStore('orders').get('WB-ORDER');q.onsuccess=()=>{Object.assign(q.result,patch,{revision:q.result.revision+1,updatedAt:new Date().toISOString()});tx.objectStore('orders').put(q.result);};for(const[id,patch]of Object.entries(itemPatch)){const req=tx.objectStore('orderItems').get(id);req.onsuccess=()=>{if(patch===null)tx.objectStore('orderItems').delete(id);else tx.objectStore('orderItems').put({...req.result,...patch});};}});
  await __ops.loadOrderQSource('WB-ORDER',{skipSwitchConfirm:true});
  equal(s.workspace.orders.length,2,'ORDER Q read source');
  const matrix=[['품목코드','품목명','규격','단위','수량','1창고','3서울','4전송'],['0001','격리상품1','EA','EA',4,4,0,0],['0002','격리상품2','EA','EA',20,20,0,0],['ALT','대체 상품','EA','EA',30,30,0,0]];
  s.inventory=e.parseInventoryWorkbook({kind:'inventory',fileName:'stock.xlsx',sheetName:'재고',fileHash:'c'.repeat(64),rawMatrix:matrix,displayMatrix:matrix});
  __ops.refreshInputState();await __ops.performAnalysis();
  equal(s.workspace.workspaceMode,undefined,'analysis succeeded');
  equal(e.getFinalPurchaseUploadSelection(s.workspace).included.map(r=>[r.productCode,r.purchaseNeed]),[['0001',6]],'U06 actual selection');
  document.querySelector('[data-preview="procurement"]').click();
  ok(document.querySelector('#previewTable').textContent.includes('구매업로드 포함'),'U06 screen final selection');
  document.querySelector('#downloadButton').click();
  await until(()=>document.querySelector('#systemMessage').textContent.includes('엑셀출력 완료'),'actual F10 completion');
  const f10Message=document.querySelector('#systemMessage').textContent;
  document.querySelector('[data-preview="allocations"]').click();
  e.substituteOrderProduct(s.workspace,2,'ALT',{recordHistory:true,actor:'isolated'});
  e.setOrderValue(s.workspace,2,'unitPrice',123,{recordHistory:true});
  e.setOrderValue(s.workspace,2,'note','작업 일반',{recordHistory:true});
  e.setOrderValue(s.workspace,2,'deliveryNotice','작업 직원',{recordHistory:true});
  e.setPurchaseValue(s.workspace,'ALT','수기 구매처');
  s.shipmentDraft={'WB-I1':{shippedQuantity:'0',reason:'0 초안'},'WB-I2':{shippedQuantity:'',reason:'공란 초안'}};
  __ops.renderResults();__ops.commitCurrentWorkspaceInputs();
  const history=JSON.stringify(s.workspace.substitutionHistory), editHistory=JSON.stringify(s.workspace.systemHistory);
  await changeOwner({customerName:'격리 거래처 최신'});
  const latest=await w.applyLatest();ok(latest?.ok,'U22-a latest '+latest?.message);
  equal(s.workspace.orders[0].productCode,'ALT','substitution kept');equal(s.workspace.orders[0].unitPrice,123,'price kept');equal(s.workspace.orders[0].noteOriginal,'작업 일반','general memo kept');equal(s.workspace.orders[0].note1Original,'작업 직원','staff memo kept');
  equal(s.shipmentDraft['WB-I1'],{shippedQuantity:'0',reason:'0 초안'},'zero draft');equal(s.shipmentDraft['WB-I2'],{shippedQuantity:'',reason:'공란 초안'},'blank draft');equal(JSON.stringify(s.workspace.substitutionHistory),history,'history');equal(s.workspace.systemHistory.events.slice(0,-1),JSON.parse(editHistory).events,'edit history');equal(s.workspace.systemHistory.events.at(-1).kind,'ORDER_SOURCE_RECONCILED','accepted source audit');equal(e.getPurchaseInputs(s.workspace).ALT,'수기 구매처','purchase preserved');
  // Actual B/W/N dialog: cancel is non-destructive, then explicit choices are
  // required and become accepted reconciliation history, not source edits.
  await changeOwner({}, {'WB-I1':{price:175,memo:'최신 원본 일반'}});
  let conflictApply=w.applyLatest();
  await until(()=>document.querySelector('dialog [name="choice-0"]'),'U22-b conflict dialog');
  const conflictDialog=document.querySelector('dialog:has([name="choice-0"])');
  ok(conflictDialog.textContent.includes('B:')&&conflictDialog.textContent.includes('W:')&&conflictDialog.textContent.includes('N:'),'three values visible');
  conflictDialog.querySelector('[data-cancel]').click();equal((await conflictApply).ok,false,'cancel latest application');equal(s.workspace.orders[0].unitPrice,123,'cancel keeps price');
  conflictApply=w.applyLatest();await until(()=>document.querySelector('dialog [name="choice-0"]'),'conflict retry');
  const retryDialog=document.querySelector('dialog:has([name="choice-0"])');
  [...retryDialog.querySelectorAll('select')].forEach(select=>{select.value='work';});retryDialog.querySelector('form').requestSubmit();
  ok((await conflictApply).ok,'explicit work choices accepted');equal(s.workspace.orders[0].unitPrice,123,'selected work price');equal(s.workspace.orders[0].noteOriginal,'작업 일반','selected work memo');ok(s.workspace.workbenchReconciliation.decisions.length>=2,'choices stored for recovery');
  // Change current input after the STAGED payload is persisted. The candidate
  // must be regenerated or fail without overwriting the current input.
  await changeOwner({customerName:'격리 거래처 재조회'});
  const originalPut=IDBObjectStore.prototype.put;let injected=false;
  IDBObjectStore.prototype.put=function(value,...args){const request=originalPut.call(this,value,...args);if(this.name==='recoveryRecords'&&value.publicationState==='STAGED'&&!injected){injected=true;request.addEventListener('success',()=>{e.setOrderValue(s.workspace,2,'deliveryNotice','저장 대기 중 최신 입력',{recordHistory:true});s.workspaceChangeVersion++;});}return request;};
  let race;try{race=await w.applyLatest();}finally{IDBObjectStore.prototype.put=originalPut;}
  ok(injected,'U22-d stage race injected');ok(race.ok,'stage retry');equal(s.workspace.orders[0].note1Original,'저장 대기 중 최신 입력','latest input after stage');
  // An input event delivered at the final IDB put must abort publication and
  // remain in the current workspace, rather than making the stale candidate
  // recoverable as the newest accepted work.
  await changeOwner({customerName:'최종 확정 경합'});let finalInjected=false;
  IDBObjectStore.prototype.put=function(value,...args){const request=originalPut.call(this,value,...args);if(this.name==='recoveryRecords'&&value.publicationState==='PUBLISHED'&&w.commitLocked&&!finalInjected){finalInjected=true;request.addEventListener('success',()=>{e.setOrderValue(s.workspace,2,'unitPrice',124,{recordHistory:true});s.workspaceChangeVersion++;});}return request;};
  let finalRace;try{finalRace=await w.applyLatest();}finally{IDBObjectStore.prototype.put=originalPut;}
  ok(finalInjected,'U22-d final put race injected');equal(finalRace.ok,false,'final publication aborted');equal(s.workspace.orders[0].unitPrice,124,'final input retained');
  ok((await w.applyLatest()).ok,'retry after final race');
  // Failure immediately before publication: last accepted work and recovery
  // remain selectable; unaccepted STAGED payloads are never normal recovery.
  await settled();const before=JSON.stringify(s.workspace);await changeOwner({customerName:'실패 후 원본'});
  IDBObjectStore.prototype.put=function(value,...args){if(this.name==='recoveryRecords'&&value.publicationState==='PUBLISHED'&&w.commitLocked)throw Error('SYNTHETIC_FINAL_COMMIT_FAILURE');return originalPut.call(this,value,...args);};
  let failed;try{failed=await w.applyLatest();}finally{IDBObjectStore.prototype.put=originalPut;}
  equal(failed.ok,false,'U22-e publication failure');equal(JSON.stringify(s.workspace),before,'publication failure keeps old work');
  const recovered=await w.applyLatest();ok(recovered.ok,'retry after failure');
  // Deletion retains full history and orphan draft, not another row's value.
  await changeOwner({}, {'WB-I2':null});const deletion=await w.applyLatest();ok(deletion.ok,'latest deletion');equal(s.workspace.workbenchUnapplied.length,1,'U22-c orphan count');equal(s.workspace.workbenchUnapplied[0].shipmentDraft.shippedQuantity,'','orphan blank');
  await settled();const pointer=localStorage.getItem('oneapp.shipping.recovery.pointer.v1');
  const record=await new Promise((r,j)=>{const q=s.db.transaction('recoveryRecords').objectStore('recoveryRecords').get(pointer);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});
  equal(record.payload.workspace.workbenchUnapplied,s.workspace.workbenchUnapplied,'U22-f actual IDB round-trip');equal(record.payload.workspace.shipmentExecutionDraft.values,s.shipmentDraft,'draft actual IDB round-trip');
  // Supported F8 UI flow with an isolated in-memory Cloud transport. No
  // production endpoint, Cloud revision or real order is modified.
  const fetchOriginal=window.fetch;let cloudSnapshot, editWhileSaving=false;
  document.querySelector('#cloudUrlInput').value='https://script.google.com/macros/s/workbench-test/exec';
  document.querySelector('#cloudTokenInput').value='isolated-token';
  window.fetch=async(url,options)=>{
    if(!String(url).includes('/workbench-test/'))return fetchOriginal(url,options);
    const body=JSON.parse(options.body);let data;
    const metadata=()=>({planId:cloudSnapshot.planId,revision:'WB-CLOUD',hash:cloudSnapshot.hash,rowCount:cloudSnapshot.rowCount,cellCount:cloudSnapshot.cellCount,savedAt:'2026-09-12T05:00:00Z'});
    if(body.action==='shipping_plan_save'){cloudSnapshot=body.snapshot;if(editWhileSaving){e.setOrderValue(s.workspace,2,'unitPrice',125,{recordHistory:true});s.workspaceChangeVersion++;}data=metadata();}
    else if(body.action==='shipping_plan_list')data=cloudSnapshot?[metadata()]:[];
    else if(body.action==='shipping_plan_get')data={plan:JSON.parse(cloudSnapshot.canonicalJson),metadata:metadata()};
    else throw Error('unexpected synthetic Cloud action '+body.action);
    return new Response(JSON.stringify({status:'success',action:body.action,data}),{headers:{'Content-Type':'application/json'}});
  };
  try{
    editWhileSaving=true;const saved=await __ops.saveCloudPlan();ok(saved.ok&&saved.hasLaterInputs,'U24 saved revision distinguished from later input');equal(s.workspace.orders[0].unitPrice,125,'later input kept');
    editWhileSaving=false;ok((await __ops.saveCloudPlan()).ok,'F8 exact save');
    const cloudWork=JSON.parse(cloudSnapshot.canonicalJson).workspace;
    e.setOrderValue(s.workspace,2,'note','복구 전 임시값',{recordHistory:true});s.workspaceChangeVersion++;
    await __ops.loadCloudPlan();
    for(const key of ['orders','workbenchUnapplied','workbenchReconciliation','substitutionHistory','systemHistory','shipmentExecutionDraft'])equal(s.workspace[key],cloudWork[key],'U22-f Cloud round-trip '+key);
  }finally{window.fetch=fetchOriginal;}
  // With no confirmed shipment, an owner-authorized document-wide warehouse
  // and manager change may resume only after latest work/source validation.
  await changeOwner({warehouseName:'1창고',warehouseCode:'1',warehouseId:'W1',assigneeName:'담당2'});
  ok((await w.applyLatest()).ok,'U19-b latest owner before shipment');
  const snapshot=s.orderQSource.snapshot;
  const command={orderId:snapshot.orderId,expectedOrderRevision:snapshot.orderRevision,expectedSnapshotHash:snapshot.snapshotHash,workspace:s.workspace,actor:'isolated',lineInputs:[{orderItemId:'WB-I1',shippedQuantity:4,reason:'부분출고'}]};
  const first=await commands.confirmShipment({...command,commandId:'WB-SHIP-1'});equal(first.verification.netByOrderItem['WB-I1'],4,'U19-c first partial');
  equal(first.verification.results[0].document.warehouseName,'1창고','U19-b actual document warehouse');equal(first.verification.results[0].document.assigneeName,'담당2','U19-b actual document manager');
  const retry=await commands.confirmShipment({...command,commandId:'WB-SHIP-1'});ok(retry.duplicate,'command idempotency');
  const second=await commands.confirmShipment({...command,commandId:'WB-SHIP-2',lineInputs:[{orderItemId:'WB-I1',shippedQuantity:2,reason:'추가출고'}]});equal(second.verification.netByOrderItem['WB-I1'],6,'partial additional');
  const originalDocuments=JSON.stringify(second.verification.results);
  await changeOwner({warehouseName:'새창고',warehouseCode:'7',warehouseId:'W7',assigneeName:'새담당'});
  ok((await w.applyLatest()).ok,'U19-d latest owner application');
  const reviewed=await reads.readShipmentResultsByOrder('WB-ORDER');ok(reviewed.reviewRequired,'partial review required');equal(reviewed.netByOrderItem['WB-I1'],6,'never reverse on latest');
  const snapshot2=s.orderQSource.snapshot;let blocked=false;try{await commands.confirmShipment({...command,commandId:'WB-SHIP-BLOCK',workspace:s.workspace,expectedOrderRevision:snapshot2.orderRevision,expectedSnapshotHash:snapshot2.snapshotHash});}catch(error){blocked=error.code==='SHIPMENT_WORKBENCH_REVIEW_REQUIRED';}ok(blocked,'U19-d bypass call blocked');
  equal(JSON.stringify(reviewed.results.map(r=>r.document)),JSON.stringify(JSON.parse(originalDocuments).map(r=>r.document)),'immutable confirmed docs');
  await settled();
  globalThis.__stageCrash = async () => {
    await changeOwner({customerName:'미적용 후보 원본'});
    const put=IDBObjectStore.prototype.put,digest=crypto.subtle.digest.bind(crypto.subtle);
    globalThis.__stagedCrashReady=false;
    IDBObjectStore.prototype.put=function(value,...args){const request=put.call(this,value,...args);if(this.name==='recoveryRecords'&&value.publicationState==='STAGED')request.addEventListener('success',()=>{globalThis.__stagedCrashReady=true;});return request;};
    crypto.subtle.digest=(...args)=>globalThis.__stagedCrashReady?new Promise(()=>{}):digest(...args);
    void w.applyLatest();return true;
  };
  return {latestRevision:snapshot2.orderRevision,f10Message,stagedInputRace:injected,finalInputRace:finalInjected,cloudRoundTrip:true,publicationFailurePreserved:!failed.ok,orphans:s.workspace.workbenchUnapplied.length,netShipped:reviewed.netByOrderItem['WB-I1'],reviewRequired:reviewed.reviewRequired,commandBypassBlocked:blocked};
})()
