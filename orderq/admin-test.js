import {
  STORE, DB_NAME, openOrderQDb, requestToPromise, transactionDone
} from './orderq-db.js?v=0.10.2';
import * as cloud from './orderq-cloud-adapter.js?v=0.10.2';
import * as gateway from './central-command-gateway.js?v=0.10.2';
import * as workbench from './dispatch-workbench-repository.js?v=0.10.2';
import * as confirmation from './dispatch-confirmation-repository.js?v=0.10.2';
import {
  buildDispatchConfirmationKey,
  buildDispatchReversalKey
} from './dispatch-confirmation.js?v=0.10.2';
import { getInventoryShadowProjection } from './inventory-ledger-repository.js?v=0.10.2';
import {
  CUTOVER_MODE, readCutoverControl, setCutoverMode
} from './cutover-control.js?v=0.10.2';
import { runtimeStorageKey, validateAdminTestBuildId } from './admin-test-runtime.js?v=0.10.2';

const CONFIG_KEY = runtimeStorageKey(
  'oneapp.orderq.admin-test.config.unavailable',
  'oneapp.orderq.admin-test.config.v2'
);
const STATE_KEY = runtimeStorageKey(
  'oneapp.orderq.admin-test.state.unavailable',
  'oneapp.orderq.admin-test.state.v1'
);
const TEST_QUANTITY = 2;
const OPENING_QUANTITY = 10;
const TEST_UNIT_PRICE = 5200;

const elements = {
  start: document.querySelector('#startTest'),
  error: document.querySelector('#connectionError'),
  errorText: document.querySelector('#connectionErrorText'),
  workspace: document.querySelector('#workspace'),
  result: document.querySelector('#resultPanel'),
  orderNo: document.querySelector('#orderNo'),
  status: document.querySelector('#businessStatus'),
  stepKicker: document.querySelector('#stepKicker'),
  stepTitle: document.querySelector('#stepTitle'),
  stepDescription: document.querySelector('#stepDescription'),
  quantityField: document.querySelector('#quantityField'),
  actualQuantity: document.querySelector('#actualQuantity'),
  runStep: document.querySelector('#runStep'),
  busy: document.querySelector('#busyText'),
  verify: document.querySelector('#verifyAgain'),
  restart: document.querySelector('#restartTest')
};

const STEP_COPY = Object.freeze({
  1: { title:'주문 확인', description:'TEST 고객의 테스트 양파 1kg 주문수량이 2개인지 확인하세요.', button:'주문 확인 완료', status:'주문 확인' },
  2: { title:'출고 준비', description:'재고 2개를 출고 준비 수량으로 잡습니다. 이때 실제 재고는 아직 줄지 않습니다.', button:'출고 준비', status:'출고 준비 전' },
  3: { title:'실제 출고수량 입력', description:'현장에서 실제로 출고한 수량을 입력합니다. 이번 테스트 값은 2입니다.', button:'실제 수량 저장', status:'출고 준비 완료' },
  4: { title:'출고 확정', description:'판매 기록·재고 차감 기록·주문 처리 결과를 한 번에 확정합니다.', button:'출고 확정', status:'확정 대기' },
  5: { title:'결과 확인', description:'판매·재고·주문 결과와 오류 여부를 확인합니다.', button:'결과 확인', status:'출고 확정' }
});

let config = null;
let state = readState();
let busy = false;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function parseConfig() {
  const hash = text(location.hash).replace(/^#/, '');
  if (hash) {
    try {
      const encoded = hash.startsWith('config=') ? hash.slice(7) : hash;
      const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      const value = JSON.parse(decodeURIComponent(escape(atob(normalized))));
      sessionStorage.setItem(CONFIG_KEY, JSON.stringify(value));
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    } catch {
      throw new Error('테스트 시작 링크가 올바르지 않습니다. 전달받은 TEST 링크를 다시 여세요.');
    }
  }
  const value = JSON.parse(sessionStorage.getItem(CONFIG_KEY) || 'null');
  if (!value) throw new Error('테스트 연결정보가 없습니다. 전달받은 TEST 시작 링크를 다시 여세요.');
  validateAdminTestBuildId(value.buildId);
  const profile = text(new URLSearchParams(location.search).get('profile') || value.profile || 'A').toUpperCase();
  if (!['A', 'B'].includes(profile)) throw new Error('테스트 프로필이 올바르지 않습니다.');
  return { ...value, profile, environmentId:text(value.environmentId || 'admin-test') };
}

function readState() {
  try { return JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null'); }
  catch { return null; }
}

function saveState(next) {
  state = clone(next);
  sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  return state;
}

function idsForRun(runId) {
  const env = config.environmentId.replace(/[^a-z0-9_-]/gi, '-').slice(0, 34);
  const codeSuffix = env.slice(-16).toUpperCase();
  const suffix = `${env}-${runId}`;
  return {
    productId:`OQAT-P-${env}`,
    productCode:`TEST-${codeSuffix}`,
    warehouseId:`OQAT-W-${env}`,
    warehouseCode:`T-${codeSuffix}`,
    snapshotId:`OQAT-IS-${env}`,
    inventoryLineId:`OQAT-IL-${env}`,
    customerId:`OQAT-C-${env}`,
    orderId:`OQAT-O-${suffix}`,
    orderItemId:`OQAT-OI-${suffix}`,
    dispatchId:`OQAT-D-${suffix}`,
    dispatchLineId:`OQAT-DL-${suffix}`,
    allocationId:`OQAT-DA-${suffix}`,
    orderNo:`TEST-${runId}`
  };
}

async function get(storeName, key) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readonly');
  const value = await requestToPromise(tx.objectStore(storeName).get(key));
  await transactionDone(tx);
  return value;
}

async function all(storeName) {
  const db = await openOrderQDb();
  const tx = db.transaction(storeName, 'readonly');
  const value = await requestToPromise(tx.objectStore(storeName).getAll());
  await transactionDone(tx);
  return value;
}

async function countSelected(currentState) {
  const ids = currentState.ids;
  const [documents, lines, movements, events, reservations] = await Promise.all([
    all(STORE.SALES_DOCUMENTS), all(STORE.SALES_LINES), all(STORE.INVENTORY_MOVEMENTS),
    all(STORE.ORDER_EVENTS), all(STORE.INVENTORY_RESERVATIONS)
  ]);
  const salesDocuments = documents.filter(row => text(row.dispatchId) === ids.dispatchId);
  const salesDocumentIds = new Set(salesDocuments.map(row => row.salesDocumentId));
  return {
    salesDocuments,
    salesLines:lines.filter(row => text(row.dispatchLineId) === ids.dispatchLineId || salesDocumentIds.has(row.salesDocumentId)),
    movements:movements.filter(row => text(row.dispatchId) === ids.dispatchId),
    events:events.filter(row => text(row.orderId) === ids.orderId),
    reservations:reservations.filter(row => text(row.dispatchId) === ids.dispatchId)
  };
}

function setLocalPilot() {
  const current = readCutoverControl();
  if (current.mode === CUTOVER_MODE.PILOT_WRITE) return current;
  return setCutoverMode({
    mode:CUTOVER_MODE.PILOT_WRITE,
    actorId:'ADMIN',
    reasonCode:'ADMIN_TEST_ONLY',
    reasonNote:'운영자료와 분리된 관리자 직접 테스트',
    expectedRevision:current.revision
  });
}

function assertWriter() {
  if (config.profile !== 'A') throw new Error('B 확인 화면에서는 테스트 자료를 변경할 수 없습니다.');
}

async function connect() {
  const ping = await cloud.pingCentralAuthority();
  if (config.profile === 'A') setLocalPilot();
  await gateway.pullCentralOfficialState();
  return ping;
}

async function ensureOpening(ids) {
  const [product, warehouse, snapshot, inventoryLine] = await Promise.all([
    get(STORE.PRODUCTS, ids.productId),
    get(STORE.WAREHOUSES, ids.warehouseId),
    get(STORE.INVENTORY_SNAPSHOTS, ids.snapshotId),
    get(STORE.INVENTORY_LINES, ids.inventoryLineId)
  ]);
  if (product && warehouse && snapshot && inventoryLine) return;
  const now = new Date().toISOString();
  const db = await openOrderQDb();
  const stores = [STORE.PRODUCTS, STORE.WAREHOUSES, STORE.INVENTORY_SNAPSHOTS, STORE.INVENTORY_LINES];
  const tx = db.transaction(stores, 'readwrite');
  if (!product) tx.objectStore(STORE.PRODUCTS).add({
    productId:ids.productId, itemCode:ids.productCode, itemName:'테스트 양파 1kg', normalizedName:'테스트양파1kg',
    finalUnit:'개', status:'ACTIVE', revision:1, localOnly:true, adminTest:true, createdAt:now, updatedAt:now
  });
  if (!warehouse) tx.objectStore(STORE.WAREHOUSES).add({
    warehouseId:ids.warehouseId, warehouseCode:ids.warehouseCode, warehouseName:'TEST 전용 창고', normalizedName:'test전용창고',
    countsInOnHand:true, countsInAvailable:true, status:'ACTIVE', revision:1, localOnly:true, adminTest:true, createdAt:now, updatedAt:now
  });
  if (!snapshot) tx.objectStore(STORE.INVENTORY_SNAPSHOTS).add({
    inventorySnapshotId:ids.snapshotId, importBatchId:`OQAT-BATCH-${config.environmentId}`, basisDate:now.slice(0, 10),
    warehouseId:ids.warehouseId, snapshotLastSequence:0, source:'ORDER Q 관리자 TEST', approvedBy:'ADMIN', approvedAt:now,
    status:'ACTIVE', revision:1, localOnly:true, adminTest:true
  });
  if (!inventoryLine) tx.objectStore(STORE.INVENTORY_LINES).add({
    inventoryLineId:ids.inventoryLineId, inventorySnapshotId:ids.snapshotId, importBatchId:`OQAT-BATCH-${config.environmentId}`,
    productId:ids.productId, productCode:ids.productCode, warehouseId:ids.warehouseId, inventoryQuantity:OPENING_QUANTITY,
    status:'ACTIVE', revision:1, localOnly:true, adminTest:true, source:'ORDER Q 관리자 TEST'
  });
  await transactionDone(tx);
}

async function createDraft(currentState) {
  const ids = currentState.ids;
  const now = new Date().toISOString();
  const existing = await get(STORE.DISPATCH_DECISIONS, ids.dispatchId);
  if (existing) return;
  try {
    const db = await openOrderQDb();
    const tx = db.transaction([STORE.CUSTOMERS, STORE.ORDERS, STORE.ORDER_ITEMS], 'readwrite');
    tx.objectStore(STORE.CUSTOMERS).put({
      customerId:ids.customerId, customerName:'TEST 고객', normalizedName:'test고객', status:'ACTIVE', adminTest:true, updatedAt:now
    });
    tx.objectStore(STORE.ORDERS).add({
      orderId:ids.orderId, orderNo:ids.orderNo, customerId:ids.customerId, customerName:'TEST 고객',
      orderDate:now.slice(0, 10), orderStatus:'ORDER', adminStatus:'CHECKED', opsStatus:'ACTIVE',
      revision:1, localOnly:true, adminTest:true, adminTestRunId:currentState.runId
    });
    tx.objectStore(STORE.ORDER_ITEMS).add({
      orderItemId:ids.orderItemId, orderId:ids.orderId, productId:ids.productId, itemCode:ids.productCode, itemName:'테스트 양파 1kg',
      finalQuantity:TEST_QUANTITY, finalUnit:'개', price:TEST_UNIT_PRICE, vatAmount:0, matchStatus:'MATCHED',
      revision:1, localOnly:true, adminTest:true, adminTestRunId:currentState.runId
    });
    await transactionDone(tx);
  } catch (error) {
    throw new Error(`주문 원본 저장 실패: ${error?.message || error}`);
  }
  try { await workbench.saveDispatchDraft({
    decision:{
      dispatchId:ids.dispatchId, dispatchNo:ids.orderNo, orderId:ids.orderId, customerId:ids.customerId, customerName:'TEST 고객',
      businessDate:now.slice(0, 10), status:'DRAFT', adminTest:true, adminTestRunId:currentState.runId
    },
    lines:[{
      dispatchLineId:ids.dispatchLineId, orderId:ids.orderId, orderItemId:ids.orderItemId,
      requestedProductId:ids.productId, requestedProductCode:ids.productCode, requestedProductName:'테스트 양파 1kg',
      actualProductId:ids.productId, actualProductCode:ids.productCode, actualProductName:'테스트 양파 1kg',
      fulfillmentType:'NORMAL', plannedActualQuantity:TEST_QUANTITY, plannedBaseQuantity:TEST_QUANTITY,
      plannedRecognizedOrderQuantity:TEST_QUANTITY, actualUnit:'개', measurementRequired:false,
      unitPriceWon:TEST_UNIT_PRICE, orderAgreedUnitPriceWon:TEST_UNIT_PRICE, priceSource:'ORDER_AGREED'
    }],
    allocations:[{
      allocationId:ids.allocationId, dispatchLineId:ids.dispatchLineId,
      warehouseId:ids.warehouseId, plannedBaseQuantity:TEST_QUANTITY
    }],
    expectedRevision:0
  }, 'ADMIN'); }
  catch (error) { throw new Error(`출고 초안 저장 실패: ${error?.message || error}`); }
}

async function startTest() {
  assertWriter();
  try { await connect(); }
  catch (error) { throw new Error(`TEST 중앙 연결 실패: ${error?.message || error}`); }
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const next = { runId, ids:idsForRun(runId), step:1, startedAt:new Date().toISOString() };
  try { await ensureOpening(next.ids); }
  catch (error) { throw new Error(`TEST 초기재고 준비 실패: ${error?.message || error}`); }
  try { await createDraft(next); }
  catch (error) { throw new Error(`TEST 주문 준비 실패: ${error?.message || error}`); }
  saveState(next);
  render();
}

async function releaseCurrent() {
  assertWriter();
  const aggregate = await workbench.loadDispatchAggregate(state.ids.dispatchId);
  if (aggregate.decision.status !== 'DRAFT') return aggregate;
  return gateway.runCentralOfficialCommand({
    commandType:'RELEASE_DISPATCH', aggregateId:state.ids.dispatchId,
    expectedRevision:aggregate.decision.revision,
    idempotencyKey:`ADMIN_TEST:RELEASE:${state.ids.dispatchId}:${aggregate.decision.revision}`,
    intent:{ adminTest:true }
  }, () => workbench.releaseDispatch(state.ids.dispatchId, aggregate.decision.revision, 'ADMIN'));
}

async function recordActual() {
  assertWriter();
  const quantity = Number(elements.actualQuantity.value);
  if (!Number.isFinite(quantity) || quantity !== TEST_QUANTITY) {
    throw new Error('이번 테스트의 실제 출고수량은 2를 입력해 주세요.');
  }
  const aggregate = await workbench.loadDispatchAggregate(state.ids.dispatchId);
  if (['READY_TO_CONFIRM', 'CONFIRMED'].includes(aggregate.decision.status)) return aggregate;
  const command = {
    dispatchId:state.ids.dispatchId,
    expectedRevision:aggregate.decision.revision,
    lines:[{
      dispatchLineId:state.ids.dispatchLineId,
      actualQuantity:quantity,
      recognizedOrderQuantity:quantity,
      allocations:[{ allocationId:state.ids.allocationId, actualBaseQuantity:quantity }]
    }]
  };
  return gateway.runCentralOfficialCommand({
    commandType:'UPDATE_DISPATCH', aggregateId:state.ids.dispatchId,
    expectedRevision:command.expectedRevision,
    idempotencyKey:`ADMIN_TEST:ACTUAL:${state.ids.dispatchId}:${command.expectedRevision}`,
    intent:command.lines
  }, () => confirmation.recordDispatchActual(command, 'ADMIN'));
}

async function confirmCurrent() {
  assertWriter();
  const aggregate = await workbench.loadDispatchAggregate(state.ids.dispatchId);
  if (aggregate.decision.status === 'CONFIRMED') return aggregate;
  if (aggregate.decision.status !== 'READY_TO_CONFIRM') throw new Error('실제 출고수량을 먼저 저장해 주세요.');
  const command = {
    dispatchId:state.ids.dispatchId,
    expectedRevision:aggregate.decision.revision,
    idempotencyKey:buildDispatchConfirmationKey(state.ids.dispatchId, aggregate.decision.revision)
  };
  const result = await gateway.runCentralOfficialCommand({
    commandType:'CONFIRM_DISPATCH', aggregateId:state.ids.dispatchId,
    expectedRevision:command.expectedRevision, idempotencyKey:command.idempotencyKey,
    intent:{ adminTest:true, quantity:TEST_QUANTITY }
  }, () => confirmation.confirmDispatch(command, 'ADMIN'));
  saveState({ ...state, confirmCommand:command });
  return result;
}

async function verifyResult() {
  await gateway.pullCentralOfficialState();
  const selected = await countSelected(state);
  const projection = await getInventoryShadowProjection();
  const stock = projection.rows.find(row => text(row.productId) === state.ids.productId && text(row.warehouseId) === state.ids.warehouseId);
  const saleQuantity = selected.salesLines.reduce((sum, row) => sum + Number(row.actualQuantity ?? row.quantity ?? 0), 0);
  const movementQuantity = selected.movements.filter(row => text(row.movementType) === 'SALE_ISSUE')
    .reduce((sum, row) => sum + Number(row.signedBaseQuantity || 0), 0);
  const fulfillmentQuantity = selected.events.filter(row => text(row.eventType) === 'SALES_TRANSFER_ALLOCATED')
    .reduce((sum, row) => sum + Number(row.detail?.transferredQty || 0), 0);
  const consumed = selected.reservations.filter(row => text(row.status) === 'CONSUMED');
  if (selected.salesDocuments.length !== 1 || selected.salesLines.length !== 1 || saleQuantity !== TEST_QUANTITY) throw new Error('판매 기록이 기대값과 다릅니다.');
  if (movementQuantity !== -TEST_QUANTITY || Number(stock?.onHandQuantity) !== OPENING_QUANTITY - TEST_QUANTITY) throw new Error('재고 차감 기록이 기대값과 다릅니다.');
  if (fulfillmentQuantity !== TEST_QUANTITY) throw new Error('주문 처리 결과가 기대값과 다릅니다.');
  if (consumed.length !== 1 || Number(consumed[0].consumedBaseQuantity) !== TEST_QUANTITY) throw new Error('출고 준비 수량 처리 결과가 다릅니다.');
  const diagnostics = Array.isArray(globalThis.__ORDERQ_ADMIN_TEST_DIAGNOSTICS__)
    ? globalThis.__ORDERQ_ADMIN_TEST_DIAGNOSTICS__
    : [];
  if (diagnostics.length) throw new Error(`화면 오류가 ${diagnostics.length}건 감지됐습니다.`);

  let retryDuplicate = false;
  if (state.confirmCommand && !state.retryVerified) {
    const before = await countSelected(state);
    let callbackRan = false;
    const retried = await gateway.runCentralOfficialCommand({
      commandType:'CONFIRM_DISPATCH', aggregateId:state.ids.dispatchId,
      expectedRevision:state.confirmCommand.expectedRevision,
      idempotencyKey:state.confirmCommand.idempotencyKey,
      intent:{ adminTest:true, quantity:TEST_QUANTITY }
    }, () => { callbackRan = true; throw new Error('재시도에서 로컬 작업이 실행되면 안 됩니다.'); });
    const after = await countSelected(state);
    retryDuplicate = Boolean(retried.duplicate) && !callbackRan
      && before.salesDocuments.length === after.salesDocuments.length
      && before.salesLines.length === after.salesLines.length
      && before.movements.length === after.movements.length
      && before.events.length === after.events.length;
    if (!retryDuplicate) throw new Error('같은 출고확정 재시도에서 중복이 감지됐습니다.');
    saveState({ ...state, retryVerified:true });
  } else retryDuplicate = true;

  const result = {
    salesQuantity:saleQuantity,
    openingQuantity:OPENING_QUANTITY,
    onHandQuantity:Number(stock.onHandQuantity),
    movementQuantity,
    fulfillmentQuantity,
    retryDuplicates:retryDuplicate ? 0 : 1,
    diagnosticCount:diagnostics.length,
    verifiedAt:new Date().toISOString(),
    dbName:DB_NAME,
    environmentId:config.environmentId
  };
  saveState({ ...state, step:5, result });
  render();
  return result;
}

async function reverseCurrentIfNeeded() {
  assertWriter();
  if (!state?.ids?.dispatchId) return;
  await connect();
  const aggregate = await workbench.loadDispatchAggregate(state.ids.dispatchId).catch(() => null);
  if (!aggregate?.decision) return;
  if (['RELEASED', 'READY_TO_CONFIRM'].includes(aggregate.decision.status)) {
    await gateway.runCentralOfficialCommand({
      commandType:'RECALL_DISPATCH', aggregateId:state.ids.dispatchId,
      expectedRevision:aggregate.decision.revision,
      idempotencyKey:`ADMIN_TEST:RECALL:${state.ids.dispatchId}:${aggregate.decision.revision}`,
      intent:{ adminTest:true, reason:'테스트 다시 시작' }
    }, () => workbench.recallDispatch(state.ids.dispatchId, aggregate.decision.revision, 'ADMIN'));
  } else if (aggregate.decision.status === 'CONFIRMED') {
    const command = {
      dispatchId:state.ids.dispatchId,
      expectedRevision:aggregate.decision.revision,
      idempotencyKey:buildDispatchReversalKey(state.ids.dispatchId, aggregate.decision.revision, 'ADMIN-TEST-RESTART'),
      reason:'관리자 TEST 다시 시작'
    };
    await gateway.runCentralOfficialCommand({
      commandType:'REVERSE_DISPATCH', aggregateId:state.ids.dispatchId,
      expectedRevision:command.expectedRevision, idempotencyKey:command.idempotencyKey,
      intent:{ adminTest:true, reason:command.reason }
    }, () => confirmation.reverseDispatch(command, 'ADMIN'));
  }
}

async function restartTest() {
  await reverseCurrentIfNeeded();
  sessionStorage.removeItem(STATE_KEY);
  state = null;
  elements.result.hidden = true;
  await startTest();
}

async function runCurrentStep() {
  if (!state) return startTest();
  if (state.step === 1) saveState({ ...state, step:2 });
  else if (state.step === 2) { await releaseCurrent(); saveState({ ...state, step:3 }); }
  else if (state.step === 3) { await recordActual(); saveState({ ...state, step:4 }); }
  else if (state.step === 4) { await confirmCurrent(); await verifyResult(); }
  else if (state.step === 5) await verifyResult();
  render();
}

function render() {
  const hasState = Boolean(state?.ids);
  elements.workspace.hidden = !hasState;
  elements.start.hidden = hasState;
  elements.result.hidden = !hasState || state.step !== 5;
  document.querySelectorAll('.step').forEach(button => {
    const number = Number(button.dataset.step);
    button.classList.toggle('active', hasState && number === state.step);
    button.classList.toggle('complete', hasState && number < state.step);
  });
  if (!hasState) return;
  const step = STEP_COPY[state.step] || STEP_COPY[1];
  elements.orderNo.textContent = state.ids.orderNo;
  elements.status.textContent = step.status;
  elements.stepKicker.textContent = `${state.step}단계`;
  elements.stepTitle.textContent = step.title;
  elements.stepDescription.textContent = step.description;
  elements.runStep.textContent = step.button;
  elements.quantityField.hidden = state.step !== 3;
  if (state.step === 5) elements.runStep.hidden = true;
  else elements.runStep.hidden = false;
  if (state.result) {
    document.querySelector('#salesDetail').textContent = `${state.result.salesQuantity}개`;
    document.querySelector('#inventoryResult').textContent = `${state.result.openingQuantity} → ${state.result.onHandQuantity}`;
    document.querySelector('#movementDetail').textContent = `재고 차감 기록 ${state.result.movementQuantity}`;
    document.querySelector('#fulfillmentDetail').textContent = `주문 처리 결과 ${state.result.fulfillmentQuantity}/${TEST_QUANTITY}`;
    document.querySelector('#retryDetail').textContent = `재시도 중복 ${state.result.retryDuplicates}건`;
  }
}

async function guarded(operation) {
  if (busy) return;
  busy = true;
  elements.error.hidden = true;
  elements.busy.hidden = false;
  [elements.start, elements.runStep, elements.verify, elements.restart].forEach(button => { if (button) button.disabled = true; });
  try { await operation(); }
  catch (error) {
    elements.errorText.textContent = error?.message || String(error);
    elements.error.hidden = false;
    throw error;
  } finally {
    busy = false;
    elements.busy.hidden = true;
    [elements.start, elements.runStep, elements.verify, elements.restart].forEach(button => { if (button) button.disabled = false; });
  }
}

elements.start.addEventListener('click', () => guarded(startTest).catch(() => {}));
elements.runStep.addEventListener('click', () => guarded(runCurrentStep).catch(() => {}));
elements.verify.addEventListener('click', () => guarded(verifyResult).catch(() => {}));
elements.restart.addEventListener('click', () => guarded(restartTest).catch(() => {}));

try {
  config = parseConfig();
  const expectedDbPrefix = `oneapp-orderq-admin-test-`;
  if (!DB_NAME.startsWith(expectedDbPrefix)) throw new Error('운영자료와 분리된 TEST 저장공간이 아닙니다.');
  render();
  if (config.profile === 'B' && config.observeRun?.ids) {
    saveState({ ...clone(config.observeRun), step:5, retryVerified:true });
    guarded(async () => { await connect(); await verifyResult(); }).catch(() => {});
  }
} catch (error) {
  elements.start.disabled = true;
  elements.errorText.textContent = error?.message || String(error);
  elements.error.hidden = false;
}
