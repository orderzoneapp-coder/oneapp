(async () => {
  const { state: s, workbench: w, renderResults } = __ops;
  const e = ShippingManagementEngine;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (check, label) => {
    for (let index = 0; index < 300; index += 1) {
      if (check()) return;
      await sleep(20);
    }
    throw new Error(label);
  };
  const { mapOrderQSnapshotToParsedOrders } = await import('/orderops/orderq-order-source-adapter.js');
  const snapshot = ({ id, revision, hash, quantity, supplyAmount, unitPrice, memo, description }) => ({
    companyId: 'ONEAPP',
    orderId: id,
    orderNo: id === 'ACCEPT-A' ? 'A-9001' : 'B-9002',
    orderDate: id === 'ACCEPT-A' ? '2026-09-12' : '2026-09-13',
    orderRevision: revision,
    snapshotHash: hash.repeat(64),
    eligible: true,
    customerId: id === 'ACCEPT-A' ? 'ACCEPT-C-A' : 'ACCEPT-C-B',
    customerName: id === 'ACCEPT-A' ? '검수 거래처 A' : '검수 거래처 B',
    warehouseName: id === 'ACCEPT-A' ? '1창고' : '2창고',
    assigneeName: id === 'ACCEPT-A' ? '원본 담당 A' : '원본 담당 B',
    candidateLines: [{
      orderItemId: `${id}-LINE`, sourceLineKey: `${id}-SOURCE-LINE`,
      itemCode: id === 'ACCEPT-A' ? 'P-A' : 'P-B', itemName: id === 'ACCEPT-A' ? '검수 상품 A' : '검수 상품 B',
      unit: 'EA', shippableQuantity: quantity, unitPrice, supplyAmount, memo, description,
    }],
  });
  const source = revision => {
    const a = snapshot({
      id: 'ACCEPT-A', revision, hash: revision === 1 ? 'a' : revision === 2 ? 'd' : 'e', quantity: revision === 1 ? 2 : revision === 2 ? 4 : 6,
      supplyAmount: revision === 1 ? 2000 : revision === 2 ? 4000 : 6000, unitPrice: 1000, memo: '원본 적요 A', description: '직원 메모 A',
    });
    const b = snapshot({
      id: 'ACCEPT-B', revision: 1, hash: 'b', quantity: 3,
      supplyAmount: '', unitPrice: 300, memo: '원본 적요 B', description: '직원 메모 B',
    });
    return OrderOpsSourceCoordinator.combineOrderSources([
      { status: 'READY', snapshot: a, parsedOrders: mapOrderQSnapshotToParsedOrders(a) },
      { status: 'READY', snapshot: b, parsedOrders: mapOrderQSnapshotToParsedOrders(b) },
    ], { fileHash: (revision === 1 ? 'c' : revision === 2 ? '9' : '8').repeat(64), fileName: `ORDER Q 검수 ${revision}` });
  };
  const applyPrepared = async () => {
    document.querySelector('#prepareApplyButton').click();
    await until(() => !w.operation, 'prepared application did not settle');
  };

  s.inventory = {
    kind: 'inventory', fileName: 'acceptance-stock.xlsx', sheetName: '재고', fileHash: 'f'.repeat(64),
    headerRowIndex: 0, rowCount: 2, sourceMatrix: [], errors: [], warnings: [], missingColumns: [],
    rows: [
      { productCode: 'P-A', productName: '검수 상품 A', unit: 'EA', inventoryTotal: 20 },
      { productCode: 'P-B', productName: '검수 상품 B', unit: 'EA', inventoryTotal: 20 },
    ],
  };
  w.prepareParsedSource(source(1));
  await applyPrepared();
  assert(s.workspace?.orders?.length === 2, 'initial multi-document source was not applied');
  const rowB = s.workspace.orders.find(row => row.orderId === 'ACCEPT-B');
  e.applyOrderPatches(s.workspace, [{
    workRowId: rowB.workRowId,
    values: { manager: '작업 담당 B', warehouse: '작업 창고 B' },
    expected: { manager: rowB.manager, warehouse: rowB.warehouse },
  }], { recordHistory: true, actor: 'acceptance-browser' });
  e.setPurchaseValue(s.workspace, 'P-B', '보존 구매처', { recordHistory: true, actor: 'acceptance-browser' });
  s.shipmentDraft['ACCEPT-B-LINE'] = { shippedQuantity: '2', reason: '보존 출고 초안' };
  renderResults();

  const tableText = document.querySelector('.orderops-delivery-table').textContent;
  assert(tableText.includes('09-12') && tableText.includes('09-13'), 'delivery list compact dates missing');
  assert(tableText.includes('2,000원') && tableText.includes('계산 900원'), 'original/calculated delivery amounts missing');
  assert(tableText.includes('원본 적요 A') && tableText.includes('직원 메모 B'), 'delivery notes missing');
  document.querySelector('#deliveryVoucherCheckAll').click();
  const selectedText = document.querySelector('#deliveryManagerAssignmentSummary').textContent;
  assert(selectedText.includes('원본금액 2,000원'), 'selected original amount total missing');
  assert(selectedText.includes('계산금액 900원 · 읽기용'), 'selected calculated amount total missing');

  const beforeSame = JSON.stringify(s.workspace);
  const sameItem = w.prepareParsedSource(source(1));
  assert(sameItem.status === 'APPLIED' && !sameItem.dirty && !sameItem.include, 'same source must be an already-applied no-op');
  assert(JSON.stringify(s.workspace) === beforeSame, 'same source preparation changed current work');

  const changedItem = w.prepareParsedSource(source(2));
  assert(changedItem.dirty && changedItem.include, 'changed source must require application');
  globalThis.__testPutRecord = async () => { throw new Error('합성 저장 실패'); };
  await applyPrepared();
  delete globalThis.__testPutRecord;
  assert(document.querySelector('#prepareStatus').textContent.includes('합성 저장 실패'), 'storage failure was not surfaced');
  assert(changedItem.dirty, 'failed source must remain pending');
  assert(s.workspace.orders.find(row => row.orderId === 'ACCEPT-A').quantity === 2, 'failed source changed accepted order');
  assert(s.workspace.orders.find(row => row.orderId === 'ACCEPT-B').manager === '작업 담당 B', 'failed source lost manager work');

  await applyPrepared();
  assert(s.workspace.workbenchReconciliation?.schemaVersion === 'orderops-prepared-source-reconciliation/v1', 'accepted reconciliation audit missing');
  assert(s.workspace.orders.find(row => row.orderId === 'ACCEPT-A').quantity === 4, 'changed document did not receive latest source');
  const acceptedB = s.workspace.orders.find(row => row.orderId === 'ACCEPT-B');
  assert(acceptedB.manager === '작업 담당 B' && acceptedB.warehouse === '작업 창고 B', `unchanged document work was not preserved: ${JSON.stringify({ manager: acceptedB.manager, warehouse: acceptedB.warehouse, comparison: s.workspace.workbenchReconciliation?.comparison })}`);
  assert(e.getPurchaseInputs(s.workspace)['P-B'] === '보존 구매처', 'purchase input was not preserved');
  assert(s.workspace.workbenchPreparedShipmentDrafts?.values?.['ACCEPT-B-LINE']?.reason === '보존 출고 초안', 'multi-document shipment draft was not preserved');
  assert(s.workspace.systemHistory.events.at(-1).kind === 'ORDER_PREPARED_SOURCE_RECONCILED', 'reconciliation history missing');

  for (const kind of ['purchases', 'sales']) {
    const referenceItem = w.prepareParsedSource({
      status: 'READY',
      parsed: {
        kind,
        fileName: `${kind}-continuity.xlsx`,
        fileHash: (kind === 'purchases' ? '6' : '7').repeat(64),
        sheetName: kind === 'purchases' ? '구매' : '판매',
        headerRowIndex: 0,
        rowCount: 1,
        rows: [{ productCode: 'P-A', productName: '검수 상품 A', quantity: 1, partner: kind === 'purchases' ? '검수 구매처' : '검수 판매처', sourceRowNumber: 2 }],
        errors: [], warnings: [], missingColumns: [], sourceMatrix: [],
      },
    });
    assert(referenceItem.dirty && referenceItem.include, `${kind} reference source was not prepared`);
    await applyPrepared();
    assert(s.workspace.workbenchPreparedShipmentDrafts?.values?.['ACCEPT-B-LINE']?.reason === '보존 출고 초안', `${kind}-only application lost multi-document shipment draft`);
    assert(s.workspace.workbenchSourceBaselines?.orders?.sourceDocuments?.length === 2, `${kind}-only application lost immutable order baseline`);
  }

  const analysis = await __ops.performAnalysis();
  assert(analysis?.ok, `analysis failed: ${JSON.stringify(analysis)}`);
  assert(s.workspace.workbenchSourceBaselines?.orders?.sourceDocuments?.length === 2, 'analysis lost immutable order baseline');
  assert(s.workspace.workbenchPreparedShipmentDrafts?.values?.['ACCEPT-B-LINE']?.reason === '보존 출고 초안', 'analysis lost multi-document shipment draft');
  const analyzedB = s.workspace.orders.find(row => row.orderId === 'ACCEPT-B');
  assert(analyzedB.manager === '작업 담당 B' && analyzedB.warehouse === '작업 창고 B', 'analysis changed unchanged document work');
  return {
    sameRevision: 'idempotent', changedRevision: 'reconciled', failedStorage: 'non-destructive',
    preserved: ['manager', 'warehouse', 'purchase', 'shipmentDraft'],
    continuity: ['purchase-only', 'sales-only', 'analysis'],
    deliveryColumns: ['date', 'originalAmount', 'calculatedAmount', 'note'],
  };
})()
