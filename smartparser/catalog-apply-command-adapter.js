import { cloneJson, deepFreeze, sha256Hex, stableStringify } from '../reference-data/change-request-contract.js';
import { buildProductSnapshot } from '../reference-data/product-master-read-adapter.js';
import { validateSmartParserAnalysisResult } from './analysis-result-contract.js';

export const SMARTPARSER_CATALOG_APPLY_ADAPTER_VERSION = 'ONEAPP_SMARTPARSER_CATALOG_APPLY_COMMAND_ADAPTER_V1';
export const SMARTPARSER_CATALOG_APPLY_COMMAND_SCHEMA_VERSION = 'ONEAPP_SMARTPARSER_CATALOG_APPLY_COMMAND_V1';
export const SMARTPARSER_CATALOG_APPLY_ACTIONS = Object.freeze(['APPLY_ANALYSIS', 'EXCLUDE_CATALOG']);
export const SMARTPARSER_CATALOG_STOP_REASONS = Object.freeze(['품절', '공급중단', '판매종료']);

const STOPPED_KEY = 'merchStoppedProducts_v2';
const PENDING_KEY = 'pending_shop_status';
const HISTORY_KEY = 'merchHistory_v870';
const LOCAL_PENDING_KEY = 'pendingShopStatus';
const MASTER_NOTIFICATION_KEY = 'merchMaster_sync_trigger';
const STOP_NOTIFICATION_KEY = 'merchStopManager_sync_trigger';
const ALLOWED_FIELDS = new Set(['코드', '품목명', '규격', '단위', '입고가', '출고가', '시중가', '1입고', '1출고', '카탈로그']);

const clean = (value) => String(value ?? '').trim();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const sameValue = (left, right) => stableStringify(left ?? '') === stableStringify(right ?? '');

export function normalizeSmartParserCatalogProductCode(value) {
  return clean(value).normalize('NFKC').replace(/[\s-]+/g, '').toUpperCase();
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return cloneJson(fallback);
  try { return JSON.parse(value); } catch { return cloneJson(fallback); }
}

function catalogTokens(value) {
  return clean(value).split(',').map(clean).filter(Boolean);
}

function removesOnlyCatalog(beforeValue, afterValue, catalog) {
  const before = catalogTokens(beforeValue);
  const after = catalogTokens(afterValue);
  const expected = before.filter((tag) => tag !== catalog);
  return before.includes(catalog) && stableStringify(after) === stableStringify(expected);
}

function normalizeStoppedProducts(input = {}) {
  const result = {};
  const entries = Array.isArray(input)
    ? input.map((item) => [item?.productCode || item?.코드 || '', item])
    : Object.entries(input && typeof input === 'object' ? input : {});
  entries.forEach(([rawCode, rawItem]) => {
    const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const code = normalizeSmartParserCatalogProductCode(item.productCode || item.코드 || rawCode);
    if (code) result[code] = { ...cloneJson(item), productCode: code };
  });
  return result;
}

function normalizePendingStatus(input = []) {
  const byCode = new Map();
  (Array.isArray(input) ? input : []).forEach((rawItem) => {
    const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const code = normalizeSmartParserCatalogProductCode(item.code || item.productCode || item.코드);
    if (code) byCode.set(code, { ...cloneJson(item), code });
  });
  return [...byCode.values()];
}

function result(status, command, extra = {}) {
  const ok = status === 'APPLIED' || status === 'DUPLICATE';
  return deepFreeze({
    adapterVersion: SMARTPARSER_CATALOG_APPLY_ADAPTER_VERSION,
    schemaVersion: SMARTPARSER_CATALOG_APPLY_COMMAND_SCHEMA_VERSION,
    ok,
    accepted: ok,
    completed: ok,
    status,
    operationId: clean(command?.operationId),
    ...cloneJson(extra),
  });
}

export function createSmartParserCatalogApplyCommand(analysisResult, options = {}) {
  const validation = validateSmartParserAnalysisResult(analysisResult);
  if (!validation.valid) {
    const error = new Error('SMARTPARSER_ANALYSIS_RESULT_NOT_APPLICABLE');
    error.validation = validation;
    throw error;
  }
  const action = clean(options.action || 'APPLY_ANALYSIS').toUpperCase();
  const catalog = clean(analysisResult.sourceMetadata?.catalog);
  const items = analysisResult.rows.filter((row) => (
    row.decision.selected
    && !row.decision.excluded
    && !row.decision.blocked
    && row.proposedChanges.length > 0
  )).map((row) => ({
    rowId: row.rowId,
    code: row.match.productCode,
    normalizedCode: normalizeSmartParserCatalogProductCode(row.match.normalizedProductCode || row.match.productCode),
    isNewProduct: row.match.isNewProduct === true,
    changes: row.proposedChanges.map((change) => ({
      field: change.field,
      beforeValue: cloneJson(change.beforeValue),
      afterValue: cloneJson(change.proposedValue),
      reason: clean(change.reason),
    })),
  }));
  return deepFreeze({
    schemaVersion: SMARTPARSER_CATALOG_APPLY_COMMAND_SCHEMA_VERSION,
    operationId: clean(options.operationId),
    action,
    analysisId: clean(analysisResult.analysisId),
    expectedSnapshotId: clean(analysisResult.baseProductSnapshot?.snapshotId),
    expectedRevision: clean(analysisResult.baseProductSnapshot?.revision),
    requestedAt: clean(options.requestedAt || analysisResult.createdAt),
    actor: cloneJson(options.actor && typeof options.actor === 'object' ? options.actor : { actorState: 'UNVERIFIED_LOCAL' }),
    catalog,
    stop: {
      enabled: options.applyStop === true,
      reason: options.applyStop === true ? clean(options.stopReason) : '',
    },
    items,
  });
}

function validateCommand(command) {
  const errors = [];
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    return deepFreeze({ valid: false, errors: [{ code: 'COMMAND_OBJECT_REQUIRED', path: '' }] });
  }
  if (command.schemaVersion !== SMARTPARSER_CATALOG_APPLY_COMMAND_SCHEMA_VERSION) errors.push({ code: 'SCHEMA_VERSION_INVALID', path: 'schemaVersion' });
  ['operationId', 'analysisId', 'expectedSnapshotId', 'requestedAt', 'catalog'].forEach((field) => {
    if (!clean(command[field])) errors.push({ code: 'REQUIRED_FIELD_MISSING', path: field });
  });
  if (!hasOwn(command, 'expectedRevision') || !clean(command.expectedRevision)) errors.push({ code: 'EXPECTED_REVISION_REQUIRED', path: 'expectedRevision' });
  const action = clean(command.action).toUpperCase();
  if (!SMARTPARSER_CATALOG_APPLY_ACTIONS.includes(action)) errors.push({ code: 'ACTION_INVALID', path: 'action' });
  if (!command.actor || typeof command.actor !== 'object' || !clean(command.actor.actorState)) errors.push({ code: 'ACTOR_STATE_REQUIRED', path: 'actor.actorState' });
  const stopEnabled = command.stop?.enabled === true;
  if (stopEnabled && action !== 'EXCLUDE_CATALOG') errors.push({ code: 'STOP_ONLY_ALLOWED_WITH_EXCLUSION', path: 'stop.enabled' });
  if (stopEnabled && !SMARTPARSER_CATALOG_STOP_REASONS.includes(clean(command.stop?.reason))) errors.push({ code: 'STOP_REASON_INVALID', path: 'stop.reason' });
  const items = Array.isArray(command.items) ? command.items : [];
  if (items.length === 0) errors.push({ code: 'ITEMS_REQUIRED', path: 'items' });
  const seenCodes = new Set();
  items.forEach((item, index) => {
    const itemPath = `items[${index}]`;
    const code = normalizeSmartParserCatalogProductCode(item?.normalizedCode || item?.code);
    if (!clean(item?.rowId)) errors.push({ code: 'ROW_ID_REQUIRED', path: `${itemPath}.rowId` });
    if (!code) errors.push({ code: 'ITEM_CODE_REQUIRED', path: `${itemPath}.code` });
    else if (seenCodes.has(code)) errors.push({ code: 'DUPLICATE_ITEM_CODE', path: `${itemPath}.code` });
    seenCodes.add(code);
    const changes = Array.isArray(item?.changes) ? item.changes : [];
    if (changes.length === 0) errors.push({ code: 'CHANGES_REQUIRED', path: `${itemPath}.changes` });
    const fields = new Set();
    changes.forEach((change, changeIndex) => {
      const changePath = `${itemPath}.changes[${changeIndex}]`;
      const field = clean(change?.field);
      if (!ALLOWED_FIELDS.has(field)) errors.push({ code: 'FIELD_NOT_ALLOWED', path: `${changePath}.field` });
      if (fields.has(field)) errors.push({ code: 'DUPLICATE_FIELD', path: `${changePath}.field` });
      fields.add(field);
      if (!hasOwn(change, 'beforeValue')) errors.push({ code: 'BEFORE_VALUE_REQUIRED', path: `${changePath}.beforeValue` });
      if (!hasOwn(change, 'afterValue')) errors.push({ code: 'AFTER_VALUE_REQUIRED', path: `${changePath}.afterValue` });
      if (hasOwn(change, 'beforeValue') && hasOwn(change, 'afterValue') && sameValue(change.beforeValue, change.afterValue)) errors.push({ code: 'NO_EFFECT_CHANGE', path: changePath });
      if (action === 'EXCLUDE_CATALOG' && field !== '카탈로그') errors.push({ code: 'EXCLUSION_FIELD_NOT_ALLOWED', path: `${changePath}.field` });
      if (action === 'EXCLUDE_CATALOG' && field === '카탈로그' && !removesOnlyCatalog(change.beforeValue, change.afterValue, clean(command.catalog))) {
        errors.push({ code: 'CATALOG_REMOVAL_SCOPE_INVALID', path: changePath });
      }
    });
    if (action === 'EXCLUDE_CATALOG' && item?.isNewProduct === true) errors.push({ code: 'EXCLUSION_CREATE_NOT_ALLOWED', path: `${itemPath}.isNewProduct` });
    if (item?.isNewProduct !== true && fields.has('코드')) errors.push({ code: 'EXISTING_CODE_CHANGE_NOT_ALLOWED', path: `${itemPath}.changes` });
  });
  return deepFreeze({ valid: errors.length === 0, errors });
}

function masterMapFromState(state) {
  const map = {};
  (Array.isArray(state?.items) ? state.items : []).forEach((item) => {
    const code = clean(item?.코드 || item?.품목코드);
    if (code) map[code] = cloneJson(item);
  });
  if (Object.keys(map).length === 0 && state?.snapshot && typeof state.snapshot === 'object' && !Array.isArray(state.snapshot)) {
    Object.entries(state.snapshot).forEach(([key, item]) => {
      const code = clean(item?.코드 || item?.품목코드 || key);
      if (code) map[code] = cloneJson(item);
    });
  }
  return map;
}

function findProduct(master, normalizedCode) {
  const matches = Object.entries(master).filter(([key, item]) => (
    normalizeSmartParserCatalogProductCode(item?.코드 || item?.품목코드 || key) === normalizedCode
  ));
  if (matches.length > 1) throw new Error(`DUPLICATE_MASTER_PRODUCT_CODE:${normalizedCode}`);
  return matches.length === 0 ? null : { key: matches[0][0], item: matches[0][1] };
}

function verifyCommandOutcome(master, command, stopped = {}) {
  for (const item of command.items) {
    const code = normalizeSmartParserCatalogProductCode(item.normalizedCode || item.code);
    const resolved = findProduct(master, code);
    if (!resolved) return false;
    if (item.changes.some((change) => !sameValue(resolved.item?.[change.field], change.afterValue))) return false;
    if (command.stop?.enabled === true && (Number(resolved.item?.판매여부) !== 0 || clean(stopped[code]?.reason) !== clean(command.stop.reason))) return false;
  }
  return true;
}

function writeVerifiedLocalStorage(entries) {
  Object.entries(entries).forEach(([key, value]) => {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    globalThis.localStorage.setItem(key, serialized);
    if (globalThis.localStorage.getItem(key) !== serialized) throw new Error(`LOCAL_MIRROR_VERIFY_FAILED:${key}`);
  });
}

function restoreLocalStorage(previous) {
  Object.entries(previous).forEach(([key, value]) => {
    if (value === null) globalThis.localStorage.removeItem(key);
    else globalThis.localStorage.setItem(key, value);
  });
}

function makeHistoryEntry({ command, commandHash, item, product, change, suffix = '' }) {
  const actionType = command.action === 'EXCLUDE_CATALOG' ? 'smartparser_catalog_exclude' : 'smartparser_catalog_apply';
  return {
    id: `${command.operationId}:${item.rowId}:${suffix || change.field}`,
    operationId: command.operationId,
    commandHash,
    source: 'parser',
    sourceLabel: '스마트 파서',
    sourceRole: 'smart-parser',
    actionType,
    historyType: command.action === 'EXCLUDE_CATALOG' ? '카탈로그 제외' : (item.isNewProduct ? '상품등록' : '카탈로그 업데이트'),
    changeType: command.action === 'EXCLUDE_CATALOG' ? '카탈로그 제외' : (item.isNewProduct ? '상품등록' : '상품정보 변경'),
    route: command.action === 'EXCLUDE_CATALOG' ? '파서/카탈로그제외/즉시적용' : '파서/분석결과/즉시적용',
    path: command.action === 'EXCLUDE_CATALOG' ? 'SmartParser > 카탈로그 제외 > 즉시 적용' : 'SmartParser > 분석결과 > 관리자 확정 즉시 적용',
    code: clean(product?.코드 || item.code),
    name: clean(product?.품목명),
    spec: clean(product?.규격),
    unit: clean(product?.단위),
    field: change.field,
    oldVal: cloneJson(change.beforeValue),
    newVal: cloneJson(change.afterValue),
    timestampISO: command.requestedAt,
    actor: cloneJson(command.actor),
    reason: clean(change.reason),
    catalogName: command.catalog,
    catalog: command.catalog,
    analysisId: command.analysisId,
    version: SMARTPARSER_CATALOG_APPLY_COMMAND_SCHEMA_VERSION,
  };
}

export async function commitSmartParserCatalogApply(command, options = {}) {
  const validation = validateCommand(command);
  if (!validation.valid) return result('REJECTED', command, { validation });

  const storage = options.storage || globalThis.ONEAPP?.STORAGE;
  if (!storage?.readMasterState || !storage?.commitMasterStateOrThrow || !globalThis.localStorage) {
    return result('NOT_AVAILABLE', command, { error: { code: 'CATALOG_APPLY_STORAGE_NOT_AVAILABLE', retryable: true } });
  }

  const commandHash = await sha256Hex(command);
  const history = parseJson(globalThis.localStorage.getItem(HISTORY_KEY), []);
  const duplicateLogs = (Array.isArray(history) ? history : []).filter((entry) => entry?.operationId === command.operationId);
  if (duplicateLogs.length > 0) {
    const samePayload = duplicateLogs.every((entry) => entry.commandHash === commandHash);
    if (!samePayload) return result('CONFLICT', command, { error: { code: 'OPERATION_ID_CONFLICT', retryable: false } });
    try {
      const duplicateState = await storage.readMasterState([STOPPED_KEY]);
      const duplicateMaster = masterMapFromState(duplicateState);
      const duplicateStopped = normalizeStoppedProducts(duplicateState.extraStoreEntries?.[STOPPED_KEY] ?? parseJson(globalThis.localStorage.getItem(STOPPED_KEY), {}));
      if (!verifyCommandOutcome(duplicateMaster, command, duplicateStopped)) {
        return result('CONFLICT', command, { error: { code: 'DUPLICATE_STATE_MISMATCH', retryable: false } });
      }
      const duplicateSnapshot = await buildProductSnapshot({
        recordRows: Object.values(duplicateMaster),
        storeSnapshot: duplicateMaster,
        revision: duplicateState.revision,
      }, { now: command.requestedAt });
      return result('DUPLICATE', command, {
        revision: duplicateState.revision ?? null,
        snapshotId: duplicateSnapshot.snapshotId,
        snapshotVersion: duplicateSnapshot.snapshotVersion,
        contentHash: duplicateSnapshot.contentHash,
        processedCodes: command.items.map((item) => normalizeSmartParserCatalogProductCode(item.normalizedCode || item.code)),
        stopAppliedCount: command.stop?.enabled === true ? command.items.length : 0,
        appliedAt: command.requestedAt,
      });
    } catch (error) {
      return result('ERROR', command, { error: { code: clean(error?.message) || 'DUPLICATE_STATE_READ_FAILED', retryable: true } });
    }
  }

  let state;
  try {
    state = await storage.readMasterState([STOPPED_KEY, PENDING_KEY]);
  } catch (error) {
    return result('ERROR', command, { error: { code: clean(error?.message) || 'CATALOG_APPLY_STATE_READ_FAILED', retryable: true } });
  }
  const currentSnapshot = await buildProductSnapshot({
    recordRows: Array.isArray(state.items) ? state.items : [],
    storeSnapshot: state.snapshot,
    revision: state.revision,
  }, { now: command.requestedAt });
  if (currentSnapshot.snapshotId !== command.expectedSnapshotId) {
    return result('CONFLICT', command, {
      error: { code: 'PRODUCT_SNAPSHOT_CONFLICT', retryable: false },
      currentSnapshotId: currentSnapshot.snapshotId,
      currentRevision: state.revision ?? null,
    });
  }
  if (String(state.revision ?? '') !== String(command.expectedRevision ?? '')) {
    return result('CONFLICT', command, { error: { code: 'PRODUCT_REVISION_CONFLICT', retryable: false }, currentRevision: state.revision ?? null });
  }

  const master = masterMapFromState(state);
  const nextStopped = normalizeStoppedProducts(state.extraStoreEntries?.[STOPPED_KEY] ?? parseJson(globalThis.localStorage.getItem(STOPPED_KEY), {}));
  let nextPending = normalizePendingStatus(state.extraStoreEntries?.[PENDING_KEY] ?? parseJson(globalThis.localStorage.getItem(LOCAL_PENDING_KEY), []));
  const logs = [];
  const processedCodes = [];

  try {
    for (const item of command.items) {
      const code = normalizeSmartParserCatalogProductCode(item.normalizedCode || item.code);
      let resolved = findProduct(master, code);
      if (item.isNewProduct === true) {
        if (resolved) throw new Error(`MASTER_PRODUCT_ALREADY_EXISTS:${code}`);
        const masterKey = clean(item.code);
        master[masterKey] = {};
        resolved = { key: masterKey, item: master[masterKey] };
      } else if (!resolved) {
        throw new Error(`MASTER_PRODUCT_NOT_FOUND:${code}`);
      }
      let nextProduct = cloneJson(resolved.item);
      for (const change of item.changes) {
        const currentValue = hasOwn(nextProduct, change.field) ? nextProduct[change.field] : '';
        if (!sameValue(currentValue, change.beforeValue)) throw new Error(`PRODUCT_BEFORE_STATE_CONFLICT:${code}:${change.field}`);
        nextProduct[change.field] = cloneJson(change.afterValue);
        logs.push(makeHistoryEntry({ command, commandHash, item, product: nextProduct, change }));
      }
      if (command.stop?.enabled === true) {
        const beforeSaleStatus = hasOwn(nextProduct, '판매여부') ? nextProduct.판매여부 : '';
        nextProduct.판매여부 = 0;
        const beforeStopped = nextStopped[code] || {};
        nextStopped[code] = {
          ...beforeStopped,
          productCode: code,
          name: clean(nextProduct.품목명),
          stoppedAt: beforeStopped.stoppedAt || command.requestedAt,
          updatedAt: command.requestedAt,
          reason: command.stop.reason,
          memo: clean(beforeStopped.memo),
          source: 'SmartParser',
          status: 'stopped',
          pendingAction: '',
        };
        const pendingEntry = {
          code,
          type: 'stop',
          name: clean(nextProduct.품목명),
          source: 'SmartParser',
          reason: command.stop.reason,
          updatedAt: command.requestedAt,
        };
        const pendingIndex = nextPending.findIndex((entry) => normalizeSmartParserCatalogProductCode(entry.code) === code);
        if (pendingIndex >= 0) nextPending[pendingIndex] = pendingEntry;
        else nextPending.push(pendingEntry);
        logs.push(makeHistoryEntry({
          command,
          commandHash,
          item,
          product: nextProduct,
          suffix: 'sale-stop',
          change: { field: '판매여부', beforeValue: beforeSaleStatus, afterValue: 0, reason: `카탈로그 제외와 판매정지 함께 적용: ${command.stop.reason}` },
        }));
        logs[logs.length - 1].actionType = 'smartparser_catalog_exclude_stop';
        logs[logs.length - 1].historyType = '판매정지';
        logs[logs.length - 1].changeType = '판매정지';
      }
      master[resolved.key] = nextProduct;
      processedCodes.push(code);
    }
  } catch (error) {
    return result('CONFLICT', command, { error: { code: clean(error?.message) || 'CATALOG_APPLY_CONFLICT', retryable: false } });
  }

  if (processedCodes.length === 0 || logs.length === 0) return result('REJECTED', command, { error: { code: 'NO_EFFECTIVE_TARGETS', retryable: false } });
  const nextHistory = [...logs, ...(Array.isArray(history) ? history : [])].slice(0, 5000);
  const stopEnabled = command.stop?.enabled === true;
  const localWrites = {
    [HISTORY_KEY]: nextHistory,
    [MASTER_NOTIFICATION_KEY]: command.requestedAt,
    ...(stopEnabled ? {
      [STOPPED_KEY]: nextStopped,
      [LOCAL_PENDING_KEY]: nextPending,
      [STOP_NOTIFICATION_KEY]: command.requestedAt,
    } : {}),
  };
  const previousLocal = Object.fromEntries(Object.keys(localWrites).map((key) => [key, globalThis.localStorage.getItem(key)]));

  try {
    const commitResult = await storage.commitMasterStateOrThrow(master, {
      expectedRevision: state.revision,
      ...(stopEnabled ? { extraStoreEntries: { [STOPPED_KEY]: nextStopped, [PENDING_KEY]: nextPending } } : {}),
      afterVerified: () => {
        writeVerifiedLocalStorage(localWrites);
        return true;
      },
      afterVerifiedError: 'SmartParser catalog apply linked-state verification failed',
    });
    const committedSnapshot = await buildProductSnapshot({
      recordRows: Object.values(master),
      storeSnapshot: master,
      revision: commitResult.revision,
    }, { now: command.requestedAt });
    return result('APPLIED', command, {
      revision: commitResult.revision,
      snapshotId: committedSnapshot.snapshotId,
      snapshotVersion: committedSnapshot.snapshotVersion,
      contentHash: committedSnapshot.contentHash,
      processedCodes,
      historyCount: logs.length,
      stopAppliedCount: stopEnabled ? processedCodes.length : 0,
      appliedAt: command.requestedAt,
      rollback: { attempted: false, restored: false, staleSkipped: false },
    });
  } catch (error) {
    let localRollbackError = null;
    try { restoreLocalStorage(previousLocal); } catch (restoreError) { localRollbackError = restoreError; }
    const coreResult = error?.result || {};
    return result(error?.code === 'MERCH_MASTER_REVISION_CONFLICT' ? 'CONFLICT' : 'ERROR', command, {
      error: {
        code: clean(error?.code || error?.message) || 'CATALOG_APPLY_COMMIT_FAILED',
        retryable: error?.code !== 'MERCH_MASTER_REVISION_CONFLICT',
      },
      rollback: {
        attempted: true,
        restored: coreResult.rollbackOk === true && !localRollbackError,
        staleSkipped: coreResult.staleRollbackSkipped === true,
        localError: clean(localRollbackError?.message),
      },
    });
  }
}

export const smartParserCatalogApplyCommandAdapter = deepFreeze({
  version: SMARTPARSER_CATALOG_APPLY_ADAPTER_VERSION,
  schemaVersion: SMARTPARSER_CATALOG_APPLY_COMMAND_SCHEMA_VERSION,
  actions: SMARTPARSER_CATALOG_APPLY_ACTIONS,
  stopReasons: SMARTPARSER_CATALOG_STOP_REASONS,
  createCommand: createSmartParserCatalogApplyCommand,
  validate: validateCommand,
  commitSmartParserCatalogApply,
});

globalThis.ONEAPP_SMARTPARSER_CATALOG_APPLY_COMMAND_ADAPTER_V1 = smartParserCatalogApplyCommandAdapter;
globalThis.ONEAPP_SMARTPARSER_CATALOG_APPLY_COMMAND_ADAPTER = smartParserCatalogApplyCommandAdapter;
