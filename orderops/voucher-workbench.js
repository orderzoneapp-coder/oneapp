/* ORDEROPS-3P-01: order-workspace vouchers, not official ledger commands. */
(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrderOpsVouchers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const text = value => String(value ?? '').trim();
  const copy = value => JSON.parse(JSON.stringify(value));
  function index(workspace) {
    if (!workspace) return [];
    const source = workspace.sourceFiles?.orders || {};
    const sourceKey = text(source.sha256 || source.fileHash || workspace.sourceFingerprint || source.fileName || 'workspace');
    const groups = new Map();
    (workspace.orders || []).forEach((row, position) => {
      const originalLine = text(row.orderItemId || row.sourceLineKey || row.sourceRowNumber || position + 1);
      row.workbenchRowId ||= JSON.stringify([sourceKey, source.sheetName || '', row.orderId || '', originalLine]);
      const number = text(row.orderNumber || row.group);
      row.workbenchVoucherId ||= row.orderId
        ? JSON.stringify(['orderq', row.companyId || 'ONEAPP', row.orderId])
        : JSON.stringify(['excel', sourceKey, source.sheetName || '', number || row.workbenchRowId,
          row.basisDate || '', row.warehouse || '', row.customerId || row.customerCode || row.customer || '']);
      let voucher = groups.get(row.workbenchVoucherId);
      if (!voucher) {
        voucher = { id: row.workbenchVoucherId, rows: [], rowIds: [], sourceRowNumbers: [], dates: [], warehouses: [], managers: [], customer: text(row.customer), orderNumber: number };
        groups.set(voucher.id, voucher);
      }
      voucher.rows.push(row); voucher.rowIds.push(row.workbenchRowId); voucher.sourceRowNumbers.push(Number(row.sourceRowNumber));
      for (const [field, value] of [['dates', row.basisDate], ['warehouses', row.warehouse], ['managers', row.manager]]) {
        const label = text(value); if (!voucher[field].includes(label)) voucher[field].push(label);
      }
    });
    return [...groups.values()];
  }
  function totals(vouchers, engine) {
    const units = new Map(); let amount = 0, knownAmounts = 0, calculatedAmounts = 0, unknownAmounts = 0, badQuantities = 0;
    for (const voucher of vouchers) for (const row of voucher.rows) {
      const q = engine.parseNumericCell(row.quantity);
      if (q.ok && !q.blank) {
        const u = text(row.sourceUnit) || '단위 미지정'; units.set(u, Math.round(((units.get(u) || 0) + q.value) * 1e8) / 1e8);
      } else badQuantities++;
      const a = engine.parseNumericCell(row.supplyAmount);
      if (a.ok && !a.blank) { amount += a.value; knownAmounts++; }
      else if (a.ok && a.blank) {
        const price = engine.parseNumericCell(row.unitPrice);
        if (q.ok && !q.blank && price.ok && !price.blank) { amount += q.value * price.value; calculatedAmounts++; }
        else unknownAmounts++;
      } else unknownAmounts++;
    }
    return { units: [...units], amount: Math.round(amount * 1e8) / 1e8, knownAmounts, calculatedAmounts, unknownAmounts, badQuantities };
  }
  function filter(vouchers, query = {}) {
    const search = text(query.search).toLocaleLowerCase('ko-KR');
    return vouchers.filter(v => {
      if (query.warehouse && !v.warehouses.includes(query.warehouse)) return false;
      if (query.manager && !v.managers.includes(query.manager)) return false;
      if (query.from || query.to) {
        if (!v.dates.some(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && (!query.from || d >= query.from) && (!query.to || d <= query.to))) return false;
      }
      return !search || [v.customer, v.orderNumber, ...v.rows.map(r => [r.noteOriginal, r.note1Original, r.productName, r.productCode].join(' '))].join(' ').toLocaleLowerCase('ko-KR').includes(search);
    });
  }
  function plan(workspace, checked, values, bases) {
    const chosen = index(workspace).filter(v => checked.has(v.id));
    if (chosen.length !== checked.size) throw new Error('선택한 전표의 원본이 변경되었습니다. 목록을 다시 확인하세요.');
    const patch = Object.fromEntries(['warehouse', 'manager'].filter(k => text(values[k])).map(k => [k, text(values[k])]));
    const patches = [];
    for (const voucher of chosen) for (const row of voucher.rows) for (const [field, value] of Object.entries(patch)) {
      const base = bases?.[row.workbenchRowId];
      if (base && !Object.is(base[field], row[field])) throw new Error(`${voucher.customer || '선택 전표'}의 ${field === 'manager' ? '담당자' : '창고'}가 중앙에서 변경되었습니다. 입력은 유지됩니다.`);
      if (text(row[field]) !== value) patches.push({ sourceRowNumber: Number(row.sourceRowNumber), rowId: row.workbenchRowId, voucherId: voucher.id, field, value, expectedValue: row[field] });
    }
    return patches;
  }
  function attach(api, workbench) {
    const { state:s, engine:e, elements:el, escapeHtml:esc } = api;
    const $ = id => document.getElementById(id);
    const checked = new Set(); let values = { warehouse:'', manager:'' }, bases = null, busy = false, all = [], visible = [];
    const query = { from:'', to:'', search:'', warehouse:'', manager:'' };
    const format = n => Number(n).toLocaleString('ko-KR', {maximumFractionDigits:8});
    const caption = vs => {
      const t = totals(vs, e);
      const quantities = t.units.map(([u,n]) => `${format(n)} ${u}`).join(' / ') || '0';
      const amount = t.knownAmounts + t.calculatedAmounts ? `${format(t.amount)}원${t.calculatedAmounts ? ' (계산 포함)' : ''}` : (vs.length ? '금액 미확인' : '0원');
      return `${quantities} · ${amount}${t.unknownAmounts ? ` · 금액 미확인 ${t.unknownAmounts}행` : ''}${t.badQuantities ? ` · 수량 확인 ${t.badQuantities}행` : ''}`;
    };
    function render() {
      all = index(s.workspace);
      const valid = new Set(all.map(v => v.id));
      for (const id of checked) if (!valid.has(id)) checked.delete(id);
      if (!checked.size) clearDraft();
      visible = filter(all, query);
      $('voucherCount').textContent = `주문 목록 (${visible.length}건${visible.length !== all.length ? ` / 전체 ${all.length}건` : ''})`;
      const chipGroup = (field, id, label) => {
        const names = [...new Set(all.flatMap(v => v[field]))].filter(Boolean).sort((a,b)=>a.localeCompare(b,'ko'));
        const key = field === 'warehouses' ? 'warehouse' : 'manager';
        // Retain an active filter even if its last voucher was edited out of it.
        if (query[key] && !names.includes(query[key])) names.push(query[key]);
        $(id).innerHTML = [['', `전체 ${label}`], ...names.map(n=>[n,n])].map(([value,name]) => `<button type="button" data-voucher-filter="${key}" data-value="${esc(value)}" aria-pressed="${query[key]===value}">${esc(name)}</button>`).join('');
      };
      chipGroup('warehouses','voucherWarehouses','창고'); chipGroup('managers','voucherManagers','담당');
      $('voucherRows').innerHTML = visible.length ? visible.map(v => {
        const note = [...new Set(v.rows.map(r=>text(r.note1Original || r.note1 || r.noteOriginal || r.note)).filter(Boolean))].join(' · ');
        return `<tr data-voucher-id="${esc(v.id)}" tabindex="0" aria-selected="${s.selectedDeliveryKey===v.id}"><td><input type="checkbox" data-voucher-check="${esc(v.id)}" ${checked.has(v.id)?'checked':''} aria-label="${esc(v.customer || '거래처 미지정')} ${esc(v.orderNumber)} 전표 선택"></td><td>${esc(v.dates.filter(Boolean).join(' / ') || '미확인')}</td><td><strong>${esc(v.customer || '거래처 미지정')}</strong><small>${esc(caption([v]))}</small></td><td title="${esc(note)}">${esc(note)}</td></tr>`;
      }).join('') : '<tr><td colspan="4" class="empty-table-cell">표시할 주문이 없습니다.</td></tr>';
      const count = visible.filter(v=>checked.has(v.id)).length;
      $('voucherSelectAll').checked = visible.length > 0 && count === visible.length;
      $('voucherSelectAll').indeterminate = count > 0 && count < visible.length;
      $('voucherSelectAll').disabled = !visible.length;
      const hiddenCount = checked.size - count;
      $('voucherTotals').textContent = `선택 ${checked.size}건${hiddenCount ? ` · 현재 목록 밖 ${hiddenCount}건` : ''} | ${caption(all.filter(v=>checked.has(v.id)))}`;
      $('voucherBulk').hidden = !checked.size;
      $('voucherBulk').querySelectorAll('button,input').forEach(n=>n.disabled=busy);
      $('voucherWarehouseOptions').innerHTML = [...new Set(all.flatMap(v=>v.warehouses).filter(Boolean))].map(v=>`<option value="${esc(v)}"></option>`).join('');
      // Existing datalist is also used by the central cell editor.
      el.orderOpsManagerOptions && (el.orderOpsManagerOptions.innerHTML = [...new Set(all.flatMap(v=>v.managers).filter(Boolean))].map(v=>`<option value="${esc(v)}"></option>`).join(''));
    }
    const activeBase = () => Object.fromEntries(all.filter(v=>checked.has(v.id)).flatMap(v=>v.rows.map(r=>[r.workbenchRowId,{warehouse:r.warehouse,manager:r.manager}])));
    function clearDraft() {
      values={warehouse:'',manager:''}; bases=null;
      $('voucherWarehouseInput').value=''; $('voucherManagerInput').value='';
    }
    function selectionChanged() {
      if (bases) { const next=activeBase(); for (const [id,b] of Object.entries(next)) if (!bases[id]) bases[id]=b; }
      render();
    }
    function focus(id) {
      const voucher = all.find(v=>v.id===id); if (!voucher) return;
      s.selectedDeliveryKey=id; s.selectedDeliverySourceRows=new Set(voucher.sourceRowNumbers); s.selectedDeliveryProductCodes=new Set(voucher.rows.map(r=>e.normalizeProductCode(r.productCode)));
      api.renderPreview();
      requestAnimationFrame(()=>el.previewTable.querySelector('.orderops-selected-delivery-row')?.scrollIntoView({block:'nearest',inline:'nearest'}));
    }
    async function apply(field) {
      if (busy || workbench.operation || s.inventoryApplyBusy || !s.workspace || !checked.size) return;
      api.captureInputs();
      const selected = new Set(checked), nextValues = field ? {[field]:values[field]} : {...values};
      let patches;
      try { patches=plan(s.workspace, selected, nextValues, bases); }
      catch(error){ api.showToast(error.message,true); return; }
      if (!patches.length) { api.showToast('변경할 값을 입력하세요. 동일한 값은 다시 적용하지 않습니다.'); return; }
      busy=true; render();
      const savedScroll={top:el.previewTable.scrollTop,left:el.previewTable.scrollLeft};
      try {
        const result = await workbench.runReplacement(async base => {
          const candidate=copy(base);
          const fresh=plan(candidate,selected,nextValues,bases);
          e.applyOrderPatches(candidate,fresh,{recordHistory:true,actor:api.actor()});
          return candidate;
        },candidate=>{
          s.workspace=candidate; if(s.orders) s.orders.rows=candidate.orders;
          s.pendingSystemHistory=candidate.systemHistory; s.workspaceChangeVersion++;
          if(field) values[field]=''; else values={warehouse:'',manager:''};
          $('voucherWarehouseInput').value=values.warehouse; $('voucherManagerInput').value=values.manager;
          if(field && bases) { for(const row of candidate.orders) { if(bases[row.workbenchRowId]) bases[row.workbenchRowId][field]=row[field]; } } else bases=null;
          api.renderResults();
        });
        if(result?.ok) { api.showToast(`선택 ${selected.size}건의 작업본에 적용했습니다.`); requestAnimationFrame(()=>{el.previewTable.scrollTop=savedScroll.top;el.previewTable.scrollLeft=savedScroll.left;}); }
      } finally {busy=false;render();}
    }
    $('voucherSelectAll').onchange=ev=>{for(const v of visible) ev.target.checked?checked.add(v.id):checked.delete(v.id);selectionChanged();};
    $('voucherRows').onchange=ev=>{const id=ev.target.dataset.voucherCheck;if(id){ev.target.checked?checked.add(id):checked.delete(id);selectionChanged();}};
    $('voucherRows').onclick=ev=>{if(ev.target.closest('input,label'))return;const row=ev.target.closest('[data-voucher-id]');if(row)focus(row.dataset.voucherId);};
    $('voucherRows').onkeydown=ev=>{if(ev.target.matches('input'))return;if(['Enter',' '].includes(ev.key)){ev.preventDefault();const row=ev.target.closest('[data-voucher-id]');if(row)focus(row.dataset.voucherId);}};
    for(const id of ['voucherWarehouses','voucherManagers']) $(id).onclick=ev=>{const b=ev.target.closest('[data-voucher-filter]');if(!b)return;query[b.dataset.voucherFilter]=b.dataset.value;render();};
    for(const [id,key] of [['voucherDateFrom','from'],['voucherDateTo','to'],['voucherSearch','search']]) $(id).oninput=ev=>{query[key]=ev.target.value;render();};
    $('voucherRangeReset').onclick=()=>{query.from='';query.to='';$('voucherDateFrom').value='';$('voucherDateTo').value='';render();};
    for(const [id,key] of [['voucherWarehouseInput','warehouse'],['voucherManagerInput','manager']]) $(id).oninput=ev=>{bases ||= activeBase();values[key]=ev.target.value;};
    $('voucherWarehouseApply').onclick=()=>void apply('warehouse');$('voucherManagerApply').onclick=()=>void apply('manager');$('voucherApply').onclick=()=>void apply();
    $('voucherCancel').onclick=clearDraft;
    render();
    return {render,dirty:()=>Boolean(text(values.warehouse)||text(values.manager)),clear:()=>{checked.clear();values={warehouse:'',manager:''};bases=null;$('voucherWarehouseInput').value='';$('voucherManagerInput').value='';render();}};
  }
  return {index,totals,filter,plan,attach};
});
