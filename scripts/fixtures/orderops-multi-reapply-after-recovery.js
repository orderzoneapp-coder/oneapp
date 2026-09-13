(async () => {
  const { state: s, workbench: w } = __ops;
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
  const a = snapshot({ id: 'ACCEPT-A', revision: 3, hash: 'e', quantity: 6, supplyAmount: 6000, unitPrice: 1000, memo: '원본 적요 A', description: '직원 메모 A' });
  const b = snapshot({ id: 'ACCEPT-B', revision: 1, hash: 'b', quantity: 3, supplyAmount: '', unitPrice: 300, memo: '원본 적요 B', description: '직원 메모 B' });
  const source = OrderOpsSourceCoordinator.combineOrderSources([
    { status: 'READY', snapshot: a, parsedOrders: mapOrderQSnapshotToParsedOrders(a) },
    { status: 'READY', snapshot: b, parsedOrders: mapOrderQSnapshotToParsedOrders(b) },
  ], { fileHash: '8'.repeat(64), fileName: 'ORDER Q 검수 3' });
  const item = w.prepareParsedSource(source);
  assert(item.dirty && item.include, 'revision 3 source was not prepared after recovery');
  document.querySelector('#prepareApplyButton').click();
  await until(() => !w.operation, 'revision 3 application did not settle');
  const rowA = s.workspace.orders.find(row => row.orderId === 'ACCEPT-A');
  const rowB = s.workspace.orders.find(row => row.orderId === 'ACCEPT-B');
  assert(rowA.quantity === 6, 'changed A revision was not applied after analysis recovery');
  assert(rowB.manager === '작업 담당 B' && rowB.warehouse === '작업 창고 B', `unchanged B work was lost after analysis recovery: ${JSON.stringify({ manager: rowB.manager, warehouse: rowB.warehouse })}`);
  assert(ShippingManagementEngine.getPurchaseInputs(s.workspace)['P-B'] === '보존 구매처', 'B purchase work was lost after analysis recovery');
  assert(s.workspace.workbenchPreparedShipmentDrafts?.values?.['ACCEPT-B-LINE']?.reason === '보존 출고 초안', 'multi-document shipment draft was lost after analysis recovery');
  assert(s.workspace.workbenchReconciliation?.comparison?.changed?.includes('ONEAPP:order:ACCEPT-A'), 'A revision change was not audited');
  assert(s.workspace.workbenchReconciliation?.comparison?.unchanged?.includes('ONEAPP:order:ACCEPT-B'), 'unchanged B was not audited as unchanged');
  return { changed: 'ACCEPT-A@3', unchanged: 'ACCEPT-B@1', preserved: ['manager', 'warehouse', 'purchase', 'shipmentDraft'] };
})()
