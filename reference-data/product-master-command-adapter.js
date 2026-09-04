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
export const MERCHOPS_PRODUCT_REGISTRATION_COMMAND_SCHEMA_VERSION = 'MERCHOPS_PRODUCT_REGISTRATION_V1';
export const PRODUCT_MASTER_OWNER_APP_ID = 'master-lookup';

const HISTORY_KEY = 'merchHistory_v870';
// Capture the owner storage primitive before the MerchOps page hardens all
// public legacy writer aliases. Only this versioned adapter retains it.
const capturedOwnerCommitMasterState = globalThis.ONEAPP?.STORAGE?.commitMasterState;
const capturedOwnerReadMasterSnapshotState = globalThis.ONEAPP?.STORAGE?.readMasterSnapshotState;
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

// Explicit MerchOps registration is a narrow owner command. Operational Excel
// values such as quantity and business date deliberately remain in the active
// worktable and are not product-reference fields.
export const MERCHOPS_PRODUCT_REGISTRATION_FIELDS = Object.freeze([
  '코드', '품목코드', '품목명', '규격', '단위',
  '입고가', '구매처', '창고', '기본', '과세',
]);

const allowedPatchFields = new Set(MERCHOPS_REVIEWED_PATCH_FIELDS);
const allowedRegistrationFields = new Set(MERCHOPS_PRODUCT_REGISTRATION_FIELDS);
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

function normalizeRegistrationCode(value) {
  return clean(value).replace(/\s/g, '');
}

function validateRegistrationProduct(product, index) {
  const path = `products[${index}]`;
  if (!product || typeof product !== 'object' || Array.isArray(product)) {
    throw commandError('REGISTRATION_PRODUCT_OBJECT_REQUIRED', path);
  }
  const unknownFields = Object.keys(product).filter((field) => !allowedRegistrationFields.has(field));
  if (unknownFields.length > 0) {
    throw commandError('REGISTRATION_FIELD_NOT_ALLOWED', `${path}.${unknownFields[0]}`, { field: unknownFields[0] });
  }
  const primaryCode = normalizeRegistrationCode(product['코드']);
  const secondaryCode = normalizeRegistrationCode(product['품목코드']);
  const code = primaryCode || secondaryCode;
  if (!code) throw commandError('REGISTRATION_PRODUCT_CODE_REQUIRED', `${path}.코드`);
  if (primaryCode && secondaryCode && primaryCode !== secondaryCode) {
    throw commandError('REGISTRATION_PRODUCT_CODE_MISMATCH', path);
  }
  const normalized = cloneJson(product);
  normalized['코드'] = code;
  normalized['품목코드'] = code;
  for (const field of ['품목명', '규격', '단위']) {
    const value = clean(normalized[field]);
    if (!value) throw commandError('REGISTRATION_REQUIRED_FIELD_MISSING', `${path}.${field}`, { field, code });
    normalized[field] = value;
  }
  return normalized;
}

export function validateMerchOpsProductRegistrationCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw commandError('COMMAND_OBJECT_REQUIRED');
  }
  if (command.schemaVersion !== MERCHOPS_PRODUCT_REGISTRATION_COMMAND_SCHEMA_VERSION) {
    throw commandError('COMMAND_SCHEMA_INVALID');
  }
  if (clean(command.ownerAppId) !== PRODUCT_MASTER_OWNER_APP_ID) throw commandError('COMMAND_OWNER_INVALID');
  if (clean(command.sourceAppId) !== 'merchops') throw commandError('COMMAND_SOURCE_INVALID');
  if (!clean(command.operationId)) throw commandError('COMMAND_OPERATION_ID_REQUIRED');
  if (!clean(command.expectedRevision)) throw commandError('COMMAND_EXPECTED_REVISION_REQUIRED');
  if (!clean(command.baseSnapshotId)) throw commandError('COMMAND_BASE_SNAPSHOT_REQUIRED');
  if (!clean(command.baseContentHash)) throw commandError('COMMAND_BASE_HASH_REQUIRED');
  if (!clean(command.reason)) throw commandError('COMMAND_REASON_REQUIRED');
  if (!command.actor || !clean(command.actor.actorId) || !clean(command.actor.actorState)) {
    throw commandError('COMMAND_ACTOR_REQUIRED');
  }
  if (!Array.isArray(command.products) || command.products.length === 0) {
    throw commandError('COMMAND_PRODUCTS_REQUIRED');
  }
  const seen = new Set();
  const products = command.products.map((product, index) => {
    const normalized = validateRegistrationProduct(product, index);
    if (seen.has(normalized['코드'])) {
      throw commandError('DUPLICATE_REGISTRATION_PRODUCT_CODE', `중복 등록 상품코드: ${normalized['코드']}`);
    }
    seen.add(normalized['코드']);
    return normalized;
  });
  return deepFreeze({ ...cloneJson(command), products });
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
  let appended;
  if (typeof globalThis.persistMerchHistoryLogs === 'function') {
    appended = await globalThis.persistMerchHistoryLogs(logs, parseHistory(readHistoryRawDefault()));
  } else if (typeof globalThis.ONEAPP?.HISTORY?.addHistoryLogs === 'function') {
    appended = await globalThis.ONEAPP.HISTORY.addHistoryLogs(logs);
  } else {
    throw commandError('HISTORY_APPEND_NOT_AVAILABLE');
  }
  const persistedById = new Map(parseHistory(readHistoryRawDefault()).map((entry) => [clean(entry?.id), entry]));
  const metadataPreserved = logs.every((log) => {
    const persisted = persistedById.get(clean(log?.id));
    return persisted
      && clean(persisted.operationId) === clean(log.operationId)
      && clean(persisted.operationHash) === clean(log.operationHash);
  });
  if (!metadataPreserved) throw commandError('HISTORY_OPERATION_METADATA_VERIFY_FAILED');
  return appended;
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
    readMasterState: overrides.readMasterState
      || capturedOwnerReadMasterSnapshotState
      || globalThis.ONEAPP?.STORAGE?.readMasterSnapshotState,
    commitMasterState: overrides.commitMasterState
      || capturedOwnerCommitMasterState
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

async function resolveCommitExpectedRevision(dependencies, snapshotRevision) {
  if (typeof dependencies.readMasterState !== 'function') return snapshotRevision;
  const state = await dependencies.readMasterState();
  if (!state || !hasOwn(state, 'revision')) return snapshotRevision;
  const rawRevision = state.revision;
  const explicitRevision = rawRevision === undefined || rawRevision === null ? '' : clean(rawRevision);
  if (explicitRevision && explicitRevision !== clean(snapshotRevision)) {
    throw commandError('PRODUCT_REVISION_CONFLICT', '작업 시작 이후 상품 기준정보가 변경되었습니다.', {
      revision: explicitRevision,
    });
  }
  if (!explicitRevision && !clean(snapshotRevision).startsWith('HASH-')) {
    throw commandError('PRODUCT_REVISION_CONFLICT', '작업 시작 이후 상품 기준정보가 변경되었습니다.');
  }
  // Public snapshots normalize the version to a string, but legacy IndexedDB
  // data can still hold a numeric revision. Preserve its raw type for the
  // owner's strict compare-and-swap boundary without exposing it to MerchOps.
  return rawRevision;
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

function buildRegistrationHistoryLogs(command, operationHash, now) {
  const base = {
    operationId: command.operationId,
    operationHash,
    timestampISO: now,
    actorId: command.actor.actorId,
    actorState: command.actor.actorState,
    reason: command.reason,
    source: 'MerchOps 신규상품 등록',
    sourceRole: 'merchops',
    sourceLabel: 'MerchOps',
    applyMode: 'owner_command_apply',
    path: 'MerchOps > 미등록 상품 > 선택 상품 등록',
    route: 'MerchOps/미등록상품/상품등록',
  };
  const details = [];
  command.products.forEach((product, productIndex) => {
    const code = product['코드'];
    ['코드', ...MERCHOPS_PRODUCT_REGISTRATION_FIELDS.filter((field) => !['코드', '품목코드'].includes(field))]
      .filter((field) => hasOwn(product, field))
      .forEach((field, fieldIndex) => {
        details.push({
          ...base,
          id: `${command.operationId}:product:${productIndex + 1}:field:${fieldIndex + 1}`,
          recordType: 'master_add_update_detail',
          actionType: 'master_create',
          code,
          name: product['품목명'],
          spec: product['규격'],
          unit: product['단위'],
          field,
          oldVal: '',
          newVal: cloneJson(product[field]),
          finalValue: cloneJson(product[field]),
          memo: 'MerchOps 관리자 확인 신규상품 등록',
        });
      });
  });
  return [{
    ...base,
    id: `${command.operationId}:job`,
    recordType: 'master_add_update_job',
    actionType: 'merchops_product_registration_job',
    field: '작업',
    oldVal: '',
    newVal: '성공',
    createCount: command.products.length,
    status: 'success',
    memo: `MerchOps 신규상품 ${command.products.length}건 등록`,
  }, ...details];
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
    registrationCommandSchemaVersion: MERCHOPS_PRODUCT_REGISTRATION_COMMAND_SCHEMA_VERSION,
    ownerAppId: PRODUCT_MASTER_OWNER_APP_ID,
    allowedPatchFields: MERCHOPS_REVIEWED_PATCH_FIELDS,
    allowedRegistrationFields: MERCHOPS_PRODUCT_REGISTRATION_FIELDS,
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

      let commitExpectedRevision;
      try {
        commitExpectedRevision = await resolveCommitExpectedRevision(dependencies, command.expectedRevision);
      } catch (error) {
        return resultEnvelope({
          ok: false,
          status: error?.code === 'PRODUCT_REVISION_CONFLICT' ? 'CONFLICT' : 'ERROR',
          conflict: error?.code === 'PRODUCT_REVISION_CONFLICT',
          operationId: command.operationId,
          revision: clean(error?.revision),
          error: { code: error?.code || 'PRODUCT_REVISION_READ_FAILED', message: clean(error?.message) },
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
        expectedRevision: commitExpectedRevision,
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
    async registerMerchOpsProducts(input) {
      const envelope = (values = {}) => resultEnvelope({
        commandSchemaVersion: MERCHOPS_PRODUCT_REGISTRATION_COMMAND_SCHEMA_VERSION,
        ...values,
      });
      let command;
      try {
        command = validateMerchOpsProductRegistrationCommand(input);
      } catch (error) {
        return envelope({
          ok: false,
          status: 'REJECTED',
          error: { code: error.code || 'COMMAND_REJECTED', message: clean(error.message) },
          rollback: { attempted: false, master: false, history: false, linkedState: true },
        });
      }

      const dependencies = defaultDependencies(dependencyOverrides);
      if (typeof dependencies.commitMasterState !== 'function') {
        return envelope({
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
        products: command.products,
      });
      const previousHistoryRaw = await dependencies.readHistoryRaw();
      const priorOperation = operationHistoryState(parseHistory(previousHistoryRaw), command.operationId, operationHash);
      const beforeSnapshotResult = await dependencies.readSnapshotResult();
      if (beforeSnapshotResult?.status === 'ERROR' || !beforeSnapshotResult?.snapshot) {
        return envelope({
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
        return envelope({
          ok: false,
          status: 'REJECTED',
          operationId: command.operationId,
          error: { code: error.code || 'PRODUCT_SNAPSHOT_INVALID', message: clean(error.message) },
          rollback: { attempted: false, master: false, history: false, linkedState: true },
        });
      }

      if (priorOperation.found) {
        if (priorOperation.conflict) {
          return envelope({
            ok: false,
            status: 'CONFLICT',
            conflict: true,
            operationId: command.operationId,
            error: { code: 'OPERATION_ID_CONFLICT', message: '같은 operation ID에 다른 등록 내용이 기록되어 있습니다.' },
            rollback: { attempted: false, master: false, history: false, linkedState: true },
          });
        }
        const applied = command.products.every((product) => {
          const current = masterMap[product['코드']];
          return current && Object.keys(product).every((field) => sameValue(current[field], product[field]));
        });
        if (applied) {
          return envelope({
            ok: true,
            status: 'DUPLICATE',
            duplicate: true,
            operationId: command.operationId,
            revision: beforeSnapshot.snapshotVersion,
            rowCount: Object.keys(masterMap).length,
            createdCount: command.products.length,
            historyCount: priorOperation.rows.length,
            actorState: command.actor.actorState,
            registeredProducts: command.products,
            snapshot: beforeSnapshot,
            rollback: { attempted: false, master: false, history: false, linkedState: true },
          });
        }
      }

      const revisionConflict = beforeSnapshot.schemaVersion !== PRODUCT_SNAPSHOT_SCHEMA_VERSION
        || beforeSnapshot.snapshotVersion !== command.expectedRevision
        || beforeSnapshot.snapshotId !== command.baseSnapshotId
        || beforeSnapshot.contentHash !== command.baseContentHash;
      if (revisionConflict) {
        return envelope({
          ok: false,
          status: 'CONFLICT',
          conflict: true,
          operationId: command.operationId,
          revision: beforeSnapshot.snapshotVersion,
          error: { code: 'PRODUCT_SNAPSHOT_CONFLICT', message: '작업 시작 Snapshot과 현재 상품 기준정보가 다릅니다.' },
          rollback: { attempted: false, master: false, history: false, linkedState: true },
        });
      }

      const existingCodesByNormalizedCode = new Map(Object.entries(masterMap).map(([masterKey, product]) => [
        normalizeRegistrationCode(productCodeOf(product) || masterKey),
        productCodeOf(product) || masterKey,
      ]));
      const existingCodes = command.products
        .map((product) => product['코드'])
        .filter((code) => existingCodesByNormalizedCode.has(normalizeRegistrationCode(code)))
        .map((code) => existingCodesByNormalizedCode.get(normalizeRegistrationCode(code)));
      if (existingCodes.length > 0) {
        return envelope({
          ok: false,
          status: 'CONFLICT',
          conflict: true,
          operationId: command.operationId,
          revision: beforeSnapshot.snapshotVersion,
          error: { code: 'REGISTRATION_PRODUCT_ALREADY_EXISTS', message: `이미 등록된 상품코드: ${existingCodes.join(', ')}` },
          rollback: { attempted: false, master: false, history: false, linkedState: true },
        });
      }

      let commitExpectedRevision;
      try {
        commitExpectedRevision = await resolveCommitExpectedRevision(dependencies, command.expectedRevision);
      } catch (error) {
        return envelope({
          ok: false,
          status: error?.code === 'PRODUCT_REVISION_CONFLICT' ? 'CONFLICT' : 'ERROR',
          conflict: error?.code === 'PRODUCT_REVISION_CONFLICT',
          operationId: command.operationId,
          revision: clean(error?.revision),
          error: { code: error?.code || 'PRODUCT_REVISION_READ_FAILED', message: clean(error?.message) },
          rollback: { attempted: false, master: false, history: false, linkedState: true },
        });
      }

      const previousMasterMap = cloneJson(masterMap);
      for (const product of command.products) masterMap[product['코드']] = cloneJson(product);
      const previousLinkedState = await dependencies.readLinkedState();
      const historyLogs = buildRegistrationHistoryLogs(command, operationHash, dependencies.now());
      let historyRestored = false;
      let linkedStatePreserved = true;
      const expectedRowCount = Object.keys(previousMasterMap).length + command.products.length;
      const commitResult = await dependencies.commitMasterState(masterMap, {
        expectedRevision: commitExpectedRevision,
        afterVerifiedError: '신규상품 등록 후속 검증 또는 history 저장 실패',
        afterVerified: async () => {
          const verifiedSnapshotResult = await dependencies.readSnapshotResult();
          if (verifiedSnapshotResult?.status !== 'READY' || !verifiedSnapshotResult.snapshot) {
            throw commandError('POST_COMMIT_SNAPSHOT_VERIFY_FAILED');
          }
          const verifiedMap = productsToMap(verifiedSnapshotResult.snapshot.data?.products);
          if (Object.keys(verifiedMap).length !== expectedRowCount) throw commandError('POST_COMMIT_ROW_COUNT_MISMATCH');
          for (const product of command.products) {
            const registered = verifiedMap[product['코드']];
            if (!registered || !Object.keys(product).every((field) => sameValue(registered[field], product[field]))) {
              throw commandError('POST_COMMIT_REGISTRATION_VERIFY_FAILED', product['코드']);
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
        return envelope({
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
        && command.products.every((product) => {
          const registered = finalMap[product['코드']];
          return registered && Object.keys(product).every((field) => sameValue(registered[field], product[field]));
        });
      if (!finalVerified) {
        const rollbackResult = await dependencies.commitMasterState(previousMasterMap, {
          expectedRevision: commitResult.revision,
          afterVerifiedError: '신규상품 등록 최종 검산 rollback 후속 검증 실패',
          afterVerified: async () => {
            const rollbackSnapshotResult = await dependencies.readSnapshotResult();
            const rollbackMap = rollbackSnapshotResult?.snapshot
              ? productsToMap(rollbackSnapshotResult.snapshot.data?.products)
              : {};
            if (!['READY', 'EMPTY'].includes(rollbackSnapshotResult?.status) || !sameValue(rollbackMap, previousMasterMap)) {
              throw commandError('FINAL_ROLLBACK_MASTER_VERIFY_FAILED');
            }
            const rollbackLinkedState = await dependencies.readLinkedState();
            if (!sameValue(previousLinkedState, rollbackLinkedState)) throw commandError('FINAL_ROLLBACK_LINKED_STATE_CHANGED');
            await dependencies.restoreHistoryRaw(previousHistoryRaw);
            return true;
          },
        });
        return envelope({
          ok: false,
          status: 'ERROR',
          operationId: command.operationId,
          revision: rollbackResult?.revision || commitResult.revision,
          error: { code: 'FINAL_PRODUCT_REGISTRATION_VERIFY_FAILED', message: '신규상품 저장 결과 최종 검산에 실패했습니다.' },
          rollback: {
            attempted: true,
            master: !!rollbackResult?.ok,
            history: sameValue(previousHistoryRaw, await dependencies.readHistoryRaw()),
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
        console.warn('[Product Master Registration] sync notification failed', error);
      }

      return envelope({
        ok: true,
        status: 'APPLIED',
        operationId: command.operationId,
        previousRevision: command.expectedRevision,
        revision: commitResult.revision,
        rowCount: expectedRowCount,
        createdCount: command.products.length,
        historyCount: historyLogs.length,
        actorState: command.actor.actorState,
        registeredProducts: command.products,
        snapshot: finalSnapshot,
        rollback: { attempted: false, master: false, history: false, linkedState: linkedStatePreserved },
      });
    },
  });
}

export const productMasterCommandAdapter = createProductMasterCommandAdapter();

globalThis.ONEAPP_PRODUCT_MASTER_COMMAND_ADAPTER_V1 = productMasterCommandAdapter;
globalThis.ONEAPP_PRODUCT_MASTER_COMMAND_ADAPTER = productMasterCommandAdapter;
