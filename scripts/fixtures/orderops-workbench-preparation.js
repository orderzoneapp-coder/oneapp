(async () => {
  const { state:s, workbench:w }=__ops, $=id=>document.getElementById(id);
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  const until=async(fn,label)=>{for(let i=0;i<250;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error(label);};
  const change=(id,value)=>{const el=$(id);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));};
  const select=item=>$('prepareFileList').querySelector(`[data-prepared-id="${item.id}"]`).click();
  const file=(name,sheets)=>{const book=XLSX.utils.book_new();for(const [name,rows]of Object.entries(sheets))XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),name);return new File([XLSX.write(book,{type:'array',bookType:'xlsx'})],name);};
  const apply=async()=>{$('prepareApplyButton').click();await w.operation;};
  const reset=async()=>{await $('workbenchResetButton').onclick();};
  window.confirm=()=>true;window.alert=()=>{};
  await reset();
  const orders=[['일자','창고','담당','단위','품목코드','품목명','규격','수량','단가','적요','적요1','거래처','그룹'],['2026-09-12','1창고','담당A','EA','P1','상품1','EA',10,100,'일반1','직원1','거래처1','1'],['2026-09-12','1창고','담당B','EA','P2','상품2','EA',10,100,'일반2','직원2','거래처2','2']];
  const inventory=[['품목코드','품목명','규격','단위','수량','1창고'],['P1','상품1','EA','EA',4,4],['P2','상품2','EA','EA',20,20]];
  for(const kind of ['purchases','sales']){
    const rows=[['품목코드','품목명',kind==='purchases'?'구매처':'거래처','수량'],['P1','상품1','참고 거래처',3]];
    await w.prepare([file(kind+'.xlsx',{참고:rows})],kind);await apply();
    assert(s.workspace?.workspaceMode===ShippingManagementEngine.PREVIEW_WORKSPACE_MODE,'U05 reference-only must not analyze: '+$('prepareStatus').textContent);
    document.querySelector(`#previewTabs [data-preview="${kind}"]`).click();
    assert(s.activePreview===kind&&$('previewTable').textContent.includes('참고 거래처'),'U05 reference-only original view');
    assert(!s.workspace.orders.length,'U05 reference data must not create orders');
    await reset();
  }
  await w.prepare([file('multi-orders.xlsx',{첫시트:orders,둘째시트:orders})],'orders');
  const [first,second]=s.preparedFiles;
  await apply();assert(!s.workspace&&$('prepareStatus').textContent.includes('여러 개'),'U10 duplicate kind must not pick last');
  select(first);change('preparedEnd','2');select(second);change('preparedInclude',false);select(first);
  assert($('preparedEnd').value==='2','U07 selected sheet mapping retained');
  await apply();assert(s.workspace.orders.length===1&&s.workspace.orders[0].productCode==='P1','U07/08 explicit end applied');
  assert(s.workspace.sourceFiles.orders.sourceEvidence.rawMatrix.length===3,'U08 original rows retained');
  select(second);$('prepareRemoveButton').click();
  assert(s.preparedFiles.length===1&&s.workspace.orders.length===1,'U13 remove preparation only');
  const prior=s.workspace;
  await w.prepare([file('bad-purchase.xlsx',{구매:[['품목코드','품목명','구매처','수량'],['P1','상품1','구매처','oops']]})],'purchases');
  const bad=s.preparedFiles.at(-1);select(first);change('preparedEnd','3');await apply();
  assert(s.workspace===prior&&first.dirty&&bad.status==='INVALID','U11 invalid batch must not partially apply orders');
  select(bad);$('prepareRemoveButton').click();await apply();
  assert(s.workspace.orders.length===2,'U11 corrected batch applies');

  await w.prepare([file('inventory-two-sheets.xlsx',{현재:inventory,다음:inventory})],'inventory');
  const stock=s.preparedFiles.at(-2),otherStock=s.preparedFiles.at(-1);
  select(otherStock);change('preparedInclude',false);select(stock);
  const originalDigest=crypto.subtle.digest.bind(crypto.subtle);
  async function gatedApply(fail){
    let release,entered=false,armed=true;
    const gate=new Promise(r=>release=r);
    crypto.subtle.digest=async(...args)=>{if(armed){armed=false;entered=true;await gate;if(fail)throw Error('synthetic inventory digest failure');}return originalDigest(...args);};
    $('prepareApplyButton').click();
    await until(()=>entered&&s.inventoryApplyBusy,'inventory transaction pending');
    const pending=w.operation;
    assert(pending,'inventory preparation must expose pending operation to beforeLeave');
    return {finish:async()=>{release();const result=await pending;crypto.subtle.digest=originalDigest;return result;}};
  }
  let gate=await gatedApply(false);
  change('preparedEnd','2');change('preparedInclude',false);
  change('preparedSheet','다음');assert(s.selectedPreparedId===otherStock.id,'sheet selection while pending');
  change('preparedSheet','현재');
  const result=await gate.finish();
  assert(result.ok&&s.inventory.explicitMapping.dataEndRowIndex===2,'F08 apply captures original parsed snapshot');
  assert(stock.parsed.explicitMapping.dataEndRowIndex===1&&stock.dirty&&stock.status==='READY'&&!stock.include,'F08 latest mapping/include remains unapplied after prior success');
  let blocked=false;try{await __ops.flushOrderOpsBeforeWorkspaceLeave();}catch{blocked=true;}
  assert(blocked&&w.dirty(),'F08 pending preparation blocks app leave');
  change('preparedInclude',true);await apply();
  assert(!stock.dirty&&stock.status==='APPLIED'&&s.inventory.rows.length===1,'F08 reapply newest mapping');
  const inventoryBefore=JSON.stringify(s.workspace.inventory);
  change('preparedEnd','3');gate=await gatedApply(true);change('preparedEnd','2');change('preparedInclude',false);
  const failed=await gate.finish();
  assert(!failed.ok&&stock.dirty&&!stock.include&&stock.dataEndRowIndex===1,'F08 failure keeps newer preparation');
  assert(JSON.stringify(s.workspace.inventory)===inventoryBefore,'F08 failure keeps accepted inventory');
  change('preparedInclude',true);await apply();
  select(otherStock);$('prepareRemoveButton').click();
  select(stock);$('prepareRemoveButton').click();await apply();
  assert(!s.inventory&&s.workspace.orders.length===2,'U13 explicit inventory use-off preserves orders');
  const records=()=>new Promise((resolve,reject)=>{const tx=s.db.transaction([...s.db.objectStoreNames],'readonly');const out={};for(const name of s.db.objectStoreNames){const req=tx.objectStore(name).getAllKeys();req.onsuccess=()=>out[name]=req.result;}tx.oncomplete=()=>resolve(out);tx.onerror=()=>reject(tx.error);});
  const beforeReset=await records();assert(Object.values(beforeReset).some(keys=>keys.length),'U13 needs accepted recovery evidence');
  const clear=IDBObjectStore.prototype.clear;let clears=0;IDBObjectStore.prototype.clear=function(...args){clears++;return clear.apply(this,args);};
  const latestBySource=new Map();for(const id of beforeReset.recoveryRecords){const [source,date]=id.split(':');if(!latestBySource.has(source)||date>latestBySource.get(source).split(':')[1])latestBySource.set(source,id);}
  localStorage.setItem('workbench-test-unrelated-setting','keep');await reset();IDBObjectStore.prototype.clear=clear;
  const afterReset=await records();
  assert(!s.workspace&&!s.preparedFiles.length,'U13 resets only active work and preparation');
  // The required last-input save may rotate older autosaves under the existing
  // retention policy; reset must never clear stores or discard the latest work.
  assert(clears===0,'U13 reset must not clear recovery stores');
  for(const id of latestBySource.values())assert(afterReset.recoveryRecords.includes(id),'U13 last confirmed work for each source retained');
  assert(localStorage.getItem('workbench-test-unrelated-setting')==='keep','U13 unrelated settings retained');
  for(const kind of ['orders','inventory','purchases','sales']){
    const sourceRows=kind==='orders'?orders:kind==='inventory'?inventory:[['품목코드','품목명',kind==='purchases'?'구매처':'거래처','수량'],['P1','상품1','참고 거래처',0],['P2','상품2','참고 거래처',2]];
    const rows=[...sourceRows,['문의 안내: 마지막 상품 아래 정보 텍스트']];
    await w.prepare([file('footer-'+kind+'.xlsx',{원본:rows})],kind);
    const item=s.preparedFiles.at(-1);select(item);
    assert(!$('preparedStart')&&$('preparedEnd'),'last row replaces start-row control');
    change('preparedEnd','3');
    assert(item.status==='READY'&&item.parsed.rows.length===2,kind+' excludes footer from parsing');
    assert(item.parsed.sourceEvidence.rawMatrix.at(-1)[0]===rows.at(-1)[0],kind+' footer preserved as original evidence');
    for(const end of ['1','5','2.5','']){change('preparedEnd',end);assert(item.status==='INVALID',kind+' rejects invalid end '+end);await apply();assert(!s.workspace,kind+' invalid end cannot apply');}
    change('preparedEnd','3');await apply();
    assert(s[kind].explicitMapping.dataEndRowIndex===2,kind+' applied inclusive end');
    const restored=JSON.parse(JSON.stringify(ShippingManagementEngine.buildLocalRecoveryPayload(s.workspace)));
    const saved=restored.workspace.sourceFiles[kind]||restored.workspace.orderOpsInputs[kind];
    assert(saved.explicitMapping.dataEndRowIndex===2,kind+' recovery range retained');
    assert(saved.sourceEvidence.rawMatrix.at(-1)[0]===rows.at(-1)[0],kind+' recovery footer retained');
    assert(s[kind].rows[0].sourceRowNumber===2&&s[kind].rows[1].sourceRowNumber===3,kind+' original Excel row numbers retained');
    s.preparedFiles=[];s.selectedPreparedId='';w.hydratePrepared();
    assert($('preparedEnd').value==='3',kind+' restore displays last product row');
    await reset();
  }
  return {U05:'purchase/sales-only source views',U07_11:'multi-sheet, retained last-row mapping, duplicate-kind block, invalid batch all-or-none, corrected reapply',PM_F08:'real inventory transaction success/failure with new end/include/sheet choices; dirty and beforeLeave preserved; reapply',U13:'preparation removal, stock use-off and reset preserve orders/recovery boundary'};
})()
