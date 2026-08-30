import { cloneJson, deepFreeze, sha256Hex } from '../reference-data/change-request-contract.js';
import { buildProductSnapshot } from '../reference-data/product-master-read-adapter.js';

export const SMARTPARSER_STOP_MANAGEMENT_ADAPTER_VERSION = 'ONEAPP_SMARTPARSER_STOP_MANAGEMENT_COMMAND_ADAPTER_V1';
export const SMARTPARSER_STOP_MANAGEMENT_COMMAND_SCHEMA_VERSION = 'ONEAPP_SMARTPARSER_STOP_MANAGEMENT_COMMAND_V1';
export const SMARTPARSER_STOP_MANAGEMENT_ACTIONS = Object.freeze(['STOP', 'RESUME', 'UPDATE_METADATA']);

const STOPPED_KEY = 'merchStoppedProducts_v2';
const PENDING_KEY = 'pending_shop_status';
const HISTORY_KEY = 'merchHistory_v870';
const LOCAL_PENDING_KEY = 'pendingShopStatus';
const MASTER_NOTIFICATION_KEY = 'merchMaster_sync_trigger';
const STOP_NOTIFICATION_KEY = 'merchStopManager_sync_trigger';

const clean = (value) => String(value ?? '').trim();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

export function normalizeSmartParserStopCode(value) {
  return clean(value).normalize('NFKC').replace(/[\s-]+/g, '').toUpperCase();
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return cloneJson(fallback);
  try { return JSON.parse(value); } catch { return cloneJson(fallback); }
}

function normalizeStoppedProducts(input = {}) {
  const result = {};
  const entries = Array.isArray(input)
    ? input.map((item) => [item?.productCode || item?.코드 || '', item])
    : Object.entries(input && typeof input === 'object' ? input : {});
  entries.forEach(([rawCode, rawItem]) => {
    const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const code = normalizeSmartParserStopCode(item.productCode || item.코드 || rawCode);
    if (!code) return;
    result[code] = { ...cloneJson(item), productCode: code };
  });
  return result;
}

function normalizePendingStatus(input = []) {
  const byCode = new Map();
  (Array.isArray(input) ? input : []).forEach((rawItem) => {
    const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const code = normalizeSmartParserStopCode(item.code || item.productCode || item.코드);
    if (code) byCode.set(code, { ...cloneJson(item), code });
  });
  return [...byCode.values()];
}

function validateCommand(command) {
  const errors = [];
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    return deepFreeze({ valid: false, errors: [{ code: 'COMMAND_OBJECT_REQUIRED', path: '' }] });
  }
  if (command.schemaVersion !== SMARTPARSER_STOP_MANAGEMENT_COMMAND_SCHEMA_VERSION) errors.push({ code: 'SCHEMA_VERSION_INVALID', path: 'schemaVersion' });
  ['operationId', 'expectedSnapshotId', 'requestedAt'].forEach((field) => {
    if (!clean(command[field])) errors.push({ code: 'REQUIRED_FIELD_MISSING', path: field });
  });
  if (!hasOwn(command, 'expectedRevision')) errors.push({ code: 'EXPECTED_REVISION_REQUIRED', path: 'expectedRevision' });
  const action = clean(command.action).toUpperCase();
  if (!SMARTPARSER_STOP_MANAGEMENT_ACTIONS.includes(action)) errors.push({ code: 'ACTION_INVALID', path: 'action' });
  if (!command.actor || typeof command.actor !== 'object' || !clean(command.actor.actorState)) errors.push({ code: 'ACTOR_STATE_REQUIRED', path: 'actor.actorState' });
  const targets = Array.isArray(command.targets) ? command.targets : [];
  if (targets.length === 0) errors.push({ code: 'TARGETS_REQUIRED', path: 'targets' });
  const seen = new Set();
  targets.forEach((target, index) => {
    const code = normalizeSmartParserStopCode(target?.code);
    if (!code) errors.push({ code: 'TARGET_CODE_REQUIRED', path: `targets[${index}].code` });
    else if (seen.has(code)) errors.push({ code: 'DUPLICATE_TARGET_CODE', path: `targets[${index}].code` });
    seen.add(code);
    if (action !== 'UPDATE_METADATA') {
      if (!hasOwn(target, 'beforeSaleStatus')) errors.push({ code: 'BEFORE_SALE_STATUS_REQUIRED', path: `targets[${index}].beforeSaleStatus` });
      const expectedAfter = action === 'STOP' ? 0 : 1;
      if (Number(target?.afterSaleStatus) !== expectedAfter) errors.push({ code: 'AFTER_SALE_STATUS_INVALID', path: `targets[${index}].afterSaleStatus` });
    }
  });
  return deepFreeze({ valid: errors.length === 0, errors });
}

function result(status, command, extra = {}) {
  return deepFreeze({
    adapterVersion: SMARTPARSER_STOP_MANAGEMENT_ADAPTER_VERSION,
    schemaVersion: SMARTPARSER_STOP_MANAGEMENT_COMMAND_SCHEMA_VERSION,
    ok: status === 'APPLIED' || status === 'DUPLICATE',
    status,
    operationId: clean(command?.operationId),
    ...cloneJson(extra),
  });
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
    normalizeSmartParserStopCode(item?.코드 || item?.품목코드 || key) === normalizedCode
  ));
  if (matches.length > 1) throw new Error(`DUPLICATE_MASTER_PRODUCT_CODE:${normalizedCode}`);
  if (matches.length === 0) throw new Error(`MASTER_PRODUCT_NOT_FOUND:${normalizedCode}`);
  return { key: matches[0][0], item: matches[0][1] };
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

export async function commitSmartParserStopManagement(command, options = {}) {
  const validation = validateCommand(command);
  if (!validation.valid) return result('REJECTED', command, { validation });

  const storage = options.storage || globalThis.ONEAPP?.STORAGE;
  if (!storage?.readMasterState || !storage?.commitMasterStateOrThrow || !globalThis.localStorage) {
    return result('NOT_AVAILABLE', command, { error: { code: 'STOP_MANAGEMENT_STORAGE_NOT_AVAILABLE', retryable: true } });
  }

  const action = clean(command.action).toUpperCase();
  const commandHash = await sha256Hex(command);
  const history = parseJson(globalThis.localStorage.getItem(HISTORY_KEY), []);
  const duplicateLogs = (Array.isArray(history) ? history : []).filter((entry) => entry?.operationId === command.operationId);
  if (duplicateLogs.length > 0) {
    const samePayload = duplicateLogs.every((entry) => entry.commandHash === commandHash);
    let duplicateSnapshot = null;
    if (samePayload) {
      try {
        const duplicateState = await storage.readMasterState();
        duplicateSnapshot = await buildProductSnapshot({
          recordRows: Array.isArray(duplicateState.items) ? duplicateState.items : [],
          storeSnapshot: duplicateState.snapshot,
          revision: duplicateState.revision,
        }, { now: command.requestedAt });
      } catch {}
    }
    return result(samePayload ? 'DUPLICATE' : 'CONFLICT', command, {
      error: samePayload ? null : { code: 'OPERATION_ID_CONFLICT', retryable: false },
      revision: duplicateSnapshot?.revision ?? null,
      snapshotId: duplicateSnapshot?.snapshotId || '',
      snapshotVersion: duplicateSnapshot?.snapshotVersion || '',
      contentHash: duplicateSnapshot?.contentHash || '',
    });
  }

  let state;
  try {
    state = await storage.readMasterState([STOPPED_KEY, PENDING_KEY]);
  } catch (error) {
    return result('ERROR', command, { error: { code: clean(error?.message) || 'STOP_STATE_READ_FAILED', retryable: true } });
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
  if (state.revision !== command.expectedRevision) {
    return result('CONFLICT', command, { error: { code: 'PRODUCT_REVISION_CONFLICT', retryable: false }, currentRevision: state.revision ?? null });
  }

  const master = masterMapFromState(state);
  const nextStopped = normalizeStoppedProducts(
    state.extraStoreEntries?.[STOPPED_KEY] ?? parseJson(globalThis.localStorage.getItem(STOPPED_KEY), {}),
  );
  let nextPending = normalizePendingStatus(
    state.extraStoreEntries?.[PENDING_KEY] ?? parseJson(globalThis.localStorage.getItem(LOCAL_PENDING_KEY), []),
  );
  const logs = [];
  const processedCodes = [];

  try {
    for (const rawTarget of command.targets) {
      const code = normalizeSmartParserStopCode(rawTarget.code);
      const resolved = findProduct(master, code);
      const current = resolved.item;
      const beforeStopped = nextStopped[code] || null;
      if (action === 'UPDATE_METADATA') {
        if (!beforeStopped) throw new Error(`STOPPED_PRODUCT_NOT_FOUND:${code}`);
        const afterStopped = {
          ...beforeStopped,
          reason: hasOwn(rawTarget, 'reason') ? clean(rawTarget.reason) : clean(beforeStopped.reason),
          memo: hasOwn(rawTarget, 'memo') ? clean(rawTarget.memo) : clean(beforeStopped.memo),
          productCode: code,
          updatedAt: command.requestedAt,
        };
        nextStopped[code] = afterStopped;
        if (JSON.stringify(beforeStopped) !== JSON.stringify(afterStopped)) {
          logs.push({
            id: `${command.operationId}:${code}:metadata`,
            operationId: command.operationId,
            commandHash,
            source: 'parser',
            sourceLabel: '스마트 파서',
            actionType: 'smartparser_stop_management_metadata',
            historyType: '정지관리정보',
            changeType: '정지관리정보',
            route: '파서/품절정지관리/관리정보',
            path: 'SmartParser > 품절/정지 관리 > 관리정보',
            code: clean(current.코드 || rawTarget.code),
            name: clean(current.품목명),
            spec: clean(current.규격),
            unit: clean(current.단위),
            field: '정지관리',
            oldVal: { reason: beforeStopped.reason || '', memo: beforeStopped.memo || '' },
            newVal: { reason: afterStopped.reason || '', memo: afterStopped.memo || '' },
            timestampISO: command.requestedAt,
            actor: cloneJson(command.actor),
            reason: clean(command.reason),
            memo: clean(command.memo),
            version: SMARTPARSER_STOP_MANAGEMENT_COMMAND_SCHEMA_VERSION,
          });
        }
        processedCodes.push(code);
        continue;
      }

      const beforeSaleStatus = current.판매여부 ?? '';
      if (String(beforeSaleStatus) !== String(rawTarget.beforeSaleStatus)) throw new Error(`PRODUCT_BEFORE_STATE_CONFLICT:${code}`);
      const afterSaleStatus = action === 'STOP' ? 0 : 1;
      master[resolved.key] = { ...current, 판매여부: afterSaleStatus };
      const existingPendingIndex = nextPending.findIndex((entry) => normalizeSmartParserStopCode(entry.code) === code);
      const reason = clean(rawTarget.reason || command.reason || (action === 'STOP' ? '관리자 정지' : '판매재개'));
      const memo = clean(rawTarget.memo || command.memo);
      if (action === 'STOP') {
        nextStopped[code] = {
          ...(beforeStopped || {}),
          productCode: code,
          name: clean(current.품목명),
          stoppedAt: beforeStopped?.stoppedAt || command.requestedAt,
          updatedAt: command.requestedAt,
          reason,
          memo,
          source: 'SmartParser',
          status: 'stopped',
          pendingAction: '',
        };
      } else {
        delete nextStopped[code];
      }
      const pendingEntry = {
        code,
        type: action === 'STOP' ? 'stop' : 'resume',
        name: clean(current.품목명),
        source: 'SmartParser',
        reason,
        updatedAt: command.requestedAt,
      };
      if (existingPendingIndex >= 0) nextPending[existingPendingIndex] = pendingEntry;
      else nextPending.push(pendingEntry);
      logs.push({
        id: `${command.operationId}:${code}:${action.toLowerCase()}`,
        operationId: command.operationId,
        commandHash,
        source: 'parser',
        sourceLabel: '스마트 파서',
        actionType: action === 'STOP' ? 'smartparser_stop_management_stop' : 'smartparser_stop_management_resume',
        historyType: action === 'STOP' ? '판매정지' : '판매재개',
        changeType: action === 'STOP' ? '판매정지' : '판매재개',
        route: `파서/품절정지관리/${action === 'STOP' ? '판매정지' : '판매재개'}`,
        path: `SmartParser > 품절/정지 관리 > ${action === 'STOP' ? '판매정지' : '판매재개'}`,
        code: clean(current.코드 || rawTarget.code),
        name: clean(current.품목명),
        spec: clean(current.규격),
        unit: clean(current.단위),
        field: '판매여부',
        oldVal: beforeSaleStatus,
        newVal: afterSaleStatus,
        timestampISO: command.requestedAt,
        actor: cloneJson(command.actor),
        reason,
        memo,
        version: SMARTPARSER_STOP_MANAGEMENT_COMMAND_SCHEMA_VERSION,
      });
      processedCodes.push(code);
    }
  } catch (error) {
    return result('CONFLICT', command, { error: { code: clean(error?.message) || 'STOP_COMMAND_CONFLICT', retryable: false } });
  }

  if (processedCodes.length === 0) return result('REJECTED', command, { error: { code: 'NO_EFFECTIVE_TARGETS', retryable: false } });
  const nextHistory = [...logs, ...(Array.isArray(history) ? history : [])].slice(0, 5000);
  const localWrites = {
    [HISTORY_KEY]: nextHistory,
    [STOPPED_KEY]: nextStopped,
    [LOCAL_PENDING_KEY]: nextPending,
    [STOP_NOTIFICATION_KEY]: command.requestedAt,
    ...(action === 'UPDATE_METADATA' ? {} : { [MASTER_NOTIFICATION_KEY]: command.requestedAt }),
  };
  const previousLocal = Object.fromEntries(Object.keys(localWrites).map((key) => [key, globalThis.localStorage.getItem(key)]));

  try {
    const commitResult = await storage.commitMasterStateOrThrow(master, {
      expectedRevision: command.expectedRevision,
      extraStoreEntries: { [STOPPED_KEY]: nextStopped, [PENDING_KEY]: nextPending },
      afterVerified: () => {
        writeVerifiedLocalStorage(localWrites);
        return true;
      },
      afterVerifiedError: 'SmartParser stop-management linked-state verification failed',
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
      rollback: { attempted: false, restored: false, staleSkipped: false },
    });
  } catch (error) {
    let localRollbackError = null;
    try { restoreLocalStorage(previousLocal); } catch (restoreError) { localRollbackError = restoreError; }
    const coreResult = error?.result || {};
    return result(error?.code === 'MERCH_MASTER_REVISION_CONFLICT' ? 'CONFLICT' : 'ERROR', command, {
      error: {
        code: clean(error?.code || error?.message) || 'STOP_COMMAND_COMMIT_FAILED',
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

export const smartParserStopManagementCommandAdapter = deepFreeze({
  version: SMARTPARSER_STOP_MANAGEMENT_ADAPTER_VERSION,
  schemaVersion: SMARTPARSER_STOP_MANAGEMENT_COMMAND_SCHEMA_VERSION,
  actions: SMARTPARSER_STOP_MANAGEMENT_ACTIONS,
  validate: validateCommand,
  commitSmartParserStopManagement,
});

globalThis.ONEAPP_SMARTPARSER_STOP_MANAGEMENT_COMMAND_ADAPTER_V1 = smartParserStopManagementCommandAdapter;
globalThis.ONEAPP_SMARTPARSER_STOP_MANAGEMENT_COMMAND_ADAPTER = smartParserStopManagementCommandAdapter;
