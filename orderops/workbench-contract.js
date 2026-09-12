// Pure OrderOps workbench decisions; no repository, DOM or source-owner writes.
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const text = value => String(value ?? '').trim();
const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const fields = ['quantity', 'unitPrice', 'noteOriginal', 'note1Original', 'warehouse', 'manager', 'customer', 'group'];

function originalRow(snapshot, line) {
  return { quantity: line.shippableQuantity, unitPrice: line.unitPrice,
    noteOriginal: line.memo, note1Original: line.description,
    warehouse: snapshot.warehouseName || snapshot.warehouseCode, manager: snapshot.assigneeName,
    customer: snapshot.customerName, group: snapshot.orderNo };
}

export function reconcileOrderWork({ previousSnapshot, nextSnapshot, workspace, parsedOrders, draft = {}, choices = {} }) {
  if (!previousSnapshot?.orderId || previousSnapshot.orderId !== nextSnapshot?.orderId) throw new Error('같은 주문의 최신본만 작업값과 조정할 수 있습니다.');
  const previousLines = previousSnapshot.candidateLines || [];
  const nextLines = nextSnapshot.candidateLines || [];
  const previousById = new Map(previousLines.map(line => [line.orderItemId, line]));
  const works = new Map((workspace?.orders || []).map(row => [row.orderItemId, row]));
  const used = new Set();
  const conflicts = [];
  const nextDraft = {};
  const retained = [];
  const added = [];
  const changedIdentityCodes = new Set();
  const rows = parsedOrders.rows.map(nextRow => {
    const line = nextLines.find(item => item.orderItemId === nextRow.orderItemId);
    let previous = previousById.get(nextRow.orderItemId);
    if (!previous && text(line?.sourceLineKey)) {
      const matches = previousLines.filter(item => item.sourceLineKey === line.sourceLineKey);
      if (matches.length === 1 && nextLines.filter(item => item.sourceLineKey === line.sourceLineKey).length === 1 &&
          text(matches[0].itemCode) === text(line.itemCode) && text(matches[0].unit) === text(line.unit)) previous = matches[0];
    }
    const row = clone(nextRow);
    if (!previous) { added.push(row.orderItemId); return row; }
    used.add(previous.orderItemId);
    const work = works.get(previous.orderItemId);
    if (!work) return row;
    const base = originalRow(previousSnapshot, previous);
    const identityChanged = text(previous.itemCode) !== text(line.itemCode) || text(previous.unit) !== text(line.unit) || text(previous.specification) !== text(line.specification);
    if (identityChanged) { changedIdentityCodes.add(text(previous.itemCode)); changedIdentityCodes.add(text(work.productCode)); }
    for (const field of fields) {
      const value = work[field];
      if (equal(value, base[field])) continue;
      const id = `${row.orderItemId}:${field}`;
      const dependsOnIdentity = ['quantity', 'unitPrice'].includes(field) && identityChanged;
      const conflicted = dependsOnIdentity || (!equal(row[field], base[field]) && !equal(row[field], value));
      if (conflicted && !['work', 'latest'].includes(choices[id])) {
        conflicts.push({ id, orderItemId: row.orderItemId, field, base: clone(base[field]), work: clone(value), latest: clone(row[field]), reason: dependsOnIdentity ? '상품·단위·규격 변경' : '원본과 작업에서 같은 항목 수정' });
        continue;
      }
      if (!conflicted || choices[id] === 'work') {
        row[field] = clone(value);
        if (field === 'noteOriginal') row.note = work.note;
        if (field === 'note1Original') row.note1 = work.note1;
      }
    }
    if (work.substitution) {
      const id = `${row.orderItemId}:substitution`;
      if (identityChanged && choices[id] !== 'latest') {
        conflicts.push({ id, orderItemId: row.orderItemId, field: 'substitution', base: clone(previous), work: clone(work.substitution), latest: clone(line), latestOnly: true, reason: '원상품·단위 변경: 기존 대체 결정을 자동 이전할 수 없습니다. 최신 원상품 적용 후 다시 선택하세요.' });
      } else if (!identityChanged) {
        row.substitution = clone(work.substitution);
        for (const key of ['productCode', 'productName', 'specification', 'sourceUnit']) row[key] = work[key];
      }
    }
    if (Object.prototype.hasOwnProperty.call(draft, previous.orderItemId)) {
      const id = `${row.orderItemId}:shipmentDraft`;
      if (identityChanged && !['work', 'latest'].includes(choices[id])) conflicts.push({ id, orderItemId: row.orderItemId, field: 'shipmentDraft', base: clone(previous), work: clone(draft[previous.orderItemId]), latest: null, reason: '상품·단위 변경: 출고 초안을 재확인하세요.' });
      else if (!identityChanged || choices[id] === 'work') nextDraft[row.orderItemId] = clone(draft[previous.orderItemId]);
    }
    retained.push(row.orderItemId);
    return row;
  });
  const removed = previousLines.filter(line => !used.has(line.orderItemId)).map(line => ({
    orderId: previousSnapshot.orderId, orderRevision: previousSnapshot.orderRevision, orderItemId: line.orderItemId,
    original: clone(line), work: clone(works.get(line.orderItemId)), shipmentDraft: clone(draft[line.orderItemId]), reason: '최신 주문에서 삭제되거나 출고 대상에서 제외됨'
  }));
  const inventoryOverrides = clone(workspace?.inventoryOverrides);
  const excludedOverrides = [];
  if (inventoryOverrides?.cells) inventoryOverrides.cells = inventoryOverrides.cells.filter(cell => {
    if (!changedIdentityCodes.has(text(cell.productCode))) return true;
    excludedOverrides.push({ ...cell, reason: '원상품·단위 변경으로 수기 보정 미적용' }); return false;
  });
  return { parsedOrders: { ...clone(parsedOrders), rows, rowCount: rows.length }, draft: nextDraft, conflicts, retained, added, removed,
    unapplied: [...clone(workspace?.workbenchUnapplied || []), ...removed], excludedOverrides,
    inventoryOverrides, substitutionHistory: clone(workspace?.substitutionHistory), systemHistory: clone(workspace?.systemHistory),
    excludedPurchaseInputs: (workspace?.purchaseManagement || []).filter(row => row.rowType === 'main' && changedIdentityCodes.has(text(row.productCode))).map(row => ({ productCode: row.productCode, purchase: row.purchase ?? '', reason: '원상품·단위 변경으로 구매 입력 미적용' })),
    purchaseInputs: Object.fromEntries((workspace?.purchaseManagement || []).filter(row => row.rowType === 'main' && !changedIdentityCodes.has(text(row.productCode))).map(row => [row.productCode, row.purchase ?? ''])) };
}

export function shipmentWorkbenchBlockers({ snapshot, workspace, results }) {
  const blockers = [];
  if (!snapshot?.orderId || workspace?.sourceFiles?.orders?.sourceKind !== 'ORDERQ_READ_MODEL') return ['ORDER Q 주문 원본이 필요합니다.'];
  if (!results || !['READY', 'EMPTY'].includes(results.status) || !results.currentSnapshot) blockers.push('최신 주문·출고 이력 조회 결과를 확인하지 못했습니다.');
  else if (Number(results.currentSnapshot.orderRevision) !== Number(snapshot.orderRevision) || results.currentSnapshot.snapshotHash !== snapshot.snapshotHash) blockers.push('주문 원본이 변경되었습니다. 최신 주문을 적용하세요.');
  if (results?.reviewRequired) blockers.push('기존 확정 출고 확인 필요 · 최신 주문 적용만으로 추가 출고를 재개할 수 없습니다.');
  if (workspace?.inventoryApplicationMode === 'TOTAL_ONLY') blockers.push('총량 비교 재고는 공식 출고에 사용할 수 없습니다.');
  if (workspace?.workbenchConflicts?.length) blockers.push('미해결 작업값 충돌이 있습니다.');
  const rows = workspace?.orders || [];
  const originalWarehouse = text(snapshot.warehouseName || snapshot.warehouseCode);
  if (new Set(rows.map(row => text(row.warehouse))).size > 1) blockers.push('같은 주문에 혼합 창고가 있습니다. 공식 출고는 문서당 창고 하나입니다.');
  if (rows.some(row => text(row.warehouse) !== originalWarehouse ||
      (row.warehouseId && text(row.warehouseId) !== text(snapshot.warehouseId)) ||
      (row.warehouseCode && text(row.warehouseCode) !== text(snapshot.warehouseCode)))) blockers.push('작업본 창고가 공식 주문 원본과 다릅니다.');
  if (rows.some(row => text(row.manager) !== text(snapshot.assigneeName) ||
      (row.assigneeId && text(row.assigneeId) !== text(snapshot.assigneeId)))) blockers.push('작업본 담당자가 공식 주문 원본과 다릅니다.');
  return [...new Set(blockers)];
}
