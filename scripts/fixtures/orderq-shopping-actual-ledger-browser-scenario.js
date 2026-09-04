const DB_NAME = 'oneapp-orderq-pre-m1-v6';

function sourceRow({ customer = '브라우저거래처', code = 'P-001', name = '브라우저상품', quantity = 1,
  unitPrice = 1200, amount = Number(quantity) * Number(unitPrice), boundary = 'DOC-1', status = '입금', row = 2 } = {}) {
  return {
    sourceCells: [
      '2026-09-04', customer, '88', status, '원본 전달사항', '원본 상점메모', code, name, 'BOX',
      quantity, unitPrice, amount, code, '원본 주소', '010-1234-5678', code, 'a4579'
    ],
    sourceBoundaryKey: boundary,
    sourceRowNumber: row
  };
}

async function resetDb(dbModule) {
  await dbModule.closeOrderQDb();
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('SHOPPING_TEST_DB_DELETE_BLOCKED'));
  });
}

function buildCandidateSet(adapter, rows, overrides = {}) {
  const built = adapter.createShoppingOrderCandidates(rows, {
    headers: [
      '배송일자', '거래처명', '그룹', '주문상태', '전하실말씀', '상점메모', '상품코드', '상품명', '규격',
      '수량', '단가', '금액', '복사원코드', '주소', '전화2', '원코드', '유통그룹관리코드'
    ],
    companyId: 'ONEAPP',
    warehouseId: Object.hasOwn(overrides, 'warehouseId') ? overrides.warehouseId : 'WH-01',
    warehouseCode: Object.hasOwn(overrides, 'warehouseCode') ? overrides.warehouseCode : '01',
    warehouseName: Object.hasOwn(overrides, 'warehouseName') ? overrides.warehouseName : '본사창고',
    resolveCustomer: overrides.resolveCustomer || (raw => ({ customerId: `CUS:${String(raw['거래처명']).trim()}`, customerName: raw['거래처명'] })),
    resolveProduct: overrides.resolveProduct || (raw => ({
      productId: `PRODUCT:${String(raw['상품코드']).trim()}`,
      itemCode: String(raw['상품코드']).trim(),
      itemName: raw['상품명'], specification: raw['규격'], unit: raw['규격']
    })),
    fileName: overrides.fileName || 'browser-source.xls',
    sheetName: 'Worksheet',
    uploadedAt: overrides.uploadedAt || '2026-09-04T09:00:00+09:00'
  });
  return built;
}

function candidateSet(adapter, rows, overrides = {}) {
  const built = buildCandidateSet(adapter, rows, overrides);
  if (built.issues.length || built.candidates.some(candidate => candidate.issues.length)) {
    throw new Error(`SHOPPING_TEST_CANDIDATE_INVALID:${JSON.stringify(built)}`);
  }
  return built.candidates;
}

async function manualSeed(createOrder, candidate, sourceMessageKey) {
  return createOrder({
    companyId: 'ONEAPP',
    orderDate: candidate.orderDate,
    deliveryExpectedDate: candidate.deliveryDate,
    customerId: candidate.customerId,
    customerName: candidate.customerName,
    warehouseId: candidate.warehouseId,
    warehouseCode: candidate.warehouseCode,
    warehouseName: candidate.warehouseName,
    sourceType: 'MANUAL',
    sourceId: 'MANUAL-TEST',
    sourceMessageKey,
    items: candidate.items.map(item => ({
      productId: item.productId,
      itemCode: item.itemCode,
      itemName: item.itemName,
      specification: item.specification,
      finalUnit: item.unit,
      finalQuantity: item.quantity,
      rawUnit: item.unit,
      rawQuantity: item.quantity,
      price: item.unitPrice,
      supplyAmount: item.amount
    }))
  });
}

async function storeState(dbModule) {
  const db = await dbModule.openOrderQDb();
  const stores = ['orders', 'orderItems', 'orderEvents', 'syncQueue', 'meta'];
  const tx = db.transaction(stores, 'readonly');
  const result = {};
  await Promise.all(stores.map(async store => {
    result[store] = await dbModule.requestToPromise(tx.objectStore(store).getAll());
  }));
  await dbModule.transactionDone(tx);
  return result;
}

async function injectedFailure(adapter, dbModule, targetStore, code, secondCandidate = false) {
  await resetDb(dbModule);
  const rows = secondCandidate
    ? [sourceRow({ customer: '실패후보', code: 'FAIL', boundary: 'FAIL' }), sourceRow({ customer: '정상후보', code: 'OK', boundary: 'OK', row: 3 })]
    : [sourceRow({ customer: `실패-${targetStore}`, code: `FAIL-${targetStore}`, boundary: targetStore })];
  const candidates = candidateSet(adapter, rows);
  const before = await storeState(dbModule);
  const originalAdd = IDBObjectStore.prototype.add;
  let injected = false;
  IDBObjectStore.prototype.add = function addWithFailure(...args) {
    const firstCandidateTarget = targetStore !== 'orderItems' || String(args[0]?.itemCode || '').startsWith('FAIL');
    if (!injected && this.name === targetStore && firstCandidateTarget) {
      injected = true;
      throw new Error(code);
    }
    return originalAdd.apply(this, args);
  };
  let result;
  try {
    result = await adapter.commitShoppingOrderImport({
      schemaVersion: 'ONEAPP_ORDERQ_SHOPPING_ORDER_DEDUPE_V1', companyId: 'ONEAPP', candidates, actor: 'BROWSER_TEST'
    });
  } finally {
    IDBObjectStore.prototype.add = originalAdd;
  }
  const after = await storeState(dbModule);
  return { injected, result, before, after };
}

export async function runOrderQShoppingActualLedgerScenario() {
  const adapter = await import('/orderq/shopping-order-command-adapter.js?browser-scenario=1');
  const repository = await import('/orderq/shopping-order-import-repository.js?browser-scenario=1');
  const intake = await import('/orderq/order-intake-engine.js?v=0.8.0');
  const dbModule = await import('/orderq/orderq-db.js?v=0.8.0');
  const readwriteTransactions = [];
  const originalTransaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function observedTransaction(storeNames, mode, ...rest) {
    if (mode === 'readwrite') readwriteTransactions.push(Array.isArray(storeNames) ? [...storeNames] : [storeNames]);
    return originalTransaction.call(this, storeNames, mode, ...rest);
  };

  try {
    await resetDb(dbModule);
    const evidenceCandidate = candidateSet(adapter, [sourceRow({ customer: '원본보존', code: 'E-001', boundary: 'EVIDENCE' })])[0];
    const evidenceCommit = await adapter.commitShoppingOrderImport({
      schemaVersion: 'ONEAPP_ORDERQ_SHOPPING_ORDER_DEDUPE_V1', companyId: 'ONEAPP', candidates: [evidenceCandidate], actor: 'BROWSER_TEST'
    });
    const evidenceState = await storeState(dbModule);
    const storedOrder = evidenceState.orders[0];
    const firstCounts = Object.fromEntries(Object.entries(evidenceState).map(([key, rows]) => [key, rows.length]));
    const duplicateBefore = await storeState(dbModule);
    const duplicateCommit = await adapter.commitShoppingOrderImport({
      schemaVersion: 'ONEAPP_ORDERQ_SHOPPING_ORDER_DEDUPE_V1', companyId: 'ONEAPP', candidates: [evidenceCandidate], actor: 'BROWSER_TEST'
    });
    const duplicateAfter = await storeState(dbModule);

    await resetDb(dbModule);
    const raceCandidates = candidateSet(adapter, [
      sourceRow({ customer: '경합거래처', code: 'R-001', boundary: 'RACE-1' }),
      sourceRow({ customer: '경합거래처', code: 'R-001', boundary: 'RACE-2', row: 3 })
    ]);
    const raceManual = await manualSeed(intake.createOrder, raceCandidates[0], 'MANUAL-RACE-1');
    raceCandidates.forEach(candidate => { candidate.customerId = raceManual.order.customerId; });
    const [raceA, raceB] = await Promise.all([
      adapter.commitShoppingOrderImport({ schemaVersion: 'ONEAPP_ORDERQ_SHOPPING_ORDER_DEDUPE_V1', companyId: 'ONEAPP', candidates: raceCandidates, actor: 'TAB-A' }),
      adapter.commitShoppingOrderImport({ schemaVersion: 'ONEAPP_ORDERQ_SHOPPING_ORDER_DEDUPE_V1', companyId: 'ONEAPP', candidates: raceCandidates, actor: 'TAB-B' })
    ]);
    const raceState = await storeState(dbModule);

    await resetDb(dbModule);
    const staleCandidates = candidateSet(adapter, [
      sourceRow({ customer: '재확인거래처', code: 'S-001', boundary: 'STALE-1' }),
      sourceRow({ customer: '재확인거래처', code: 'S-001', boundary: 'STALE-2', row: 3 })
    ]);
    const staleManual = await manualSeed(intake.createOrder, staleCandidates[0], 'MANUAL-STALE-1');
    staleCandidates.forEach(candidate => { candidate.customerId = staleManual.order.customerId; });
    const stalePlan = await adapter.inspectShoppingOrderImport({
      schemaVersion: 'ONEAPP_ORDERQ_SHOPPING_ORDER_DEDUPE_V1', companyId: 'ONEAPP', candidates: staleCandidates
    });
    await manualSeed(intake.createOrder, staleCandidates[0], 'MANUAL-STALE-2');
    const staleCommit = await repository.commitShoppingOrderCandidate(stalePlan.results[1], { defaultCompanyId: 'ONEAPP', actor: 'STALE_TEST' });
    const staleState = await storeState(dbModule);

    const itemFailure = await injectedFailure(adapter, dbModule, 'orderItems', 'INJECTED_ITEM_FAILURE');
    const eventFailure = await injectedFailure(adapter, dbModule, 'orderEvents', 'INJECTED_EVENT_FAILURE');
    const queueFailure = await injectedFailure(adapter, dbModule, 'syncQueue', 'INJECTED_QUEUE_FAILURE');
    const isolatedFailure = await injectedFailure(adapter, dbModule, 'orderItems', 'INJECTED_FIRST_CANDIDATE_FAILURE', true);

    await resetDb(dbModule);
    const reviewAndNormal = candidateSet(adapter, [sourceRow({ customer: '정상후보', code: 'GOOD', boundary: 'GOOD' })]);
    const invalid = JSON.parse(JSON.stringify(reviewAndNormal[0]));
    invalid.candidateId = 'INVALID-CUSTOMER';
    invalid.customerId = '';
    invalid.customerCode = '';
    invalid.customerName = '';
    invalid.issues = [];
    reviewAndNormal[0].candidateId = 'VALID-AFTER-REVIEW';
    const reviewIsolation = await adapter.commitShoppingOrderImport({
      schemaVersion: 'ONEAPP_ORDERQ_SHOPPING_ORDER_DEDUPE_V1', companyId: 'ONEAPP', candidates: [invalid, reviewAndNormal[0]], actor: 'BROWSER_TEST'
    });
    const reviewIsolationState = await storeState(dbModule);

    await resetDb(dbModule);
    const unresolvedProduct = buildCandidateSet(adapter, [
      sourceRow({ customer: '상품미해소', code: 'NO-PRODUCT-ID', boundary: 'NO-PRODUCT-ID' })
    ], {
      resolveProduct: raw => ({ itemCode: raw['상품코드'], itemName: raw['상품명'], specification: raw['규격'], unit: raw['규격'] })
    }).candidates[0];
    unresolvedProduct.candidateId = 'UNRESOLVED-PRODUCT';
    const partialProduct = buildCandidateSet(adapter, [
      sourceRow({ customer: '부분상품미해소', code: 'RESOLVED', name: '정상상품', boundary: 'PARTIAL', row: 2 }),
      sourceRow({ customer: '부분상품미해소', code: 'UNRESOLVED', name: '미해소상품', boundary: 'PARTIAL', row: 3 })
    ], {
      resolveProduct: raw => ({
        productId: raw['상품코드'] === 'UNRESOLVED' ? '' : `PRODUCT:${raw['상품코드']}`,
        itemCode: raw['상품코드'], itemName: raw['상품명'], specification: raw['규격'], unit: raw['규격']
      })
    }).candidates[0];
    partialProduct.candidateId = 'PARTIAL-UNRESOLVED-PRODUCT';
    const unresolvedCustomer = buildCandidateSet(adapter, [
      sourceRow({ customer: '거래처미해소', code: 'NO-CUSTOMER-ID', boundary: 'NO-CUSTOMER-ID' })
    ], {
      resolveCustomer: raw => ({ customerName: raw['거래처명'] })
    }).candidates[0];
    unresolvedCustomer.candidateId = 'UNRESOLVED-CUSTOMER';
    const unresolvedWarehouse = buildCandidateSet(adapter, [
      sourceRow({ customer: '창고미해소', code: 'NO-WAREHOUSE-ID', boundary: 'NO-WAREHOUSE-ID' })
    ], {
      warehouseId: '', warehouseCode: '', warehouseName: '미해소창고'
    }).candidates[0];
    unresolvedWarehouse.candidateId = 'UNRESOLVED-WAREHOUSE';
    const ownerResolvedNormal = candidateSet(adapter, [
      sourceRow({ customer: '해소정상', code: 'OWNER-OK', boundary: 'OWNER-OK' })
    ])[0];
    ownerResolvedNormal.candidateId = 'OWNER-RESOLVED-NORMAL';
    const ownerResolutionCandidates = [
      unresolvedProduct, partialProduct, unresolvedCustomer, unresolvedWarehouse, ownerResolvedNormal
    ];
    const ownerResolutionInspect = await adapter.inspectShoppingOrderImport({
      schemaVersion: 'ONEAPP_ORDERQ_SHOPPING_ORDER_DEDUPE_V1', companyId: 'ONEAPP', candidates: ownerResolutionCandidates
    });
    const directGuardBefore = await storeState(dbModule);
    const directGuard = [];
    for (const unresolved of ownerResolutionCandidates.slice(0, 4)) {
      const changedAfterInspect = JSON.parse(JSON.stringify(unresolved));
      changedAfterInspect.issues = [];
      directGuard.push(await repository.commitShoppingOrderCandidate({
        candidate: changedAfterInspect,
        candidateId: changedAfterInspect.candidateId,
        status: 'NEW',
        isDuplicate: false,
        canonicalSignature: '0'.repeat(64),
        occurrenceNo: 1,
        issues: []
      }, { defaultCompanyId: 'ONEAPP', actor: 'DIRECT_GUARD_TEST' }));
    }
    const directGuardAfter = await storeState(dbModule);
    const ownerResolutionBefore = await storeState(dbModule);
    const ownerResolutionCommit = await adapter.commitShoppingOrderImport({
      schemaVersion: 'ONEAPP_ORDERQ_SHOPPING_ORDER_DEDUPE_V1', companyId: 'ONEAPP', candidates: ownerResolutionCandidates, actor: 'BROWSER_TEST'
    });
    const ownerResolutionAfter = await storeState(dbModule);

    await resetDb(dbModule);
    const legacyCandidate = candidateSet(adapter, [
      sourceRow({ customer: '레거시코드상품', code: 'LEGACY-CODE', boundary: 'LEGACY-CODE' })
    ])[0];
    const legacySeedCandidate = JSON.parse(JSON.stringify(legacyCandidate));
    legacySeedCandidate.items[0].productId = '';
    const legacySeed = await manualSeed(intake.createOrder, legacySeedCandidate, 'MANUAL-LEGACY-CODE-ONLY');
    legacyCandidate.customerId = legacySeed.order.customerId;
    legacyCandidate.warehouseId = legacySeed.order.warehouseId;
    const legacyInspect = await adapter.inspectShoppingOrderImport({
      schemaVersion: 'ONEAPP_ORDERQ_SHOPPING_ORDER_DEDUPE_V1', companyId: 'ONEAPP', candidates: [legacyCandidate]
    });
    const legacyBefore = await storeState(dbModule);
    const legacyCommit = await adapter.commitShoppingOrderImport({
      schemaVersion: 'ONEAPP_ORDERQ_SHOPPING_ORDER_DEDUPE_V1', companyId: 'ONEAPP', candidates: [legacyCandidate], actor: 'BROWSER_TEST'
    });
    const legacyAfter = await storeState(dbModule);

    return {
      capability: adapter.shoppingOrderCapability(),
      evidence: {
        commit: evidenceCommit.summary,
        counts: firstCounts,
        sourceStatus: storedOrder.shoppingSourceEvidence.rows[0].sourceValues['주문상태'],
        sourceMessage: storedOrder.shoppingSourceEvidence.rows[0].sourceValues['전하실말씀'],
        sourceAddress: storedOrder.shoppingSourceEvidence.rows[0].sourceValues['주소'],
        sourceRowNumber: storedOrder.shoppingSourceEvidence.rows[0].sourceRowNumber,
        externalOrderNo: storedOrder.externalOrderNo,
        internalOrderNo: storedOrder.orderNo,
        signature: storedOrder.shoppingOrderDedupe.canonicalSignature
      },
      duplicateZeroWrite: {
        result: duplicateCommit.results[0],
        unchanged: JSON.stringify(duplicateBefore) === JSON.stringify(duplicateAfter)
      },
      race: {
        finalOrders: raceState.orders.length,
        created: [...raceA.results, ...raceB.results].filter(result => result.status === 'CREATED').length,
        duplicates: [...raceA.results, ...raceB.results].filter(result => result.isDuplicate === true).length,
        sourceKeys: raceState.orders.map(order => order.sourceMessageKey).filter(key => String(key).startsWith('SHOPPING_ORDER_V1:'))
      },
      stale: {
        plannedDuplicate: stalePlan.results[1].isDuplicate,
        committed: staleCommit,
        finalOrders: staleState.orders.length
      },
      rollback: { itemFailure, eventFailure, queueFailure },
      candidateIsolation: {
        injectedFailure: isolatedFailure,
        reviewResult: reviewIsolation,
        reviewOrderCount: reviewIsolationState.orders.length,
        ownerResolution: {
          inspect: ownerResolutionInspect,
          directGuard,
          directGuardUnchanged: JSON.stringify(directGuardBefore) === JSON.stringify(directGuardAfter),
          commit: ownerResolutionCommit,
          beforeCounts: Object.fromEntries(Object.entries(ownerResolutionBefore).map(([key, rows]) => [key, rows.length])),
          afterCounts: Object.fromEntries(Object.entries(ownerResolutionAfter).map(([key, rows]) => [key, rows.length])),
          storedCustomerName: ownerResolutionAfter.orders[0]?.customerName || ''
        },
        legacyCodeOnly: {
          inspect: legacyInspect,
          commit: legacyCommit,
          beforeOrderCount: legacyBefore.orders.length,
          afterOrderCount: legacyAfter.orders.length,
          unchanged: JSON.stringify(legacyBefore) === JSON.stringify(legacyAfter)
        }
      },
      readwriteTransactions
    };
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
    await resetDb(dbModule);
  }
}
