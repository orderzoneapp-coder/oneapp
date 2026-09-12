(async()=>{
  const $=selector=>document.querySelector(selector);
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  const until=async(fn,label)=>{for(let i=0;i<400;i++){try{if(fn())return;}catch{}await new Promise(r=>setTimeout(r,50));}throw Error(label);};
  const frame=$('#nexusWorkspaceFrame'),child=frame.contentWindow,s=child.__ops.state;
  const originalUrl=location.href,childUrl=child.location.href;
  const book=child.XLSX.utils.book_new();child.XLSX.utils.book_append_sheet(book,child.XLSX.utils.aoa_to_sheet([['품목코드','품목명','구매처','수량'],['U29','이동 준비','합성 구매처',1]]),'이동 준비');
  await child.__ops.workbench.prepare([new child.File([child.XLSX.write(book,{type:'array',bookType:'xlsx'})],'u29-preparation.xlsx')],'purchases');
  const pending=s.preparedFiles.at(-1);
  $('[data-nexus-ui-app-target="dataops"]').click();
  await until(()=>!$('#nexusWorkspaceNotice').hidden,'U29 pending-file blocked notice');
  assert(location.href===originalUrl&&frame.contentWindow===child&&child.location.href===childUrl,'U29 pending file must preserve route/frame');
  assert(pending.dirty&&child.document.querySelector('#prepareFileList').textContent.includes('u29-preparation'),'U29 preparation stays accessible');
  child.document.querySelector(`[data-prepared-id="${pending.id}"]`).click();child.document.querySelector('#prepareRemoveButton').click();

  const row=s.workspace.orders[0],beforeWork=JSON.stringify(s.workspace.orders);
  await child.eval(`(async()=>{const request=indexedDB.open('oneapp-orderq-pre-m1-v6');return await new Promise((resolve,reject)=>{request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const tx=db.transaction(['orders','orderItems'],'readwrite');const order=tx.objectStore('orders').get('WB-ORDER');order.onsuccess=()=>{order.result.revision++;order.result.updatedAt=new Date().toISOString();tx.objectStore('orders').put(order.result);};const item=tx.objectStore('orderItems').get('WB-I1');item.onsuccess=()=>{item.result.price=333;tx.objectStore('orderItems').put(item.result);};tx.oncomplete=()=>{db.close();resolve(true);};tx.onerror=()=>reject(tx.error);};});})()`);
  const applying=child.__ops.workbench.applyLatest();
  await until(()=>child.document.querySelector('dialog[open] [data-cancel]'),'U29 actual B/W/N conflict dialog');
  $('[data-nexus-ui-app-target="dataops"]').click();await new Promise(r=>setTimeout(r,150));
  assert(location.href===originalUrl&&frame.contentWindow===child,'U29 conflict response must precede frame replacement');
  child.document.querySelector('dialog[open] [data-cancel]').click();
  assert(!(await applying).ok,'U29 conflict cancellation');
  await until(()=>!$('#nexusWorkspaceNotice').hidden,'U29 conflict blocked notice');
  await until(()=>$('#nexusWorkspaceLoading').hidden,'U29 conflict transition settled');
  await new Promise(r=>setTimeout(r,100));
  assert(location.href===originalUrl&&JSON.stringify(s.workspace.orders)===beforeWork,'U29 conflict preserves current values');
  const input=child.document.querySelector('.order-edit-input[data-order-field="deliveryNotice"]');
  assert(input,'U29 employee note input');input.value='iframe 이동 직전 직원 입력';input.dispatchEvent(new child.Event('input',{bubbles:true}));input.dispatchEvent(new child.Event('change',{bubbles:true}));
  $('[data-nexus-ui-app-target="dataops"]').click();
  try{await until(()=>new URL(location.href).searchParams.get('app')==='dataops'&&frame.contentDocument?.documentElement.dataset.nexusUiApp==='dataops','U29 actual app transition');}catch(error){throw Error(error.message+' '+JSON.stringify({notice:$('#nexusWorkspaceNotice').textContent,location:location.href,child:frame.contentWindow.location.href,dirty:child.__ops?.workbench.dirty(),loading:!$('#nexusWorkspaceLoading').hidden}));}
  await until(()=>$('#nexusWorkspaceLoading').hidden,'U29 destination handshake ready');
  // A header app tab is a new canonical/default entry. Returning to the exact
  // orderId/returnTo/focus route uses the host's existing browser history.
  history.back();
  try{await until(()=>frame.contentWindow.__ops?.state.workspace?.orders?.[0]?.note1Original==='iframe 이동 직전 직원 입력','U29 actual return and accepted input recovery');}catch(error){throw Error(error.message+' '+JSON.stringify({notice:$('#nexusWorkspaceNotice').textContent,location:location.href,child:frame.contentWindow.location.href,note:frame.contentWindow.__ops?.state.workspace?.orders?.[0]?.note1Original,loading:!$('#nexusWorkspaceLoading').hidden}));}
  const recovered=frame.contentWindow.__ops.state;
  assert(recovered.orderQSource.snapshot.orderId==='WB-ORDER','U29 original order identity');
  assert(recovered.workspace.orders[0].unitPrice===row.unitPrice,'U29 conflict work price retained');
  assert(new URL(frame.contentWindow.location.href).searchParams.get('orderId')==='WB-ORDER','U29 order route retained');
  assert(new URL(frame.contentWindow.location.href).searchParams.get('returnTo')==='orderops_list.html'&&new URL(frame.contentWindow.location.href).searchParams.get('focus')==='WB-I1','U29 returnTo/focus retained');
  return {pendingFile:'blocked; file and frame unchanged',conflict:'real B/W/N dialog pending/cancel keeps frame and input',roundTrip:'real DataOps navigation -> browser Back to OrderOps, latest employee note/orderId/work price recovered'};
})()
