/* Internal ORDER Q read adapters only. Never invent an external ERP endpoint. */
(function(root) {
  'use strict';
  root.attachOrderOpsActivitySources = function(api,workbench) {
    const {state,showToast}=api;
    let busy=false;
    async function choose(kind) {
      if(busy)return;
      const label=kind==='purchases'?'구매':'판매';
      const dialog=document.createElement('dialog');dialog.className='orderops-workbench-dialog orderops-source-dialog';
      dialog.innerHTML=`<form><h2>${label} 자료 불러오기</h2><p>ORDER Q에 저장된 전표를 읽습니다. 현재 작업에는 아직 적용하지 않습니다.</p><label>시작일<input type="date" name="from" required></label><label>종료일<input type="date" name="to" required></label><label>회사 ID<input name="company" required></label><p role="status" aria-live="polite"></p><div><button type="submit">불러오기</button><button type="button" data-close>닫기</button></div></form>`;
      const form=dialog.querySelector('form'),status=dialog.querySelector('[role=status]');
      const today=new Date(); const date=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      form.elements.from.value=date;form.elements.to.value=date;form.elements.company.value=state.orderQSource?.snapshot?.companyId||'ONEAPP';
      let cancelled=false;
      dialog.querySelector('[data-close]').onclick=()=>dialog.close();
      dialog.addEventListener('close',()=>{cancelled=true;dialog.remove();});
      form.onsubmit=async event=>{
        event.preventDefault();if(busy)return;
        const from=form.elements.from.value,to=form.elements.to.value,companyId=form.elements.company.value.trim();
        const start=Date.parse(`${from}T00:00:00Z`),end=Date.parse(`${to}T00:00:00Z`),days=(end-start)/86400000+1;
        if(!companyId||!Number.isInteger(days)||days<1||days>31){status.textContent='회사와 조회 기간을 확인하세요. 한 번에 최대 31일입니다.';return;}
        busy=true;form.querySelector('[type=submit]').disabled=true;dialog.setAttribute('aria-busy','true');
        try {
          const {readVoucherActivity}=await import('../orderq/voucher-activity-read-adapter.js');
          const documents=[];
          for(let i=0;i<days;i++){
            if(cancelled)return;
            const day=new Date(start+i*86400000).toISOString().slice(0,10);status.textContent=`${day} 조회 중 (${i+1}/${days})`;
            const result=await readVoucherActivity({mode:kind==='purchases'?'purchase':'sale',date:day,companyId});
            if(!['READY','EMPTY'].includes(result.status)||result.truncated)throw new Error(`${day}: 조회를 완료하지 못했습니다. 현재 작업은 유지됩니다.`);
            documents.push(...result.rows);
          }
          if(cancelled)return;
          if(!documents.length){status.textContent='조회된 전표가 없습니다. 현재 작업은 유지됩니다.';return;}
          const matrix=[['품목코드','품목명','수량',kind==='purchases'?'구매처':'거래처','단위','단가','공급가액','원본전표ID','원본행ID','전표일자','회사ID']];
          for(const doc of documents)for(const item of doc.items||[])matrix.push([item.code,item.name,item.quantity??'',doc.customerName,item.unit,item.unitPrice??'',item.amount??'',doc.id,item.lineId,doc.date,companyId]);
          if(matrix.length===1){status.textContent='상품행이 없는 전표입니다. 현재 작업은 유지됩니다.';return;}
          const workbook=root.XLSX.utils.book_new();root.XLSX.utils.book_append_sheet(workbook,root.XLSX.utils.aoa_to_sheet(matrix),label);
          const bytes=root.XLSX.write(workbook,{bookType:'xlsx',type:'array'});
          await workbench.prepare([new File([bytes],`ORDERQ_${label}_${from}_${to}.xlsx`,{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})],kind);
          dialog.close();showToast(`${label} ${documents.length}건을 준비했습니다. 왼쪽에서 확인 후 적용하세요.`);
        }catch(error){if(!cancelled)status.textContent=error.message||'조회 실패 · 현재 작업은 유지됩니다.';}
        finally{busy=false;if(!cancelled){form.querySelector('[type=submit]').disabled=false;dialog.removeAttribute('aria-busy');}}
      };
      document.body.append(dialog);dialog.showModal();
    }
    document.getElementById('purchaseApiButton').onclick=()=>void choose('purchases');
    document.getElementById('salesApiButton').onclick=()=>void choose('sales');
  };
})(window);
