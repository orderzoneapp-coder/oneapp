const text = value => String(value ?? '').trim();
const clone = value => JSON.parse(JSON.stringify(value));

export async function runStage6CInventoryRematchScenario() {
  const dbModule = await import('/orderq/orderq-db.js?stage6c-browser=1');
  const rematch = await import('/orderq/inventory-rematch-core.js?stage6c-browser=1');
  const repository = await import('/orderq/official-voucher-repository.js?stage6c-browser=1');
  const officialCore = await import('/orderq/official-voucher-core.js?stage6c-browser=1');
  const gatewayModule = await import('/orderq/official-command-gateway.js?stage6c-browser=1');
  const adapterModule = await import('/orderq/official-command-adapter.js?stage6c-browser=1');
  const products = await import('/reference-data/product-master-read-adapter.js?stage6c-browser=1');

  const { STORE, openOrderQDb, requestToPromise, transactionDone } = dbModule;
  const companyId = 'COMPANY-A';
  const actor = 'USER-6C';
  const occurredAt = '2026-09-03T10:01:00+09:00';
  const judgedAt = '2026-09-03T10:00:00+09:00';
  const productRows = [
    { productId: 'PRODUCT-CODE', companyId, 코드: '0007', 품목명: '동일 이름', 규격: '10kg', 단위: 'BOX', status: 'ACTIVE' },
    { productId: 'PRODUCT-SAME-NAME', companyId, 코드: '0099', 품목명: '동일 이름', 규격: '10kg', 단위: 'BOX', status: 'ACTIVE' },
    { productId: 'PRODUCT-NAME', companyId, 코드: 'NAME-1', 품목명: '품명만 상품', 규격: 'EA', 단위: 'EA', status: 'ACTIVE' },
    { productId: 'PRODUCT-FOREIGN', companyId: 'COMPANY-B', 코드: '0007', 품목명: '동일 이름', 규격: '10kg', 단위: 'BOX', status: 'ACTIVE' }
  ];
  localStorage.setItem('merchMaster_v870', JSON.stringify(productRows));
  localStorage.setItem('merchMaster_revision_v870', 'REV-6C-1');
  const productSnapshot = await products.getProductSnapshot({ now: judgedAt });
  const snapshotEvidence = {
    schemaVersion: productSnapshot.schemaVersion,
    snapshotId: productSnapshot.snapshotId,
    revision: productSnapshot.revision,
    contentHash: productSnapshot.contentHash
  };

  const db = await openOrderQDb();
  const seedStores = [STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES, STORE.SALES_DOCUMENTS, STORE.SALES_LINES,
    STORE.VOUCHER_REVISIONS, STORE.PENDING_INVENTORY_EFFECTS, STORE.UNRESOLVED_PRODUCTS, STORE.INVENTORY_CHECKPOINTS];
  const seedTx = db.transaction(seedStores, 'readwrite');
  const scenarios = new Map();

  function addScenario(unresolvedProductId, originalProductCode, originalProductName, specs, scenarioCompanyId = companyId) {
    const reviewLinks = [];
    const expectedDocuments = [];
    const expectedEffects = [];
    specs.forEach((spec, index) => {
      const mode = spec.mode;
      const suffix = `${unresolvedProductId}-${index + 1}`;
      const documentId = `${mode === 'purchase' ? 'PD' : 'SD'}-${suffix}`;
      const lineId = `${mode === 'purchase' ? 'PL' : 'SL'}-${suffix}`;
      const voucherRevisionId = `VR-${suffix}`;
      const originalCommandId = `POST-${suffix}`;
      const sourceDate = spec.documentDate || spec.date;
      const sourceWarehouseId = spec.lineWarehouseId || spec.warehouseId || 'W1';
      const productSnapshotAtConfirmation = {
        originalProductCode, originalProductName, specification: spec.specification || '10kg', unit: spec.unit || 'BOX'
      };
      const lineProductSnapshot = spec.lineSnapshotProductCode
        ? { ...productSnapshotAtConfirmation, originalProductCode: spec.lineSnapshotProductCode }
        : productSnapshotAtConfirmation;
      const document = {
        companyId: spec.documentCompanyId || scenarioCompanyId,
        identityVersion: 'ONEAPP_ORDERQ_OFFICIAL_IDENTITY_V2',
        status: 'CONFIRMED', businessStatus: 'CONFIRMED', revision: spec.documentRevision || 1,
        businessDate: sourceDate, warehouseId: spec.documentWarehouseId || sourceWarehouseId,
        commandId: spec.documentCommandId || originalCommandId, lastVoucherRevisionId: voucherRevisionId,
        [mode === 'purchase' ? 'purchaseDocumentId' : 'salesDocumentId']: documentId,
        [mode === 'purchase' ? 'purchaseDate' : 'saleDate']: sourceDate,
        ...(spec.documentBusinessOccurredAt ? { businessOccurredAt: spec.documentBusinessOccurredAt } : {})
      };
      const line = {
        companyId: spec.lineCompanyId || scenarioCompanyId,
        identityVersion: 'ONEAPP_ORDERQ_OFFICIAL_IDENTITY_V2',
        status: spec.lineStatus || 'CONFIRMED', lineStatus: spec.lineLifecycleStatus || 'ACTIVE',
        revision: spec.lineRevision || 1, commandId: spec.lineCommandId || originalCommandId,
        unresolvedProductId, productId: '', warehouseId: sourceWarehouseId, actualQuantity: spec.quantity,
        baseQuantity: spec.quantity, inventoryEffectFactor: spec.inventoryEffectFactor ?? 1,
        productSnapshot: lineProductSnapshot,
        [mode === 'purchase' ? 'purchaseDocumentId' : 'salesDocumentId']: documentId,
        [mode === 'purchase' ? 'purchaseLineId' : 'salesLineId']: lineId,
        ...(spec.lineBusinessOccurredAt ? { businessOccurredAt: spec.lineBusinessOccurredAt } : {})
      };
      seedTx.objectStore(mode === 'purchase' ? STORE.PURCHASE_DOCUMENTS : STORE.SALES_DOCUMENTS).add(document);
      seedTx.objectStore(mode === 'purchase' ? STORE.PURCHASE_LINES : STORE.SALES_LINES).add(line);
      const afterSnapshot = { document: clone(document), lines: [clone(line)] };
      seedTx.objectStore(STORE.VOUCHER_REVISIONS).add({
        voucherRevisionId, companyId: spec.revisionCompanyId || scenarioCompanyId,
        identityVersion: 'ONEAPP_ORDERQ_OFFICIAL_IDENTITY_V2', voucherMode: mode,
        documentId, revision: spec.revisionNumber || 1, commandId: spec.revisionCommandId || originalCommandId,
        status: 'CONFIRMED', businessDate: sourceDate, beforeSnapshot: {}, afterSnapshot,
        afterDigest: officialCore.canonicalSha256(afterSnapshot)
      });
      const effectQuantity = spec.effectQuantity ?? spec.quantity;
      const effectSignedQuantity = spec.effectSignedQuantity ?? spec.signedQuantity;
      const effect = {
        pendingEffectId: `PE-${suffix}`, companyId: spec.effectCompanyId || scenarioCompanyId,
        unresolvedProductId, sourceDocumentId: documentId, sourceLineId: lineId,
        sourceDocumentRevision: spec.effectRevision || 1, voucherRevisionId,
        voucherMode: mode, commandId: spec.effectCommandId || originalCommandId,
        warehouseId: spec.effectWarehouseId || sourceWarehouseId,
        effectiveAt: spec.effectDate || sourceDate, quantity: effectQuantity, signedQuantity: effectSignedQuantity,
        unitPrice: 1000, totalAmount: effectQuantity * 1000, status: 'PENDING_PRODUCT_MATCH',
        inventoryEffectStatus: 'UNRESOLVED_PRODUCT', officialInventoryApplied: false,
        productCode: originalProductCode, productName: originalProductName,
        originalProductCode, originalProductName, specification: spec.specification || '10kg', unit: spec.unit || 'BOX',
        productSnapshot: productSnapshotAtConfirmation,
        ...(spec.effectBusinessOccurredAt ? { businessOccurredAt: spec.effectBusinessOccurredAt } : {})
      };
      seedTx.objectStore(STORE.PENDING_INVENTORY_EFFECTS).add(effect);
      const reviewLink = {
        pendingEffectId: effect.pendingEffectId, voucherMode: mode, sourceDocumentId: documentId,
        sourceLineId: spec.reviewLineId || lineId, sourceDocumentRevision: spec.reviewRevision || 1,
        voucherRevisionId, commandId: spec.reviewCommandId || originalCommandId,
        warehouseId: spec.reviewWarehouseId || sourceWarehouseId,
        businessDate: spec.reviewDate || sourceDate,
        quantity: spec.reviewQuantity ?? spec.quantity,
        signedQuantity: spec.reviewSignedQuantity ?? spec.signedQuantity,
        unitPrice: 1000, totalAmount: (spec.reviewQuantity ?? spec.quantity) * 1000,
        inventoryEffectStatus: 'UNRESOLVED_PRODUCT', officialInventoryApplied: false,
        productSnapshot: productSnapshotAtConfirmation,
        ...(spec.reviewBusinessOccurredAt ? { businessOccurredAt: spec.reviewBusinessOccurredAt } : {})
      };
      reviewLinks.push(reviewLink);
      expectedEffects.push({ pendingEffectId: effect.pendingEffectId, voucherMode: mode, documentId, lineId,
        documentRevision: 1, voucherRevisionId });
      expectedDocuments.push({ voucherMode: mode, documentId, revision: 1, voucherRevisionId });
    });
    const unresolved = {
      unresolvedProductId, unresolvedKey: unresolvedProductId, companyId: scenarioCompanyId,
      productId: '', status: 'UNRESOLVED_PRODUCT', inventoryEffectStatus: 'UNRESOLVED_PRODUCT', officialInventoryApplied: false,
      productCode: originalProductCode, productName: originalProductName,
      originalProductCode, originalProductName, specification: specs[0]?.specification || '10kg', unit: specs[0]?.unit || 'BOX',
      reviewLinks, createdAt: '2026-09-03T09:00:00+09:00', updatedAt: '2026-09-03T09:00:00+09:00'
    };
    seedTx.objectStore(STORE.UNRESOLVED_PRODUCTS).add(unresolved);
    scenarios.set(unresolvedProductId, { unresolved, specs, expectedDocuments, expectedEffects });
  }

  addScenario('UP-MIXED', '0007', '', [
    { mode: 'purchase', date: '2026-09-03', quantity: 5, signedQuantity: 5 },
    { mode: 'sale', date: '2026-09-01', quantity: 3, signedQuantity: -3 },
    { mode: 'purchase', date: '2026-09-02', quantity: 0, signedQuantity: 0 },
    { mode: 'sale', date: '2026-09-04', quantity: -2, signedQuantity: 2 }
  ]);
  addScenario('UP-NAME-ONLY', '', '품명만 상품', [
    { mode: 'sale', date: '2026-09-04', quantity: 7, signedQuantity: -7, specification: 'EA', unit: 'EA' }
  ]);
  addScenario('UP-ZERO', '0007', '', [
    { mode: 'purchase', date: '2026-09-04', quantity: 0, signedQuantity: 0 },
    { mode: 'purchase', date: '2026-09-02', quantity: 0, signedQuantity: 0,
      decisionType: 'INCLUDED_IN_CHECKPOINT' },
    { mode: 'sale', date: '2026-09-01', quantity: 0, signedQuantity: 0,
      decisionType: 'NOT_INCLUDED_IN_CHECKPOINT' }
  ]);
  addScenario('UP-STALE-REV', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 1, signedQuantity: 1 }]);
  addScenario('UP-BROKEN', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 1, signedQuantity: 1,
    reviewLineId: 'PL-NONEXISTENT' }]);
  addScenario('UP-CROSS-LINK', '0007', '', [{ mode: 'sale', date: '2026-09-04', quantity: 1, signedQuantity: -1,
    documentCompanyId: 'COMPANY-B' }]);
  addScenario('UP-SNAPSHOT-LINK', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 1,
    signedQuantity: 1, lineSnapshotProductCode: 'TAMPERED' }]);
  addScenario('UP-ROLLBACK', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 4, signedQuantity: 4 }]);
  addScenario('UP-INCOMPLETE', '0007', '', [{ mode: 'purchase', date: '2026-09-01', quantity: 2, signedQuantity: 2 }]);
  addScenario('UP-IDEMPOTENCY', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 2, signedQuantity: 2 }]);
  addScenario('UP-COMPANY-B', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 2, signedQuantity: 2 }], 'COMPANY-B');
  addScenario('UP-WRONG-SIGN', '0007', '', [{ mode: 'sale', date: '2026-09-04', quantity: 5, signedQuantity: -5,
    effectSignedQuantity: 5, reviewSignedQuantity: 5 }]);
  addScenario('UP-WRONG-QUANTITY', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 5, signedQuantity: 5,
    effectQuantity: 6, reviewQuantity: 6 }]);
  addScenario('UP-WRONG-WAREHOUSE', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 5, signedQuantity: 5,
    effectWarehouseId: 'W2', reviewWarehouseId: 'W2' }]);
  addScenario('UP-LATER-DATE', '0007', '', [{ mode: 'purchase', date: '2026-09-01', quantity: 5, signedQuantity: 5,
    effectDate: '2026-09-03', reviewDate: '2026-09-03' }]);
  addScenario('UP-FABRICATED-OCCURRED', '0007', '', [{ mode: 'purchase', date: '2026-09-02', quantity: 5, signedQuantity: 5,
    effectBusinessOccurredAt: '2026-09-02T10:00:00+09:00',
    reviewBusinessOccurredAt: '2026-09-02T10:00:00+09:00' }]);
  addScenario('UP-INACTIVE-LINE', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 5, signedQuantity: 5,
    lineLifecycleStatus: 'INACTIVE' }]);
  addScenario('UP-CANCELLED-LINE', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 5, signedQuantity: 5,
    lineStatus: 'CANCELLED' }]);
  addScenario('UP-DOCUMENT-COMMAND', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 5,
    signedQuantity: 5, documentCommandId: 'TAMPERED-DOCUMENT-COMMAND' }]);
  addScenario('UP-LINE-COMMAND', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 5,
    signedQuantity: 5, lineCommandId: 'TAMPERED-LINE-COMMAND' }]);
  addScenario('UP-REVISION-COMMAND', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 5,
    signedQuantity: 5, revisionCommandId: 'TAMPERED-REVISION-COMMAND' }]);
  addScenario('UP-PENDING-COMMAND', '0007', '', [{ mode: 'purchase', date: '2026-09-04', quantity: 5,
    signedQuantity: 5, effectCommandId: 'TAMPERED-PENDING-COMMAND', reviewCommandId: 'TAMPERED-PENDING-COMMAND' }]);
  addScenario('UP-INVALID-DATE', '0007', '', [{ mode: 'purchase', date: '2026-02-30', quantity: 5,
    signedQuantity: 5, warehouseId: 'W2' }]);
  seedTx.objectStore(STORE.INVENTORY_CHECKPOINTS).add({
    checkpointId: 'CHECKPOINT-W1', sessionId: 'SESSION-W1', companyId, warehouseId: 'W1',
    effectiveAt: '2026-09-02', status: 'CONFIRMED', coversAllProducts: false,
    businessOccurredAt: '2026-09-02T09:00:00+09:00',
    counts: [{ productId: 'PRODUCT-CODE', productCode: '0007', quantity: 100 }], actor, confirmedAt: judgedAt
  });
  await transactionDone(seedTx);

  const repositoryPort = {
    runOfficialInventoryRematchCommand: command => repository.runOfficialInventoryRematchCommand(command)
  };
  const gateway = gatewayModule.createOfficialCommandGateway(repositoryPort,
    { featureGates: { INVENTORY_REMATCH: true } });
  const adapter = adapterModule.createOfficialCommandAdapter(gateway);
  const selectedCode = {
    productId: 'PRODUCT-CODE', companyId, productCode: '0007', productName: '동일 이름', specification: '10kg', unit: 'BOX'
  };
  const selectedName = {
    productId: 'PRODUCT-NAME', companyId, productCode: 'NAME-1', productName: '품명만 상품', specification: 'EA', unit: 'EA'
  };

  function commandFor(unresolvedProductId, selectedProduct, overrides = {}) {
    const scenario = scenarios.get(unresolvedProductId);
    const decisions = scenario.specs.map((spec, index) => {
      if ((spec.warehouseId || 'W1') !== 'W1' || spec.date > '2026-09-02') return null;
      return {
        pendingEffectId: scenario.expectedEffects[index].pendingEffectId,
        decisionType: spec.decisionType || (index % 2 ? 'NOT_INCLUDED_IN_CHECKPOINT' : 'INCLUDED_IN_CHECKPOINT'),
        checkpointId: 'CHECKPOINT-W1', checkpointEffectiveAt: '2026-09-02', targetBusinessDate: spec.date,
        actor, judgedAt
      };
    }).filter(Boolean);
    return adapter.buildInventoryRematchCommand({
      companyId, unresolvedProductId, selectedProduct, productSnapshot: snapshotEvidence,
      selectionEvidence: { selectionMode: 'EXPLICIT_USER_SELECTION', automaticConfirmation: false,
        selectedBy: actor, selectedAt: judgedAt, productSnapshot: snapshotEvidence },
      expectedDocuments: scenario.expectedDocuments,
      expectedEffects: scenario.expectedEffects,
      stocktakeDecisions: decisions,
      actor, occurredAt, judgedAt,
      ...overrides
    });
  }

  async function readStores(storeNames) {
    const readDb = await openOrderQDb();
    const tx = readDb.transaction(storeNames, 'readonly');
    const rows = Object.fromEntries(await Promise.all(storeNames.map(async storeName => [
      storeName, await requestToPromise(tx.objectStore(storeName).getAll())
    ])));
    await transactionDone(tx);
    return rows;
  }

  const before = await readStores([STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES, STORE.SALES_DOCUMENTS,
    STORE.SALES_LINES, STORE.UNRESOLVED_PRODUCTS, STORE.PENDING_INVENTORY_EFFECTS,
    STORE.INVENTORY_MOVEMENTS, STORE.VOUCHER_REVISIONS, STORE.OFFICIAL_COMMANDS, STORE.SYNC_QUEUE]);
  const originalMixedLines = [...before[STORE.PURCHASE_LINES], ...before[STORE.SALES_LINES]]
    .filter(row => row.unresolvedProductId === 'UP-MIXED').map(clone);
  const mixedCommand = commandFor('UP-MIXED', selectedCode);
  const originalTransaction = IDBDatabase.prototype.transaction;
  const commitTransactions = [];
  IDBDatabase.prototype.transaction = function(storeNames, mode, ...rest) {
    if (this.name === dbModule.DB_NAME) commitTransactions.push({
      mode: text(mode || 'readonly'), stores: Array.isArray(storeNames) ? [...storeNames] : [storeNames]
    });
    return originalTransaction.call(this, storeNames, mode, ...rest);
  };
  let mixed;
  try {
    mixed = await adapter.commitInventoryRematchCommand(mixedCommand);
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }
  const afterMixed = await readStores([STORE.PURCHASE_DOCUMENTS, STORE.PURCHASE_LINES, STORE.SALES_DOCUMENTS,
    STORE.SALES_LINES, STORE.UNRESOLVED_PRODUCTS, STORE.PENDING_INVENTORY_EFFECTS,
    STORE.INVENTORY_MOVEMENTS, STORE.VOUCHER_REVISIONS, STORE.OFFICIAL_COMMANDS, STORE.SYNC_QUEUE]);
  const retryStores = [STORE.UNRESOLVED_PRODUCTS, STORE.PENDING_INVENTORY_EFFECTS,
    STORE.INVENTORY_MOVEMENTS, STORE.VOUCHER_REVISIONS, STORE.OFFICIAL_COMMANDS, STORE.SYNC_QUEUE];
  const countsBeforeRetry = Object.fromEntries(retryStores.map(storeName => [storeName, afterMixed[storeName].length]));
  const retry = await adapter.commitInventoryRematchCommand(mixedCommand);
  const afterRetry = await readStores([STORE.UNRESOLVED_PRODUCTS, STORE.PENDING_INVENTORY_EFFECTS,
    STORE.INVENTORY_MOVEMENTS, STORE.VOUCHER_REVISIONS, STORE.OFFICIAL_COMMANDS, STORE.SYNC_QUEUE]);
  const countsAfterRetry = Object.fromEntries(Object.entries(afterRetry).map(([key, rows]) => [key, rows.length]));
  const nameOnly = await adapter.commitInventoryRematchCommand(commandFor('UP-NAME-ONLY', selectedName));
  const zero = await adapter.commitInventoryRematchCommand(commandFor('UP-ZERO', selectedCode));
  const idempotencyCommand = commandFor('UP-IDEMPOTENCY', selectedCode);
  const idempotencyDb = await openOrderQDb();
  const idempotencyTx = idempotencyDb.transaction(STORE.OFFICIAL_COMMANDS, 'readwrite');
  idempotencyTx.objectStore(STORE.OFFICIAL_COMMANDS).add({
    commandId: 'IRC-COLLISION-BLOCKER', idempotencyKey: idempotencyCommand.idempotencyKey,
    companyId, voucherMode: 'inventory-rematch', documentId: 'UP-OTHER', commandType: 'RESOLVE_INVENTORY_REMATCH',
    status: 'COMMITTED', requestedAt: occurredAt, payloadDigest: 'different', result: {}
  });
  await transactionDone(idempotencyTx);
  const failureCountStores = [STORE.UNRESOLVED_PRODUCTS, STORE.PENDING_INVENTORY_EFFECTS,
    STORE.INVENTORY_MOVEMENTS, STORE.VOUCHER_REVISIONS, STORE.OFFICIAL_COMMANDS, STORE.SYNC_QUEUE];
  const failureCountsBefore = Object.fromEntries(Object.entries(await readStores(failureCountStores))
    .map(([key, rows]) => [key, rows.length]));

  async function capturedError(action) {
    try { await action(); return ''; } catch (error) { return text(error?.message || error); }
  }
  const payloadConflict = await capturedError(() => adapter.commitInventoryRematchCommand({
    ...clone(mixedCommand), selectedProduct: { ...clone(mixedCommand.selectedProduct), productId: 'PRODUCT-SAME-NAME' }
  }));
  const idempotencyCollision = await capturedError(() => adapter.commitInventoryRematchCommand(idempotencyCommand));
  const staleRevisionScenario = scenarios.get('UP-STALE-REV');
  const staleRevision = await capturedError(() => adapter.commitInventoryRematchCommand(commandFor('UP-STALE-REV', selectedCode, {
    expectedDocuments: staleRevisionScenario.expectedDocuments.map(row => ({ ...row, revision: 2 })),
    expectedEffects: staleRevisionScenario.expectedEffects.map(row => ({ ...row, documentRevision: 2 }))
  })));
  const brokenLink = await capturedError(() => adapter.commitInventoryRematchCommand(commandFor('UP-BROKEN', selectedCode)));
  const crossCompanyLink = await capturedError(() => adapter.commitInventoryRematchCommand(commandFor('UP-CROSS-LINK', selectedCode)));
  const damagedOriginalSnapshot = await capturedError(() => adapter.commitInventoryRematchCommand(commandFor('UP-SNAPSHOT-LINK', selectedCode)));
  const partialScenario = scenarios.get('UP-ROLLBACK');
  const partialLinks = await capturedError(() => adapter.commitInventoryRematchCommand(commandFor('UP-ROLLBACK', selectedCode, {
    expectedEffects: [...partialScenario.expectedEffects, { ...partialScenario.expectedEffects[0], pendingEffectId: 'PE-NOT-REAL' }]
  })));
  const crossCompanyAccess = await capturedError(() => adapter.commitInventoryRematchCommand(commandFor('UP-COMPANY-B', selectedCode)));
  const incompleteSource = commandFor('UP-INCOMPLETE', selectedCode);
  const incompleteDecision = await capturedError(() => adapter.commitInventoryRematchCommand(adapter.buildInventoryRematchCommand({
    ...clone(incompleteSource), commandId: '', idempotencyKey: '', commandPayloadDigest: '', stocktakeDecisions: []
  })));
  const cancel = await adapter.commitInventoryRematchCommand({ cancelled: true });
  const rawBypass = await capturedError(() => repository.resolveUnresolvedProductInventory({
    companyId, unresolvedProductId: 'UP-ROLLBACK', productId: 'PRODUCT-CODE'
  }));

  const sourceIntegrityTransactions = [];
  IDBDatabase.prototype.transaction = function(storeNames, mode, ...rest) {
    if (this.name === dbModule.DB_NAME) sourceIntegrityTransactions.push({
      mode: text(mode || 'readonly'), stores: Array.isArray(storeNames) ? [...storeNames] : [storeNames]
    });
    return originalTransaction.call(this, storeNames, mode, ...rest);
  };
  let sourceIntegrityRejects;
  try {
    sourceIntegrityRejects = {
      wrongSign: await capturedError(() => adapter.commitInventoryRematchCommand(commandFor('UP-WRONG-SIGN', selectedCode))),
      wrongQuantity: await capturedError(() => adapter.commitInventoryRematchCommand(commandFor('UP-WRONG-QUANTITY', selectedCode))),
      wrongWarehouse: await capturedError(() => adapter.commitInventoryRematchCommand(commandFor('UP-WRONG-WAREHOUSE', selectedCode))),
      laterDate: await capturedError(() => adapter.commitInventoryRematchCommand(commandFor('UP-LATER-DATE', selectedCode))),
      fabricatedSameDayBusinessOccurredAt: await capturedError(() => adapter.commitInventoryRematchCommand(
        commandFor('UP-FABRICATED-OCCURRED', selectedCode))),
      inactiveLine: await capturedError(() => adapter.commitInventoryRematchCommand(commandFor('UP-INACTIVE-LINE', selectedCode))),
      cancelledLine: await capturedError(() => adapter.commitInventoryRematchCommand(commandFor('UP-CANCELLED-LINE', selectedCode))),
      documentCommandMismatch: await capturedError(() => adapter.commitInventoryRematchCommand(
        commandFor('UP-DOCUMENT-COMMAND', selectedCode))),
      lineCommandMismatch: await capturedError(() => adapter.commitInventoryRematchCommand(
        commandFor('UP-LINE-COMMAND', selectedCode))),
      revisionCommandMismatch: await capturedError(() => adapter.commitInventoryRematchCommand(
        commandFor('UP-REVISION-COMMAND', selectedCode))),
      pendingCommandMismatch: await capturedError(() => adapter.commitInventoryRematchCommand(
        commandFor('UP-PENDING-COMMAND', selectedCode))),
      invalidBusinessDate: await capturedError(() => adapter.commitInventoryRematchCommand(commandFor('UP-INVALID-DATE', selectedCode)))
    };
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
  }
  const validDateCommand = commandFor('UP-ROLLBACK', selectedCode);
  const invalidTimestamps = {
    occurredAt: await capturedError(() => adapter.buildInventoryRematchCommand({
      ...clone(validDateCommand), commandId: '', idempotencyKey: '', commandPayloadDigest: '',
      occurredAt: '2026-02-30T10:01:00+09:00'
    })),
    judgedAt: await capturedError(() => adapter.buildInventoryRematchCommand({
      ...clone(validDateCommand), commandId: '', idempotencyKey: '', commandPayloadDigest: '',
      judgedAt: '2026-02-30T10:00:00+09:00'
    })),
    selectedAt: await capturedError(() => adapter.buildInventoryRematchCommand({
      ...clone(validDateCommand), commandId: '', idempotencyKey: '', commandPayloadDigest: '',
      selectionEvidence: { ...clone(validDateCommand.selectionEvidence), selectedAt: '2026-02-30T10:00:00+09:00' }
    }))
  };

  const staleProductCommand = commandFor('UP-ROLLBACK', selectedCode);
  localStorage.setItem('merchMaster_revision_v870', 'REV-6C-2');
  const retryAfterSnapshotChange = await adapter.commitInventoryRematchCommand(mixedCommand);
  const staleProductSnapshot = await capturedError(() => adapter.commitInventoryRematchCommand(staleProductCommand));
  localStorage.setItem('merchMaster_revision_v870', 'REV-6C-1');
  const failureCountsAfter = Object.fromEntries(Object.entries(await readStores(failureCountStores))
    .map(([key, rows]) => [key, rows.length]));

  const rollbackCommand = commandFor('UP-ROLLBACK', selectedCode);
  const rollbackQueueId = officialCore.voucherStableId('SQRM', rollbackCommand.commandId);
  const rollbackDb = await openOrderQDb();
  const blockerTx = rollbackDb.transaction(STORE.SYNC_QUEUE, 'readwrite');
  blockerTx.objectStore(STORE.SYNC_QUEUE).add({
    queueId: rollbackQueueId, entityType: 'TEST_BLOCKER', entityId: 'TEST-BLOCKER', operation: 'UPSERT',
    revision: 1, payload: {}, status: 'TEST_BLOCKER', attemptCount: 0, createdAt: occurredAt, lastError: ''
  });
  await transactionDone(blockerTx);
  const rollbackBefore = await readStores([STORE.UNRESOLVED_PRODUCTS, STORE.PENDING_INVENTORY_EFFECTS,
    STORE.INVENTORY_MOVEMENTS, STORE.VOUCHER_REVISIONS, STORE.OFFICIAL_COMMANDS, STORE.SYNC_QUEUE]);
  const transactionFailure = await capturedError(() => adapter.commitInventoryRematchCommand(rollbackCommand));
  const rollbackAfter = await readStores([STORE.UNRESOLVED_PRODUCTS, STORE.PENDING_INVENTORY_EFFECTS,
    STORE.INVENTORY_MOVEMENTS, STORE.VOUCHER_REVISIONS, STORE.OFFICIAL_COMMANDS, STORE.SYNC_QUEUE]);

  const afterMixedLines = [...afterMixed[STORE.PURCHASE_LINES], ...afterMixed[STORE.SALES_LINES]]
    .filter(row => row.unresolvedProductId === 'UP-MIXED').map(clone);
  const mixedMovements = afterMixed[STORE.INVENTORY_MOVEMENTS].filter(row => row.commandId === mixedCommand.commandId);
  const mixedEffects = afterMixed[STORE.PENDING_INVENTORY_EFFECTS].filter(row => row.resolutionCommandId === mixedCommand.commandId);
  const mixedAudits = afterMixed[STORE.VOUCHER_REVISIONS].filter(row => row.commandId === mixedCommand.commandId);
  const mixedReceipts = afterMixed[STORE.OFFICIAL_COMMANDS].filter(row => row.commandId === mixedCommand.commandId);
  const mixedQueues = afterMixed[STORE.SYNC_QUEUE].filter(row => row.entityId === mixedCommand.commandId);
  const rollbackInvariant = storeName => {
    const beforeRows = rollbackBefore[storeName].filter(row => text(row.unresolvedProductId) === 'UP-ROLLBACK'
      || text(row.commandId) === rollbackCommand.commandId || text(row.resolutionCommandId) === rollbackCommand.commandId
      || text(row.entityId) === rollbackCommand.commandId || text(row.queueId) === rollbackQueueId);
    const afterRows = rollbackAfter[storeName].filter(row => text(row.unresolvedProductId) === 'UP-ROLLBACK'
      || text(row.commandId) === rollbackCommand.commandId || text(row.resolutionCommandId) === rollbackCommand.commandId
      || text(row.entityId) === rollbackCommand.commandId || text(row.queueId) === rollbackQueueId);
    return JSON.stringify(beforeRows) === JSON.stringify(afterRows);
  };

  return {
    schemaVersion: 'ONEAPP_STAGE6C_BROWSER_EVIDENCE_V1',
    db: { name: dbModule.DB_NAME, version: dbModule.DB_VERSION, newStores: 0 },
    primary: {
      selectedProductId: mixed.productResolution.productId,
      candidateSameNameCount: productRows.filter(row => row.품목명 === '동일 이름' && row.companyId === companyId).length,
      automaticConfirmation: mixed.command.selectionEvidence.automaticConfirmation,
      movements: mixedMovements.map(row => ({ pendingEffectId: row.pendingEffectId, voucherMode: row.voucherMode,
        businessDate: row.businessDate, signedQuantity: row.signedQuantity,
        originalSignedQuantity: row.originalSignedQuantity, status: row.effectStatus,
        stocktakeEffectStatus: row.stocktakeEffectStatus })),
      resolvedEffects: mixedEffects.map(row => ({ pendingEffectId: row.pendingEffectId,
        status: row.inventoryEffectStatus, stocktakeEffectStatus: row.stocktakeEffectStatus,
        officialInventoryApplied: row.officialInventoryApplied })),
      auditRevisions: mixedAudits.length, receipts: mixedReceipts.length, queues: mixedQueues.length,
      readwriteTransactions: commitTransactions.filter(row => row.mode === 'readwrite'),
      queueState: mixedQueues.map(row => ({ entityType: row.entityType, status: row.status })),
      originalLinesAndSnapshotsUnchanged: JSON.stringify(originalMixedLines) === JSON.stringify(afterMixedLines),
      documentsUnchanged: JSON.stringify(before[STORE.PURCHASE_DOCUMENTS]) === JSON.stringify(afterMixed[STORE.PURCHASE_DOCUMENTS])
        && JSON.stringify(before[STORE.SALES_DOCUMENTS]) === JSON.stringify(afterMixed[STORE.SALES_DOCUMENTS])
    },
    nameOnly: { productId: nameOnly.productResolution.productId, movements: nameOnly.inventoryMovements.length },
    zero: {
      movements: zero.inventoryMovements.map(row => ({ businessDate: row.businessDate,
        effectStatus: row.effectStatus, stocktakeEffectStatus: row.stocktakeEffectStatus,
        signedQuantity: row.signedQuantity, originalSignedQuantity: row.originalSignedQuantity,
        officialInventoryApplied: row.officialInventoryApplied })),
      resolvedEffects: zero.resolvedEffects.map(row => ({
        inventoryEffectStatus: row.inventoryEffectStatus, stocktakeEffectStatus: row.stocktakeEffectStatus
      })),
      auditEffects: zero.voucherRevision.effects.map(row => ({
        status: row.status, stocktakeEffectStatus: row.stocktakeEffectStatus
      }))
    },
    retry: { duplicate: retry.duplicate, countsUnchanged: JSON.stringify(countsBeforeRetry) === JSON.stringify(countsAfterRetry),
      afterSnapshotChange: retryAfterSnapshotChange.duplicate },
    rejects: { payloadConflict, idempotencyCollision, staleRevision, staleProductSnapshot, brokenLink, crossCompanyLink, damagedOriginalSnapshot,
      partialLinks, crossCompanyAccess, incompleteDecision, rawBypass, ...sourceIntegrityRejects, invalidTimestamps },
    sourceIntegrityReadwriteTransactions: sourceIntegrityTransactions.filter(row => row.mode === 'readwrite').length,
    cancel,
    rejectedAndCancelWritesZero: JSON.stringify(failureCountsBefore) === JSON.stringify(failureCountsAfter),
    rollback: {
      error: transactionFailure,
      unresolved: rollbackInvariant(STORE.UNRESOLVED_PRODUCTS),
      pending: rollbackInvariant(STORE.PENDING_INVENTORY_EFFECTS),
      movements: rollbackInvariant(STORE.INVENTORY_MOVEMENTS),
      revisions: rollbackInvariant(STORE.VOUCHER_REVISIONS),
      receipts: rollbackInvariant(STORE.OFFICIAL_COMMANDS),
      queue: rollbackInvariant(STORE.SYNC_QUEUE)
    }
  };
}
