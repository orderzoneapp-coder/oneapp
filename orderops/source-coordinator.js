(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.OrderOpsSourceCoordinator = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SOURCE_COORDINATOR_SCHEMA = 'ONEAPP_ORDEROPS_SOURCE_COORDINATOR_V1';
  const SOURCE_REGISTRY_SCHEMA = 'ONEAPP_ORDEROPS_SOURCE_REGISTRY_V1';
  const STATUS = Object.freeze({
    LOADING: 'LOADING', READY: 'READY', EMPTY: 'EMPTY', ERROR: 'ERROR', PARTIAL: 'PARTIAL'
  });
  const text = value => String(value ?? '').trim();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const equal = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  const validHash = value => /^[a-f0-9]{64}$/i.test(text(value));
  const WORK_FIELDS = ['quantity', 'unitPrice', 'noteOriginal', 'note1Original', 'warehouse', 'manager', 'customer', 'group'];

  function orderDocumentIdentity(snapshot = {}) {
    const companyId = text(snapshot.companyId || 'ONEAPP');
    const orderId = text(snapshot.orderId);
    return orderId ? `${companyId}:order:${orderId}` : '';
  }

  function orderLineIdentity(snapshot = {}, line = {}, lineIndex = 0) {
    const documentId = orderDocumentIdentity(snapshot);
    const lineId = text(line.orderItemId || line.sourceLineKey);
    return documentId && lineId ? `${documentId}:line:${lineId}` : `${documentId}:line-index:${lineIndex + 1}`;
  }

  function preparedRowIdentity(row = {}, rowIndex = 0) {
    if (text(row.workRowId)) return text(row.workRowId);
    const documentId = text(row.sourceDocumentKey || row.orderId || row.voucherId);
    const lineId = text(row.orderItemId || row.sourceLineKey);
    if (documentId && lineId) return `${documentId}:line:${lineId}`;
    const sourceRow = Number(row.originalSourceRowNumber || row.sourceRowNumber) || rowIndex + 1;
    return `${documentId || 'unidentified'}:row:${sourceRow}`;
  }

  function sourceDocumentVersions(parsed = {}) {
    const documents = parsed?.sourceRegistry?.documents || parsed?.sourceDocuments || [];
    const rows = Array.isArray(documents) && documents.length
      ? documents
      : (text(parsed.orderId) ? [{
          sourceDocumentKey: `${text(parsed.companyId || 'ONEAPP')}:order:${text(parsed.orderId)}`,
          companyId: text(parsed.companyId || 'ONEAPP'),
          documentId: text(parsed.orderId),
          revision: Number(parsed.orderRevision) || 0,
          hash: text(parsed.orderSnapshotHash),
        }] : []);
    return new Map(rows.map((document) => {
      const sourceDocumentKey = text(document.sourceDocumentKey) || `${text(document.companyId || 'ONEAPP')}:order:${text(document.documentId)}`;
      return [sourceDocumentKey, {
        sourceDocumentKey,
        companyId: text(document.companyId || 'ONEAPP'),
        documentId: text(document.documentId),
        revision: Number(document.revision) || 0,
        hash: text(document.hash),
      }];
    }).filter(([key]) => key));
  }

  function compareOrderSources(previousParsed = {}, nextParsed = {}) {
    const previous = sourceDocumentVersions(previousParsed);
    const next = sourceDocumentVersions(nextParsed);
    const unchanged = [];
    const changed = [];
    const added = [];
    const removed = [];
    next.forEach((document, key) => {
      const before = previous.get(key);
      if (!before) added.push(key);
      else if (before.revision === document.revision && before.hash === document.hash) unchanged.push(key);
      else changed.push(key);
    });
    previous.forEach((_, key) => { if (!next.has(key)) removed.push(key); });
    const fallbackSame = !previous.size && !next.size && validHash(previousParsed.fileHash) &&
      text(previousParsed.fileHash).toLowerCase() === text(nextParsed.fileHash).toLowerCase();
    return Object.freeze({
      same: fallbackSame || (previous.size > 0 && previous.size === next.size && changed.length === 0 && added.length === 0 && removed.length === 0),
      unchanged,
      changed,
      added,
      removed,
    });
  }

  function sameOrderSource(previousParsed = {}, nextParsed = {}) {
    return compareOrderSources(previousParsed, nextParsed).same;
  }

  function reconcilePreparedOrderWork({ previousParsed, nextParsed, workspace, draft = {}, purchaseInputs = {}, choices = {} } = {}) {
    if (!Array.isArray(previousParsed?.rows) || !Array.isArray(nextParsed?.rows) || !Array.isArray(workspace?.orders)) {
      throw new Error('ORDEROPS_PREPARED_RECONCILIATION_INPUT_INVALID');
    }
    const comparison = compareOrderSources(previousParsed, nextParsed);
    const previousRows = new Map(previousParsed.rows.map((row, index) => [preparedRowIdentity(row, index), row]));
    const workRows = new Map(workspace.orders.map((row, index) => [preparedRowIdentity(row, index), row]));
    const used = new Set();
    const conflicts = [];
    const retained = [];
    const added = [];
    const changedIdentityCodes = new Set();
    const nextDraft = Object.create(null);
    const rows = nextParsed.rows.map((nextRow, index) => {
      const key = preparedRowIdentity(nextRow, index);
      const previous = previousRows.get(key);
      const row = clone(nextRow);
      if (!previous) {
        added.push(key);
        return row;
      }
      used.add(key);
      const work = workRows.get(key);
      if (!work) return row;
      const identityChanged = ['productCode', 'sourceUnit', 'specification'].some(field => !equal(previous[field], row[field]));
      if (identityChanged) {
        [previous.productCode, work.productCode, row.productCode].forEach(code => {
          if (text(code)) changedIdentityCodes.add(text(code));
        });
      }
      WORK_FIELDS.forEach((field) => {
        if (equal(work[field], previous[field])) return;
        const id = `${key}:${field}`;
        const dependsOnIdentity = ['quantity', 'unitPrice'].includes(field) && identityChanged;
        const conflicted = dependsOnIdentity || (!equal(row[field], previous[field]) && !equal(row[field], work[field]));
        if (conflicted && !['work', 'latest'].includes(choices[id])) {
          conflicts.push({
            id,
            workRowId: key,
            orderItemId: text(row.orderItemId) || key,
            field,
            base: clone(previous[field]),
            work: clone(work[field]),
            latest: clone(row[field]),
            reason: dependsOnIdentity ? '상품·단위·규격 변경' : '원본과 작업에서 같은 항목 수정',
          });
          return;
        }
        if (!conflicted || choices[id] === 'work') {
          row[field] = clone(work[field]);
          if (field === 'noteOriginal') row.note = clone(work.note);
          if (field === 'note1Original') row.note1 = clone(work.note1);
        }
      });
      if (work.substitution) {
        const id = `${key}:substitution`;
        if (identityChanged && choices[id] !== 'latest') {
          conflicts.push({
            id,
            workRowId: key,
            orderItemId: text(row.orderItemId) || key,
            field: 'substitution',
            base: clone(previous),
            work: clone(work.substitution),
            latest: clone(nextRow),
            latestOnly: true,
            reason: '원상품·단위 변경: 기존 대체 결정을 자동 이전할 수 없습니다. 최신 원상품 적용 후 다시 선택하세요.',
          });
        } else if (!identityChanged) {
          row.substitution = clone(work.substitution);
          ['productCode', 'productName', 'specification', 'sourceUnit'].forEach(field => { row[field] = clone(work[field]); });
        }
      }
      const previousDraftKey = text(previous.orderItemId) || key;
      const nextDraftKey = text(row.orderItemId) || key;
      if (Object.prototype.hasOwnProperty.call(draft, previousDraftKey)) {
        const id = `${key}:shipmentDraft`;
        if (identityChanged && !['work', 'latest'].includes(choices[id])) {
          conflicts.push({
            id,
            workRowId: key,
            orderItemId: nextDraftKey,
            field: 'shipmentDraft',
            base: clone(previous),
            work: clone(draft[previousDraftKey]),
            latest: null,
            reason: '상품·단위 변경: 출고 초안을 재확인하세요.',
          });
        } else if (!identityChanged || choices[id] === 'work') {
          nextDraft[nextDraftKey] = clone(draft[previousDraftKey]);
        }
      }
      retained.push(key);
      return row;
    });
    const removed = previousParsed.rows.filter((row, index) => !used.has(preparedRowIdentity(row, index))).map((row, index) => {
      const key = preparedRowIdentity(row, index);
      const draftKey = text(row.orderItemId) || key;
      return {
        workRowId: key,
        sourceDocumentKey: text(row.sourceDocumentKey),
        original: clone(row),
        work: clone(workRows.get(key)),
        shipmentDraft: clone(draft[draftKey]),
        reason: '최신 준비 자료에서 삭제되거나 대상에서 제외됨',
      };
    });
    return {
      parsedOrders: { ...clone(nextParsed), rows, rowCount: rows.length },
      comparison,
      draft: nextDraft,
      conflicts,
      retained,
      added,
      removed,
      unapplied: [...clone(workspace.workbenchUnapplied || []), ...removed],
      inventoryOverrides: clone(workspace.inventoryOverrides),
      substitutionHistory: clone(workspace.substitutionHistory),
      systemHistory: clone(workspace.systemHistory),
      purchaseInputs: Object.fromEntries(Object.entries(purchaseInputs || {}).filter(([productCode]) => !changedIdentityCodes.has(text(productCode)))),
      excludedPurchaseInputs: Object.entries(purchaseInputs || {}).filter(([productCode]) => changedIdentityCodes.has(text(productCode))).map(([productCode, purchase]) => ({ productCode, purchase, reason: '원상품·단위 변경으로 구매 입력 미적용' })),
    };
  }

  function combineOrderSources(results = [], options = {}) {
    const examined = Array.isArray(results) ? results : [];
    const failures = [];
    const accepted = [];
    const seen = new Set();
    examined.forEach((result, index) => {
      const status = text(result?.status);
      const snapshot = result?.snapshot;
      if (status !== STATUS.READY || !snapshot || !result?.parsedOrders) {
        failures.push({
          index,
          orderId: text(result?.orderId || snapshot?.orderId),
          status: status || STATUS.ERROR,
          error: clone(result?.error || null),
        });
        return;
      }
      const identity = [text(snapshot.orderId), Number(snapshot.orderRevision) || 0, text(snapshot.snapshotHash)].join('\u001f');
      if (seen.has(identity)) return;
      seen.add(identity);
      accepted.push(result);
    });

    const sourceRegistry = [];
    const rows = [];
    accepted.forEach((result) => {
      const snapshot = result.snapshot;
      const sourceDocumentKey = orderDocumentIdentity(snapshot);
      sourceRegistry.push({
        sourceDocumentKey,
        companyId: text(snapshot.companyId || 'ONEAPP'),
        dataKind: 'orders',
        documentId: text(snapshot.orderId),
        documentNo: text(snapshot.orderNo),
        revision: Number(snapshot.orderRevision) || 0,
        hash: text(snapshot.snapshotHash),
        date: text(snapshot.orderDate),
        updatedAt: text(snapshot.orderUpdatedAt),
        rowCount: result.parsedOrders.rows.length,
      });
      result.parsedOrders.rows.forEach((row, lineIndex) => {
        const originalSourceRowNumber = Number(row.sourceRowNumber) || lineIndex + 2;
        rows.push({
          ...clone(row),
          inputOrder: rows.length + 1,
          sourceRowNumber: rows.length + 2,
          originalSourceRowNumber,
          sourceDocumentKey,
          workRowId: orderLineIdentity(snapshot, row, lineIndex),
          companyId: text(snapshot.companyId || 'ONEAPP'),
        });
      });
    });

    const status = failures.length
      ? (rows.length ? STATUS.PARTIAL : (failures.every(item => item.status === STATUS.EMPTY) ? STATUS.EMPTY : STATUS.ERROR))
      : (rows.length ? STATUS.READY : STATUS.EMPTY);
    const fileHash = validHash(options.fileHash)
      ? text(options.fileHash).toLowerCase()
      : (accepted.length === 1 && validHash(accepted[0].snapshot.snapshotHash) ? text(accepted[0].snapshot.snapshotHash).toLowerCase() : '');
    const soleSource = accepted.length === 1 ? accepted[0] : null;
    return {
      schemaVersion: SOURCE_COORDINATOR_SCHEMA,
      status,
      failures,
      acceptedCount: accepted.length,
      requestedCount: examined.length,
      orderQSource: accepted.length === 1 ? clone(accepted[0]) : null,
      parsed: {
        kind: 'orders',
        sourceKind: soleSource ? text(soleSource.parsedOrders.sourceKind || 'ORDERQ_READ_MODEL') : 'ORDERQ_MULTI_READ_MODEL',
        sourceSchemaVersion: SOURCE_COORDINATOR_SCHEMA,
        fileName: options.fileName || (soleSource ? soleSource.parsedOrders.fileName : `ORDER Q 주문 ${accepted.length}건`),
        sheetName: soleSource ? soleSource.parsedOrders.sheetName : 'ORDER Q Read Models',
        fileHash,
        orderId: soleSource ? text(soleSource.snapshot.orderId) : '',
        orderNo: soleSource ? text(soleSource.snapshot.orderNo) : '',
        orderRevision: soleSource ? Number(soleSource.snapshot.orderRevision) || 0 : 0,
        orderSnapshotHash: soleSource ? text(soleSource.snapshot.snapshotHash) : '',
        orderUpdatedAt: soleSource ? text(soleSource.snapshot.orderUpdatedAt) : '',
        headerRowIndex: -1,
        headerRowNumber: null,
        headers: [],
        requiredColumns: [],
        optionalColumns: [],
        missingColumns: [],
        rows,
        rowCount: rows.length,
        errors: status === STATUS.ERROR ? failures.map(item => ({ code: item.status, message: item.error?.message || `${item.orderId || '주문'} 읽기 실패` })) : [],
        warnings: status === STATUS.PARTIAL ? failures.map(item => ({ code: item.status, message: item.error?.message || `${item.orderId || '주문'} 미포함` })) : [],
        headerMapping: { schemaVersion: 'shipping-orderq-multi-read-model-mapping/v1', normalization: 'not-applicable', columns: [] },
        sourceMatrix: [],
        productCodeColumnIndex: -1,
        sourceRegistry: { schemaVersion: SOURCE_REGISTRY_SCHEMA, documents: sourceRegistry },
        sourceDocuments: sourceRegistry,
      },
    };
  }

  function activitySnapshotToParsed(snapshot = {}, kind, options = {}) {
    if (!['purchases', 'sales'].includes(kind)) throw new Error('ORDEROPS_ACTIVITY_KIND_INVALID');
    const mode = kind === 'purchases' ? 'purchase' : 'sale';
    const sourceRows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
    const registry = [];
    const rows = [];
    sourceRows.forEach((document) => {
      const documentId = text(document.id);
      const sourceDocumentKey = `${text(document.companyId || options.companyId || 'ONEAPP')}:${mode}:${documentId}`;
      registry.push({
        sourceDocumentKey,
        companyId: text(document.companyId || options.companyId || 'ONEAPP'),
        dataKind: kind,
        documentId,
        documentNo: text(document.voucherNo),
        revision: Number(document.revision) || 0,
        hash: text(document.hash),
        date: text(document.date),
        updatedAt: text(document.savedAt),
        rowCount: Array.isArray(document.items) ? document.items.length : 0,
      });
      (Array.isArray(document.items) ? document.items : []).forEach((item, itemIndex) => {
        rows.push({
          productCode: text(item.code),
          productName: text(item.name),
          specification: text(item.specification),
          quantity: item.quantity,
          sourceUnit: text(item.unit),
          unitPrice: item.unitPrice,
          amount: item.amount,
          partner: text(document.customerName),
          customer: text(document.customerName),
          customerId: text(document.customerId),
          warehouse: text(document.warehouseName || document.warehouseCode),
          basisDate: text(document.date),
          sourceDocumentKey,
          sourceLineKey: text(item.lineId) || `${sourceDocumentKey}:${itemIndex + 1}`,
          originalSourceRowNumber: itemIndex + 1,
          sourceRowNumber: rows.length + 2,
        });
      });
    });
    const fileHash = validHash(options.fileHash) ? text(options.fileHash).toLowerCase() : '';
    const headers = ['전표', '일자', '거래처', '품목코드', '품목명', '규격', '단위', '수량', '단가', '금액'];
    const sourceMatrix = [headers, ...rows.map(row => [
      row.sourceDocumentKey, row.basisDate, row.partner, row.productCode, row.productName,
      row.specification, row.sourceUnit, row.quantity, row.unitPrice, row.amount,
    ])];
    return {
      schemaVersion: SOURCE_COORDINATOR_SCHEMA,
      status: text(snapshot.status) || (rows.length ? STATUS.READY : STATUS.EMPTY),
      parsed: {
        kind,
        sourceKind: 'ORDERQ_VOUCHER_ACTIVITY',
        sourceSchemaVersion: SOURCE_COORDINATOR_SCHEMA,
        fileName: options.fileName || `ORDER Q ${kind === 'purchases' ? '구매' : '판매'} ${text(snapshot.fromDate || snapshot.date)}~${text(snapshot.toDate || snapshot.date)}`,
        sheetName: kind === 'purchases' ? '구매현황' : '판매현황',
        fileHash,
        headerRowIndex: 0,
        headers,
        explicitMapping: null,
        sourceMatrix,
        rows,
        rowCount: rows.length,
        errors: text(snapshot.status) === STATUS.ERROR ? [clone(snapshot.error || { message: '전표 조회 실패' })] : [],
        warnings: text(snapshot.status) === STATUS.PARTIAL ? [clone(snapshot.error || { message: '일부 범위 조회 실패' })] : [],
        missingColumns: [],
        sourceRegistry: { schemaVersion: SOURCE_REGISTRY_SCHEMA, documents: registry },
        sourceDocuments: registry,
        coverage: clone(snapshot.coverage || null),
      },
    };
  }

  return Object.freeze({
    SOURCE_COORDINATOR_SCHEMA,
    SOURCE_REGISTRY_SCHEMA,
    STATUS,
    orderDocumentIdentity,
    orderLineIdentity,
    preparedRowIdentity,
    sourceDocumentVersions,
    compareOrderSources,
    sameOrderSource,
    reconcilePreparedOrderWork,
    combineOrderSources,
    activitySnapshotToParsed,
  });
});
