import {
  cloneJson,
  deepFreeze,
  sha256Hex,
  stableStringify,
} from './change-request-contract.js';
import {
  PRODUCT_SNAPSHOT_SCHEMA_VERSION,
  getProductSnapshotResult,
} from './product-master-read-adapter.js';

export const PRODUCT_MASTER_COMMAND_ADAPTER_VERSION = 'ONEAPP_PRODUCT_MASTER_COMMAND_ADAPTER_V1';
export const MERCHOPS_REVIEWED_WORK_COMMAND_SCHEMA_VERSION = 'MERCHOPS_REVIEWED_WORK_APPLY_V1';
export const PRODUCT_MASTER_OWNER_APP_ID = 'master-lookup';

const HISTORY_KEY = 'merchHistory_v870';
const PROTECTED_LINKED_KEYS = Object.freeze([
  'merchStoppedProducts_v2',
  'pending_shop_status',
]);

// MerchOps F7 may update only reviewed product-information, price, promotion,
// theme, and compatibility fields. Identifiers, deletion, and arbitrary fields
// are deliberately absent.
export const MERCHOPS_REVIEWED_PATCH_FIELDS = Object.freeze([
  '창고', '1코드', '1그룹명', '2코드', '2그룹명', '3코드', '3그룹명', '오더즈',
  '구매처', '브랜드', '품목명', '규격', '안전재고', '간단설명', '카탈로그', '견적서',
  '출고가', '입고가', '판매가', '입고B', '도매A', '도매B', '상장가', '최종전송',
  '최종입고', '단가H', '단가I', '시중가', '행사가', '행사테마', '테마1', '테마2',
  '테마3', '테마4', '테마5', '판매여부', '1종코드', '1종규격', '1종연산',
  '2종코드', '2종규격', '2종연산', '외주비', '노무비', '경비', '비과세', '과세',
  '기본', '기본여부', '구분(기본)', '관리구분', '연동', '단가연동', '싯가',
  '싯가판매여부', '단위', '준비기간', '재입고 준비기간', '마감시간', '주문마감시간',
  '검색어등록', '유통사코드', '찜적용안함', '재고수량', '재고', '최소구매수',
  '최대구매수',
]);

const allowedPatchFields = new Set(MERCHOPS_REVIEWED_PATCH_FIELDS);
const clean = (value) => String(value ?? '').trim();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function sameValue(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function commandError(code, message = code, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function productCodeOf(product = {}) {
  return clean(product?.['코드'] ?? product?.['품목코드']);
}

function productsToMap(products = []) {
  const result = {};
  for (const product of Array.isArray(products) ? products : []) {
    const code = productCodeOf(product);
    if (!code) throw commandError('PRODUCT_CODE_REQUIRED');
    if (hasOwn(result, code)) throw commandError('DUPLICATE_PRODUCT_CODE', `중복 상품코드: ${code}`);
    result[code] = cloneJson(product);
  }
  return result;
}

function validatePatch(patch, index) {
  const path = `patches[${index}]`;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw commandError('PATCH_OBJECT_REQUIRED', path);
  }
  const code = clean(patch.code);
  const field = clean(patch.field);
  if (!code) throw commandError('PATCH_CODE_REQUIRED', `${path}.code`);
  if (!field) throw commandError('PATCH_FIELD_REQUIRED', `${path}.field`);
  if (!allowedPatchFields.has(field)) {
    throw commandError('PATCH_FIELD_NOT_ALLOWED', `${path}.field`, { field });
  }
  if (!hasOwn(patch, 'beforeValue')) throw commandError('PATCH_BEFORE_REQUIRED', `${path}.beforeValue`);
  if (!hasOwn(patch, 'afterValue')) throw commandError('PATCH_AFTER_REQUIRED', `${path}.afterValue`);
  if (patch.afterValue === undefined) throw commandError('PATCH_DELETE_NOT_ALLOWED', `${path}.afterValue`);
  if (sameValue(patch.beforeValue, patch.afterValue)) throw commandError('PATCH_NO_CHANGE', path);
  const history = patch.history;
  if (!history || typeof history !== 'object') throw commandError('PATCH_HISTORY_REQUIRED', `${path}.history`);
  if (clean(history.code) !== code || clean(history.field) !== field) {
    throw commandError('PATCH_HISTORY_TARGET_MISMATCH', `${path}.history`);
  }
  if (!hasOwn(history, 'beforeValue') || !sameValue(history.beforeValue, patch.beforeValue)) {
    throw commandError('PATCH_HISTORY_BEFORE_MISMATCH', `${path}.history.beforeValue`);
  }
  if (!hasOwn(history, 'afterValue') || !sameValue(history.afterValue, patch.afterValue)) {
    throw commandError('PATCH_HISTORY_AFTER_MISMATCH', `${path}.history.afterValue`);
  }
  if (field === '판매여부') {
    const salePolicyEvidence = stableStringify(history.entry || {});
    if (!/(입고가\s*없음|NO[_ -]?INBOUND)/i.test(salePolicyEvidence)) {
      throw commandError('PATCH_SALE_POLICY_NOT_ALLOWED', `${path}.history.entry`);
    }
  }
  return { ...cloneJson(patch), code, field };
}

export function validateReviewedMerchOpsCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw commandError('COMMAND_OBJECT_REQUIRED');
  }
  if (command.schemaVersion !== MERCHOPS_REVIEWED_WORK_COMMAND_SCHEMA_VERSION) {
    throw commandError('COMMAND_SCHEMA_INVALID');
  }
  if (clean(command.ownerAppId) !== PRODUCT_MASTER_OWNER_APP_ID) {
    throw commandError('COMMAND_OWNER_INVALID');
  }
  if (clean(command.sourceAppId) !== 'merchops') throw commandError('COMMAND_SOURCE_INVALID');
  if (!clean(command.operationId)) throw commandError('COMMAND_OPERATION_ID_REQUIRED');
  if (!clean(command.expectedRevision)) throw commandError('COMMAND_EXPECTED_REVISION_REQUIRED');
  if (!clean(command.baseSnapshotId)) throw commandError('COMMAND_BASE_SNAPSHOT_REQUIRED');
  if (!clean(command.baseContentHash)) throw commandError('COMMAND_BASE_HASH_REQUIRED');
  if (!clean(command.reason)) throw commandError('COMMAND_REASON_REQUIRED');
  if (!command.actor || !clean(command.actor.actorId) || !clean(command.actor.actorState)) {
    throw commandError('COMMAND_ACTOR_REQUIRED');
  }
  if (!Array.isArray(command.patches) || command.patches.length === 0) {
    throw commandError('COMMAND_PATCHES_REQUIRED');
  }
  const seen = new Set();
  const patches = command.patches.map((patch, index) => {
    const normalized = validatePatch(patch, index);
    const key = `${normalized.code}\u0000${normalized.field}`;
    if (seen.has(key)) throw commandError('DUPLICATE_PATCH_FIELD', `중복 patch: ${normalized.code}/${normalized.field}`);
    seen.add(key);
    return normalized;
  });
  return deepFreeze({ ...cloneJson(command), patches });
}

function parseHistory(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readHistoryRawDefault() {
  return globalThis.localStorage?.getItem(HISTORY_KEY) ?? null;
}

function restoreHistoryRawDefault(raw) {
  if (!globalThis.localStorage) throw commandError('HISTORY_STORAGE_NOT_AVAILABLE');
  if (raw === null || raw === undefined) globalThis.localStorage.removeItem(HISTORY_KEY);
  else globalThis.localStorage.setItem(HISTORY_KEY, raw);
  const restored = globalThis.localStorage.getItem(HISTORY_KEY);
  if ((raw ?? null) !== (restored ?? null)) throw commandError('HISTORY_ROLLBACK_VERIFY_FAILED');
  return true;
}

async function appendHistoryDefault(logs) {
  if (typeof globalThis.persistMerchHistoryLogs === 'function') {
    return globalThis.persistMerchHistoryLogs(logs, parseHistory(readHistoryRawDefault()));
  }
  if (typeof globalThis.ONEAPP?.HISTORY?.addHistoryLogs === 'function') {
    return globalThis.ONEAPP.HISTORY.addHistoryLogs(logs);
  }
  throw commandError('HISTORY_APPEND_NOT_AVAILABLE');
}

async function readLinkedStateDefault() {
  const state = {
    local: {
      merchStoppedProducts_v2: globalThis.localStorage?.getItem('merchStoppedProducts_v2') ?? null,
      pendingShopStatus: globalThis.localStorage?.getItem('pendingShopStatus') ?? null,
    },
    indexedDb: {},
  };
  const getIDB = globalThis.ONEAPP?.STORAGE?.getIDB || globalThis.getIDB;
  if (typeof getIDB === 'function') {
    for (const key of PROTECTED_LINKED_KEYS) {
      state.indexedDb[key] = await getIDB(key).catch(() => undefined);
    }
  }
  return state;
}

function defaultDependencies(overrides = {}) {
  return {
    readSnapshotResult: overrides.readSnapshotResult || getProductSnapshotResult,
    commitMasterState: overrides.commitMasterState
      || globalThis.ONEAPP?.STORAGE?.commitMasterState
      || globalThis.commitMerchMasterState,
    readHistoryRaw: overrides.readHistoryRaw || readHistoryRawDefault,
    appendHistory: overrides.appendHistory || appendHistoryDefault,
    restoreHistoryRaw: overrides.restoreHistoryRaw || restoreHistoryRawDefault,
    readLinkedState: overrides.readLinkedState || readLinkedStateDefault,
    publishNotification: overrides.publishNotification || (() => {
      if (!globalThis.localStorage) return false;
      globalThis.localStorage.setItem('merchMaster_sync_trigger', String(Date.now()));
      return true;
    }),
    now: overrides.now || (() => new Date().toISOString()),
  };
}

function resultEnvelope(values = {}) {
  return deepFreeze({
    adapterVersion: PRODUCT_MASTER_COMMAND_ADAPTER_VERSION,
    commandSchemaVersion: MERCHOPS_REVIEWED_WORK_COMMAND_SCHEMA_VERSION,
    ...values,
  });
}

function buildHistoryLogs(command, operationHash, now) {
  return command.patches.map((patch, index) => ({
    ...(patch.history.entry && typeof patch.history.entry === 'object' ? cloneJson(patch.history.entry) : {}),
    id: clean(patch.history.entry?.id) || `${command.operationId}:${index + 1}`,
    timestampISO: now,
    operationId: command.operationId,
    operationHash,
    actorId: command.actor.actorId,
    actorState: command.actor.actorState,
    reason: command.reason,
    source: clean(patch.history.entry?.source) || 'MerchOps F7 reviewed command',
    sourceRole: 'merchops',
    actionType: clean(patch.history.entry?.actionType) || 'F7 검토 작업 적용',
    code: patch.code,
    field: patch.field,
    oldVal: cloneJson(patch.beforeValue),
    newVal: cloneJson(patch.afterValue),
  }));
}

function operationHistoryState(history, operationId, operationHash) {
  const rows = history.filter((entry) => clean(entry?.operationId) === operationId);
  if (rows.length === 0) return { found: false, conflict: false };
  const hashes = new Set(rows.map((entry) => clean(entry?.operationHash)).filter(Boolean));
  return { found: true, conflict: hashes.size !== 1 || !hashes.has(operationHash), rows };
}

export function createProductMasterCommandAdapter(dependencyOverrides = {}) {
  return deepFreeze({
    version: PRODUCT_MASTER_COMMAND_ADAPTER_VERSION,
    commandSchemaVersion: MERCHOPS_REVIEWED_WORK_COMMAND_SCHEMA_VERSION,
    ownerAppId: PRODUCT_MASTER_OWNER_APP_ID,
    allowedPatchFields: MERCHOPS_REVIEWED_PATCH_FIELDS,
    async commitReviewedMerchOpsWork(input) {
      let command;
      try {
        command = validateReviewedMerchOpsCommand(input);
      } catch (error) {
        return resultEnvelope({
          ok: false,
          status: 'REJECTED',
          error: { code: error.code || 'COMMAND_REJECTED', message: clean(error.message) },
          rollback: { attempted: false, master: false, history: false, linkedState: true },
        });
      }

      const dependencies = defaultDependencies(dependencyOverrides);
      if (typeof dependencies.commitMasterState !== 'function') {
        return resultEnvelope({
          ok: false,
          status: 'NOT_AVAILABLE',
          operationId: command.operationId,
          error: { code: 'PRODUCT_MASTER_COMMIT_NOT_AVAILABLE', message: '상품 master command 저장 경계를 사용할 수 없습니다.' },
          rollback: { attempted: false, master: false, history: false, linkedState: true },
        });
      }

      const operationHash = await sha256Hex({
        schemaVersion: command.schemaVersion,
        operationId: command.operationId,
        expectedRevision: command.expectedRevision,
        baseSnapshotId: command.baseSnapshotId,
        patches: command.patches.map(({ code, field, beforeValue, afterValue }) => ({ code, field, beforeValue, afterValue })),
      });
      const previousHistoryRaw = await dependencies.readHistoryRaw();
      const priorOperation = operationHistoryState(parseHistory(previousHistoryRaw), command.operationId, operationHash);
      const beforeSnapshotResult = await dependencies.readSnapshotResult();
      if (beforeSnapshotResult?.status === 'ERROR' || !beforeSnapshotResult?.snapshot) {
        return resultEnvelope({
          ok: false,
          status: 'ERROR',
          operationId: command.operationId,
          error: beforeSnapshotResult?.error || { code: 'PRODUCT_SNAPSHOT_READ_FAILED', message: '상품 Snapshot을 읽지 못했습니다.' },
          rollback: { attempted: false, master: false, history: false, linkedState: true },
        });
      }
      const beforeSnapshot = beforeSnapshotResult.snapshot;
      let masterMap;
      try {
        masterMap = productsToMap(beforeSnapshot.data?.products);
      } catch (error) {
        return resultEnvelope({
          ok: false,
          status: 'REJECTED',
          operationId: command.operationId,
          error: { code: error.code || 'PRODUCT_SNAPSHOT_INVALID', message: clean(error.message) },
          rollback: { attempted: false, master: false, history: false, linkedState: true },
        });
      }

      if (priorOperation.found) {
        if (priorOperation.conflict) {
          return resultEnvelope({
            ok: false,
            status: 'CONFLICT',
            conflict: true,
            operationId: command.operationId,
            error: { code: 'OPERATION_ID_CONFLICT', message: '같은 operation ID에 다른 command가 기록되어 있습니다.' },
            rollback: { attempted: false, master: false, history: false, linkedState: true },
          });
        }
        const applied = command.patches.every((patch) => hasOwn(masterMap[patch.code] || {}, patch.field)
          && sameValue(masterMap[patch.code][patch.field], patch.afterValue));
        if (applied) {
          return resultEnvelope({
            ok: true,
            status: 'DUPLICATE',
            duplicate: true,
            operationId: command.operationId,
            revision: beforeSnapshot.snapshotVersion,
            rowCount: Object.keys(masterMap).length,
            changedFieldCount: command.patches.length,
            historyCount: priorOperation.rows.length,
            actorState: command.actor.actorState,
            rollback: { attempted: false, master: false, history: false, linkedState: true },
          });
        }
      }

      const revisionConflict = beforeSnapshot.schemaVersion !== PRODUCT_SNAPSHOT_SCHEMA_VERSION
        || beforeSnapshot.snapshotVersion !== command.expectedRevision
        || beforeSnapshot.snapshotId !== command.baseSnapshotId
        || beforeSnapshot.contentHash !== command.baseContentHash;
      if (revisionConflict) {
        return resultEnvelope({
          ok: false,
          status: 'CONFLICT',
          conflict: true,
          operationId: command.operationId,
          revision: beforeSnapshot.snapshotVersion,
          error: { code: 'PRODUCT_SNAPSHOT_CONFLICT', message: '작업 시작 Snapshot과 현재 상품 기준정보가 다릅니다.' },
          rollback: { attempted: false, master: false, history: false, linkedState: true },
        });
      }

      const previousMasterMap = cloneJson(masterMap);
      try {
        for (const patch of command.patches) {
          const product = masterMap[patch.code];
          if (!product) throw commandError('PATCH_PRODUCT_NOT_FOUND', `마스터 미등록 상품: ${patch.code}`);
          const current = hasOwn(product, patch.field) ? product[patch.field] : '';
          if (!sameValue(current, patch.beforeValue)) {
            throw commandError('PATCH_BEFORE_CONFLICT', `변경 전 값 불일치: ${patch.code}/${patch.field}`);
          }
          product[patch.field] = cloneJson(patch.afterValue);
        }
      } catch (error) {
        return resultEnvelope({
          ok: false,
          status: /CONFLICT/.test(error.code || '') ? 'CONFLICT' : 'REJECTED',
          conflict: /CONFLICT/.test(error.code || ''),
          operationId: command.operationId,
          error: { code: error.code || 'PATCH_REJECTED', message: clean(error.message) },
          rollback: { attempted: false, master: false, history: false, linkedState: true },
        });
      }

      const previousLinkedState = await dependencies.readLinkedState();
      const historyLogs = buildHistoryLogs(command, operationHash, dependencies.now());
      let historyRestored = false;
      let linkedStatePreserved = true;
      const expectedRowCount = Object.keys(masterMap).length;
      const commitResult = await dependencies.commitMasterState(masterMap, {
        expectedRevision: command.expectedRevision,
        afterVerifiedError: 'F7 command 후속 검증 또는 history 저장 실패',
        afterVerified: async () => {
          const verifiedSnapshotResult = await dependencies.readSnapshotResult();
          if (verifiedSnapshotResult?.status !== 'READY' || !verifiedSnapshotResult.snapshot) {
            throw commandError('POST_COMMIT_SNAPSHOT_VERIFY_FAILED');
          }
          const verifiedMap = productsToMap(verifiedSnapshotResult.snapshot.data?.products);
          if (Object.keys(verifiedMap).length !== expectedRowCount) throw commandError('POST_COMMIT_ROW_COUNT_MISMATCH');
          for (const patch of command.patches) {
            if (!sameValue(verifiedMap[patch.code]?.[patch.field], patch.afterValue)) {
              throw commandError('POST_COMMIT_PATCH_VERIFY_FAILED', `${patch.code}/${patch.field}`);
            }
          }
          const nextLinkedState = await dependencies.readLinkedState();
          linkedStatePreserved = sameValue(previousLinkedState, nextLinkedState);
          if (!linkedStatePreserved) throw commandError('PROTECTED_LINKED_STATE_CHANGED');
          try {
            await dependencies.appendHistory(historyLogs);
          } catch (error) {
            try {
              historyRestored = await dependencies.restoreHistoryRaw(previousHistoryRaw);
            } catch (restoreError) {
              throw commandError('HISTORY_APPEND_AND_ROLLBACK_FAILED', clean(error?.message), { cause: restoreError });
            }
            throw error;
          }
          return true;
        },
      });

      if (!commitResult?.ok) {
        return resultEnvelope({
          ok: false,
          status: commitResult?.conflict ? 'CONFLICT' : 'ERROR',
          conflict: !!commitResult?.conflict,
          operationId: command.operationId,
          revision: commitResult?.revision || '',
          error: { code: commitResult?.conflict ? 'PRODUCT_REVISION_CONFLICT' : 'PRODUCT_MASTER_COMMIT_FAILED', message: clean(commitResult?.error) },
          rollback: {
            attempted: true,
            master: !!commitResult?.rollbackOk,
            history: historyRestored || sameValue(previousHistoryRaw, await dependencies.readHistoryRaw()),
            linkedState: linkedStatePreserved,
            staleRollbackSkipped: !!commitResult?.staleRollbackSkipped,
          },
        });
      }

      const finalSnapshotResult = await dependencies.readSnapshotResult();
      const finalSnapshot = finalSnapshotResult?.snapshot;
      const finalMap = finalSnapshot ? productsToMap(finalSnapshot.data?.products) : {};
      const finalVerified = finalSnapshotResult?.status === 'READY'
        && finalSnapshot?.snapshotVersion === commitResult.revision
        && Object.keys(finalMap).length === expectedRowCount
        && command.patches.every((patch) => sameValue(finalMap[patch.code]?.[patch.field], patch.afterValue));
      if (!finalVerified) {
        const rollbackResult = await dependencies.commitMasterState(previousMasterMap, {
          expectedRevision: commitResult.revision,
          afterVerifiedError: 'F7 command 최종 검산 rollback 후속 검증 실패',
          afterVerified: async () => {
            const rollbackSnapshotResult = await dependencies.readSnapshotResult();
            const rollbackMap = rollbackSnapshotResult?.snapshot
              ? productsToMap(rollbackSnapshotResult.snapshot.data?.products)
              : {};
            if (rollbackSnapshotResult?.status !== 'READY' || !sameValue(rollbackMap, previousMasterMap)) {
              throw commandError('FINAL_ROLLBACK_MASTER_VERIFY_FAILED');
            }
            const rollbackLinkedState = await dependencies.readLinkedState();
            if (!sameValue(previousLinkedState, rollbackLinkedState)) {
              throw commandError('FINAL_ROLLBACK_LINKED_STATE_CHANGED');
            }
            await dependencies.restoreHistoryRaw(previousHistoryRaw);
            return true;
          },
        });
        const historyRollbackVerified = sameValue(previousHistoryRaw, await dependencies.readHistoryRaw());
        return resultEnvelope({
          ok: false,
          status: 'ERROR',
          operationId: command.operationId,
          revision: rollbackResult?.revision || commitResult.revision,
          error: { code: 'FINAL_PRODUCT_MASTER_VERIFY_FAILED', message: '저장 결과 최종 검산에 실패했습니다.' },
          rollback: {
            attempted: true,
            master: !!rollbackResult?.ok,
            history: historyRollbackVerified,
            linkedState: linkedStatePreserved,
            staleRollbackSkipped: !!rollbackResult?.staleRollbackSkipped,
          },
        });
      }

      try {
        await dependencies.publishNotification({
          operationId: command.operationId,
          revision: commitResult.revision,
          sourceAppId: command.sourceAppId,
        });
      } catch (error) {
        console.warn('[Product Master Command] sync notification failed', error);
      }

      return resultEnvelope({
        ok: true,
        status: 'APPLIED',
        operationId: command.operationId,
        previousRevision: command.expectedRevision,
        revision: commitResult.revision,
        rowCount: expectedRowCount,
        changedFieldCount: command.patches.length,
        historyCount: historyLogs.length,
        actorState: command.actor.actorState,
        rollback: { attempted: false, master: false, history: false, linkedState: linkedStatePreserved },
      });
    },
  });
}

export const productMasterCommandAdapter = createProductMasterCommandAdapter();

globalThis.ONEAPP_PRODUCT_MASTER_COMMAND_ADAPTER_V1 = productMasterCommandAdapter;
globalThis.ONEAPP_PRODUCT_MASTER_COMMAND_ADAPTER = productMasterCommandAdapter;
