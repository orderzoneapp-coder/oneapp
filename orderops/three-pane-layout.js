/* ORDEROPS-3P-01. One initial composition; never relocate inputs into the work table. */
(function(root) {
  'use strict';
  root.orderOpsEmptyTable = function(tab) {
    const headers = {
      allocations: ['창고','거래처','그룹','담당자','상품코드','품명','규격','합계','주문','단가','전달사항','구매'],
      inventory: ['상품코드','품명','규격','재고','주문','잔량'],
      purchases: ['상품코드','품명','수량','구매처'], sales: ['상품코드','품명','수량','거래처'],
      procurement: ['상품코드','품명','규격','발주수량','구매처'], ledger: ['상품코드','품명','주문','재고','잔량']
    };
    const columns=headers[tab] || headers.allocations;
    return '<table class="orderops-empty-table"><thead><tr>'+columns.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody><tr><td colspan="'+columns.length+'" class="empty-table-cell">표시할 자료가 없습니다.</td></tr></tbody></table>';
  };
  root.buildOrderOpsThreePane = function() {
    const $=id=>document.getElementById(id);
    try { const key='nexus:workbench-layout:orderops:v2'; if(!localStorage.getItem(key)) localStorage.setItem(key,JSON.stringify({schemaVersion:2,left:280,right:380})); } catch (_) {}
    const make=(tag,cls,html='')=>{const n=document.createElement(tag);n.className=cls;n.innerHTML=html;return n;};
    const header=document.querySelector('[data-nexus-app-header="orderops"]');
    const shell=document.querySelector('main.page-shell');
    const system=shell.querySelector('.system-workbench');
    const result=$('resultsPanel'), nested=result.querySelector('.orderops-results-workspace');
    const oldList=nested.querySelector('[data-nexus-pane="reference"]');
    const central=nested.querySelector('[data-nexus-pane="work"]'), right=$('inventoryInspector');
    if(!header || !system || !central || !right) throw new Error('출고관리 화면 구조를 확인할 수 없습니다.');
    const workspace=make('div','orderops-results-workspace orderops-workbench-v12 orderops-three-pane');
    workspace.dataset.nexusWorkspace='orderops';workspace.setAttribute('aria-label','자료 준비 · 작업테이블 · 전표관리');
    const left=make('aside','orderops-side-panel orderops-file-prepare',`
      <div class="orderops-prepare-actions" role="toolbar" aria-label="자료 준비 작업">
        <strong>자료 준비</strong><div class="orderops-header-menu"><button id="orderOpsHeaderOrdersButton" type="button" aria-haspopup="menu" aria-controls="orderOpsHeaderOrdersMenu" aria-expanded="false">작업 관리 ▾</button></div>
        <button type="button" id="prepareRemoveButton">지우기</button><button type="button" id="preparePaneClose" aria-label="파일 준비 닫기">닫기</button>
      </div>
      <div class="orderops-api-buttons" role="group" aria-label="연결 자료 불러오기">
        <button type="button" id="orderOpsHeaderOrderQButton" data-source-kind="orders">주문서</button>
        <button type="button" id="purchaseApiButton" data-source-kind="purchases">구매</button>
        <button type="button" id="salesApiButton" data-source-kind="sales">판매</button>
      </div>
      <details id="orderSourcePanel" class="orderops-source-details"><summary>저장 주문 선택</summary></details>
      <input type="file" id="prepareFilesInput" accept=".xlsx,.xls" multiple hidden>
      <div id="prepareDropSurface" class="orderops-prepare-surface" aria-label="Excel 파일 준비·매핑">
        <div class="orderops-prepare-drop-hint"><span class="orderops-file-glyph" aria-hidden="true">▤</span><strong>엑셀 파일을 끌어다 놓으세요</strong><button type="button" id="prepareFilesButton">엑셀 불러오기</button></div>
        <div id="prepareFileList" class="orderops-prepare-file-list" aria-label="준비 파일 목록"></div><div id="prepareFileEditor"></div>
      </div>
      <div class="orderops-prepare-footer"><p id="prepareStatus" role="status" aria-live="polite"></p><button type="button" id="prepareApplyButton"><strong>준비한 자료 적용</strong></button></div>`);
    left.id='orderOpsFilePreparePane';left.dataset.nexusPane='reference';left.tabIndex=-1;
    // Keep input DOM identity and its existing listeners, not duplicate file buttons.
    const legacy=make('div','orderops-legacy-controls');legacy.hidden=true;
    legacy.append($('sourceSelector'));oldList.removeAttribute('data-nexus-pane');oldList.id='orderOpsOrderListPane';legacy.append(oldList);
    const statuses=make('div','orderops-header-source-statuses','<span data-orderops-file-status="orders"></span><span data-orderops-file-status="inventory"></span>');legacy.append(statuses);
    left.append(legacy);
    const inventory=$('inventoryMenuButton');inventory.textContent='재고';inventory.dataset.sourceKind='inventory';left.querySelector('.orderops-api-buttons').append(inventory);
    const picker=$('orderQSourcePicker');left.querySelector('#orderSourcePanel').append(picker);
    picker.querySelector('.orderq-source-picker__title span')?.remove();
    picker.querySelector('[data-orderq-candidate-action="load"]').textContent='선택 주문 적용';
    const management=make('div','orderops-header-menu__items');management.id='orderOpsHeaderOrdersMenu';management.hidden=true;management.setAttribute('role','menu');
    $('headerCloudLoadButton').textContent='완료본 불러오기';management.append($('headerCloudLoadButton'),$('headerRestoreButton'),$('refreshButton'));
    document.body.append(management);
    // Main table retains every existing grid/column/print handler.
    right.remove();[...central.children].forEach(n=>result.append(n));
    nested.remove();central.remove();result.dataset.nexusPane='work';result.classList.add('orderops-central-work');result.tabIndex=-1;
    const heading=$('resultsHeading');heading.classList.remove('hidden');heading.textContent='주문현황';heading.classList.add('orderops-view-heading');
    const titlebar=make('div','orderops-view-titlebar');titlebar.append(heading);
    const paneLinks=make('nav','orderops-pane-shortcuts','<button id="preparePaneReopen" type="button" aria-controls="orderOpsFilePreparePane" aria-expanded="true">자료 준비</button>');
    titlebar.append(paneLinks);result.prepend(titlebar);
    const controls=result.querySelector('.view-controls-scroll');
    const settings=make('div','orderops-table-settings','<button class="table-tool-button" id="tableSettingsButton" type="button" aria-haspopup="menu" aria-controls="tableSettingsMenu" aria-expanded="false">표 설정</button><div class="orderops-table-settings__menu" id="tableSettingsMenu" role="menu" aria-label="표 설정" hidden></div>');
    settings.querySelector('#tableSettingsMenu').append(controls.querySelector('.table-view-tools'),$('warehouseFilterToggle'),$('managerFilterToggle'));controls.insertBefore(settings,$('previewCount'));
    // Header remains navigation and execution only.
    header.classList.add('orderops-workbench-header');
    const primary=make('div','orderops-header-primary');primary.append($('previewTabs'));header.querySelector('.header-actions').before(primary);
    const reset=make('button','','초기화');reset.id='workbenchResetButton';reset.type='button';
    $('analyzeButton').classList.add('header-link');header.querySelector('.header-actions').prepend($('analyzeButton'),reset);
    const bar=make('div','orderops-bottom-workbar');bar.setAttribute('aria-label','저장·출력');
    const save=make('div','orderops-workbar-save');save.append($('headerCloudSaveButton'),system.querySelector('.system-mode'));
    const next=make('div','orderops-workbar-next','<button id="shipmentOpenButton" type="button" hidden>출고확정</button>');
    const more=make('div','orderops-header-menu','<button id="orderOpsHeaderMoreButton" type="button" aria-haspopup="menu" aria-controls="orderOpsHeaderMoreMenu" aria-expanded="false">기타 ▾</button>');
    const moreItems=make('div','orderops-header-menu__items');moreItems.id='orderOpsHeaderMoreMenu';moreItems.hidden=true;moreItems.setAttribute('role','menu');moreItems.append($('smartInputButton'));document.body.append(moreItems);
    next.append($('printButton'),$('downloadButton'),more);bar.append(save,next);result.append(bar);
    // Existing row inspector is retained behind a disclosure, not duplicated in the list.
    const rowDetails=make('details','orderops-row-details','<summary>선택 행 상세</summary>');
    rowDetails.append(right.querySelector('#inventoryInspectorIdentity'),right.querySelector('#inventoryInspectorMetrics'),right.querySelector('#inventoryInspectorBody'));
    const close=right.querySelector('#inventoryInspectorClose');right.replaceChildren();
    const rightHead=make('div','orderops-side-panel__head','<h3>전표관리</h3>');rightHead.append(close);right.append(rightHead);
    right.insertAdjacentHTML('beforeend',`
      <div class="voucher-date"><label>주문일 범위<span><input id="voucherDateFrom" type="date" aria-label="주문 시작일"><span>~</span><input id="voucherDateTo" type="date" aria-label="주문 종료일"></span></label><button id="voucherRangeReset" type="button">전체 기간</button></div>
      <section class="voucher-filter"><strong>창고</strong><div id="voucherWarehouses" class="voucher-chips"></div></section>
      <section class="voucher-filter"><strong>담당자</strong><div id="voucherManagers" class="voucher-chips"></div></section>
      <h4 id="voucherCount">주문 목록 (0건)</h4>
      <div class="voucher-searchbar"><label><input id="voucherSelectAll" type="checkbox">전체선택</label><input id="voucherSearch" type="search" autocomplete="off" placeholder="거래처명, 적요 검색" aria-label="전표 검색"></div>
      <div class="voucher-table-scroll"><table class="voucher-table" data-nexus-table-ux="off"><colgroup><col style="width:30px"><col style="width:78px"><col><col style="width:24%"></colgroup><thead><tr><th aria-label="선택"></th><th>주문일</th><th>거래처 / 수량 / 금액</th><th>적요</th></tr></thead><tbody id="voucherRows"></tbody></table></div>
      <div id="voucherTotals" class="voucher-totals" role="status" aria-live="polite">선택 0건</div>
      <section id="voucherBulk" class="voucher-bulk" hidden><div><strong>일괄 정보 변경</strong><button id="voucherCancel" type="button">입력 취소</button></div>
        <label>창고<input id="voucherWarehouseInput" type="text" list="voucherWarehouseOptions" placeholder="변경할 창고"><button type="button" id="voucherWarehouseApply">적용</button></label>
        <label>담당자<input id="voucherManagerInput" type="text" list="orderOpsManagerOptions" placeholder="변경할 담당자"><button type="button" id="voucherManagerApply">적용</button></label>
        <button type="button" id="voucherApply">선택 전표 적용</button><datalist id="voucherWarehouseOptions"></datalist></section>`);
    right.append(rowDetails);
    const footer=shell.querySelector('.page-footer');workspace.append(left,result,right);shell.insertBefore(workspace,footer);system.remove();
    // Status and dialogs live outside clipped/resizable panels.
    const status=system.querySelector('.system-topbar');
    status.id='orderOpsWorkbenchStatus';status.setAttribute('popover','auto');status.classList.add('orderops-workbench-status-popover');
    const statusButton=make('button','table-tool-button','작업 상태 ▾');statusButton.id='orderOpsWorkbenchStatusButton';statusButton.type='button';statusButton.setAttribute('popovertarget',status.id);statusButton.setAttribute('aria-expanded','false');
    controls.parentElement.append(statusButton);document.body.append(status);
    const sync=()=>{const invalid=status.querySelector('.validation-box')?.classList.contains('bad');statusButton.textContent=invalid?'! 확인 필요 ▾':'작업 상태 ▾';statusButton.dataset.error=String(Boolean(invalid));};
    new MutationObserver(sync).observe(status,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']});sync();
    status.addEventListener('toggle',ev=>statusButton.setAttribute('aria-expanded',String(ev.newState==='open')));
    const shipment=make('dialog','orderops-workbench-dialog','<form method="dialog"><button aria-label="출고 확인 닫기">닫기</button></form>');shipment.id='shipmentWorkbenchDialog';shipment.append($('shipmentExecution'));document.body.append(shipment);
    // Close and resize are separate controls. Existing shared drag handles stay untouched.
    $('orderOpsHeaderOrderQButton').addEventListener('click',()=>{left.querySelector('#orderSourcePanel').open=true;});
    left.addEventListener('keydown',event=>{if(event.key==='Escape' && !event.target.closest('input,select,textarea')) $('preparePaneClose').click();});
  };
})(window);
