(async()=>{
  const count=__ROW_COUNT__, warehouses=__WAREHOUSE_COUNT__, {state:s,renderResults,renderPreview}=__perf, e=ShippingManagementEngine;
  const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const orderMatrix=[['일자','창고','담당','단위','품목코드','품목명','규격','수량','단가','적요','적요1','거래처','그룹'],...Array.from({length:count},(_,i)=>['2026-09-12','1창고','담당'+i%3,'EA','P'+i,'합성'+i,'EA',10,100,'일반','직원','거래처'+i%20,'주문'+i%100])];
  const inventoryMatrix=[['품목코드','품목명','규격','단위','수량',...Array.from({length:warehouses},(_,i)=>(i+1)+'창고')],...Array.from({length:count},(_,i)=>['P'+i,'합성'+i,'EA','EA',warehouses*4,...Array(warehouses).fill(4)])];
  s.orders=e.parseOrderWorkbook({fileName:'performance-orders.xlsx',sheetName:'orders',fileHash:'a'.repeat(64),rawMatrix:orderMatrix,displayMatrix:orderMatrix});
  s.inventory=e.parseInventoryWorkbook({fileName:'performance-stock.xlsx',sheetName:'inventory',fileHash:'b'.repeat(64),rawMatrix:inventoryMatrix,displayMatrix:inventoryMatrix});
  s.orderQSource=null;s.shipmentDraft={};s.searchQuery='';s.activePreview='allocations';s.selectedProductCode='';s.selectedOrderRow='';
  s.workspace=e.analyze(s.orders,s.inventory,{sourceFingerprint:'c'.repeat(64)});renderResults();await frame();
  const callsBefore=globalThis.__layoutCalls||0;await new Promise(r=>setTimeout(r,350));const idleLayoutCalls=(globalThis.__layoutCalls||0)-callsBefore;
  const data={orders:[],inventory:[],selection:[],panel:[]};
  const diagnostics=[];
  const measure=async(key,fn,verify)=>{globalThis.__profileStages=[];const start=performance.now();fn();const syncMs=performance.now()-start;await frame();verify();const focus=document.querySelector('#tableSearchInput');focus.focus({preventScroll:true});if(document.activeElement!==focus)throw Error('input not available');data[key].push(performance.now()-start);if(__SAMPLES__===1)diagnostics.push({key,syncMs,stages:globalThis.__profileStages});};
  const view=id=>{const button=document.querySelector('#previewTabs [data-preview="'+id+'"]')||document.querySelector(id==='inventory'?'#inventoryDrop':'#ordersDrop');if(!button)throw Error('missing real view button '+id);button.click();};
  const verifyView=id=>{if(s.activePreview!==id||!document.querySelector('#previewTable table.preview-'+id))throw Error('view did not change '+id);if(document.querySelectorAll('#previewTable tbody tr[data-product-code]').length<count)throw Error('missing displayed source rows');};
  for(let i=0;i<__SAMPLES__;i++){
    await measure('inventory',()=>view('inventory'),()=>verifyView('inventory'));
    await measure('orders',()=>view('allocations'),()=>verifyView('allocations'));
    let selectedCode;
    await measure('selection',()=>{const row=document.querySelectorAll('#previewTable tbody tr[data-product-code]')[i%Math.min(count,30)];if(!row)throw Error('missing selectable row');selectedCode=row.dataset.productCode;if(selectedCode===s.selectedProductCode)throw Error('selection must change');row.click();},()=>{if(s.selectedProductCode!==selectedCode||!document.querySelector('#previewTable .orderops-selected-product-row[data-product-code="'+CSS.escape(selectedCode)+'"]'))throw Error('requested row selection not visible');});
    const shouldOpen=document.querySelector('#inventoryInspector').hidden;
    await measure('panel',()=>{const button=document.querySelector(shouldOpen?'#inventoryInspectorReopen':'#inventoryInspectorClose');if(!button)throw Error('missing panel button');button.click();},()=>{const pane=document.querySelector('#inventoryInspector');if(pane.hidden===shouldOpen||(shouldOpen&&pane.getBoundingClientRect().width<=0))throw Error('requested panel state not visible');});
  }
  const summary=Object.fromEntries(Object.entries(data).map(([key,values])=>{const sorted=[...values].sort((a,b)=>a-b);return[key,{samples:values.length,p50:sorted[Math.ceil(values.length*.5)-1],p95:sorted[Math.ceil(values.length*.95)-1],max:sorted.at(-1)}];}));
  return {rows:count,warehouses,idleLayoutCalls,summary,rawSamples:data,diagnostics,measurement:'requested DOM state + next two displayed frames + focusable search; programmatic clicks, not physical touch feedback latency'};
})()
