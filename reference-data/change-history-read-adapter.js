import { cloneJson, deepFreeze, sha256Hex, stableStringify } from './change-request-contract.js';

export const CHANGE_HISTORY_SNAPSHOT_SCHEMA_VERSION = 'ONEAPP_CHANGE_HISTORY_SNAPSHOT_V1';
export const CHANGE_HISTORY_READ_ADAPTER_VERSION = 'ONEAPP_CHANGE_HISTORY_READ_ADAPTER_V1';
export const CHANGE_HISTORY_OWNER_APP_ID = 'master-lookup';

const HISTORY_KEY = 'merchHistory_v870';

function clean(value) {
  return String(value ?? '').trim();
}

function normalizeHistoryValue(value) {
  let rows;
  if (Array.isArray(value)) rows = value;
  else if (value && typeof value === 'object' && Array.isArray(value.logs)) rows = value.logs;
  else if (value && typeof value === 'object') rows = Object.values(value).flat();
  else throw new Error('CHANGE_HISTORY_SCHEMA_INVALID');

  if (rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new Error('CHANGE_HISTORY_ROW_INVALID');
  }
  return cloneJson(rows);
}

function historyTime(row) {
  const value = row?.timestampISO ?? row?.createdAtISO ?? row?.savedAtISO
    ?? row?.timestamp ?? row?.time ?? row?.date ?? '';
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function historyIdentity(row) {
  const id = clean(row?.id);
  if (id) return `ID:${id}`;
  return `VALUE:${stableStringify(row)}`;
}

export async function buildChangeHistorySnapshot(value, options = {}) {
  const history = normalizeHistoryValue(value);
  const data = { history };
  const contentHash = await sha256Hex(data);
  const explicitRevision = clean(options.revision);
  const revision = explicitRevision || `HASH-${contentHash}`;
  return deepFreeze({
    schemaVersion: CHANGE_HISTORY_SNAPSHOT_SCHEMA_VERSION,
    adapterVersion: CHANGE_HISTORY_READ_ADAPTER_VERSION,
    ownerAppId: CHANGE_HISTORY_OWNER_APP_ID,
    status: history.length > 0 ? 'READY' : 'EMPTY',
    snapshotId: `CHANGE-HISTORY-${revision}-${contentHash.slice(0, 12)}`,
    revision,
    contentHash,
    count: history.length,
    source: clean(options.source) || 'LOCAL_STORAGE',
    capturedAt: options.now || new Date().toISOString(),
    data,
  });
}

export async function mergeChangeHistorySnapshots(snapshots = [], options = {}) {
  const usable = snapshots.filter((snapshot) => snapshot
    && snapshot.schemaVersion === CHANGE_HISTORY_SNAPSHOT_SCHEMA_VERSION
    && Array.isArray(snapshot.data?.history));
  const unique = new Map();
  usable.forEach((snapshot) => {
    snapshot.data.history.forEach((row) => {
      const key = historyIdentity(row);
      if (!unique.has(key)) unique.set(key, cloneJson(row));
    });
  });
  const merged = [...unique.values()].sort((left, right) => (
    historyTime(right) - historyTime(left)
    || stableStringify(left).localeCompare(stableStringify(right), 'ko')
  ));
  return buildChangeHistorySnapshot(merged, {
    ...options,
    source: clean(options.source) || usable.map((snapshot) => snapshot.source).join('+') || 'MEMORY_VIEW',
  });
}

function formattedError(error) {
  return deepFreeze({
    code: clean(error?.message) || 'CHANGE_HISTORY_READ_FAILED',
    message: '상품 변경이력 Snapshot을 읽지 못했습니다.',
    retryable: true,
  });
}

export async function getChangeHistorySnapshotResult(options = {}) {
  const storage = options.storage || globalThis.localStorage;
  if (!storage || typeof storage.getItem !== 'function') {
    return deepFreeze({
      status: 'NOT_AVAILABLE',
      snapshot: null,
      error: { code: 'CHANGE_HISTORY_STORAGE_NOT_AVAILABLE', message: '변경이력 저장소를 사용할 수 없습니다.', retryable: true },
    });
  }
  let raw;
  try {
    raw = storage.getItem(HISTORY_KEY);
  } catch (error) {
    return deepFreeze({ status: 'ERROR', snapshot: null, error: formattedError(error) });
  }
  if (raw === null) {
    return deepFreeze({
      status: 'NOT_AVAILABLE',
      snapshot: null,
      error: { code: 'CHANGE_HISTORY_KEY_NOT_AVAILABLE', message: '변경이력 키가 아직 없습니다.', retryable: false },
    });
  }
  try {
    const parsed = JSON.parse(raw);
    const snapshot = await buildChangeHistorySnapshot(parsed, {
      now: options.now,
      source: 'LOCAL_STORAGE',
    });
    return deepFreeze({ status: snapshot.status, snapshot, error: null });
  } catch (error) {
    return deepFreeze({ status: 'ERROR', snapshot: null, error: formattedError(error) });
  }
}

export async function getChangeHistorySnapshot(options = {}) {
  const result = await getChangeHistorySnapshotResult(options);
  if (!result.snapshot) {
    const error = new Error(result.error?.message || '변경이력 Snapshot을 사용할 수 없습니다.');
    error.code = result.error?.code || result.status;
    error.retryable = result.error?.retryable === true;
    throw error;
  }
  return result.snapshot;
}

export const changeHistoryReadAdapter = deepFreeze({
  version: CHANGE_HISTORY_READ_ADAPTER_VERSION,
  schemaVersion: CHANGE_HISTORY_SNAPSHOT_SCHEMA_VERSION,
  ownerAppId: CHANGE_HISTORY_OWNER_APP_ID,
  storageKey: HISTORY_KEY,
  getSnapshot: getChangeHistorySnapshot,
  getSnapshotResult: getChangeHistorySnapshotResult,
  buildSnapshot: buildChangeHistorySnapshot,
  mergeSnapshots: mergeChangeHistorySnapshots,
});

globalThis.ONEAPP_CHANGE_HISTORY_READ_ADAPTER_V1 = changeHistoryReadAdapter;
