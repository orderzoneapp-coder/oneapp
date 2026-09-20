import { cloneJson, deepFreeze, sha256Hex } from '../reference-data/change-request-contract.js';
import { loadSettingValue, saveSettingValue } from './smartinput-data-store.js?v=0.15.0';

const SCHEMA = 'ONEAPP_ORDERQ_INPUT_MATCHING_SNAPSHOT_V1';
const text = value => String(value ?? '').trim();
const requests = new Map(), writes = new Map();
const failure = error => ({ status: 'ERROR', error: { code: 'INPUT_MATCHING_SNAPSHOT_FAILED', message: error?.message || String(error) } });
const stale = () => ({ status: 'STALE', error: { code: 'INPUT_MATCHING_SCOPE_CHANGED', message: '입력 기준을 요청한 회사·사용자 또는 갱신 요청이 변경되었습니다.' } });

function scopeKey({ companyId, actorId } = {}) {
  if (!text(companyId) || !text(actorId)) throw new Error('INPUT_MATCHING_SCOPE_REQUIRED');
  return `inputMatchingSnapshot:v1:${encodeURIComponent(text(companyId))}:${encodeURIComponent(text(actorId))}`;
}

export async function validateInputMatchingSnapshot(value, scope) {
  scopeKey(scope);
  const snapshot = cloneJson(value);
  if (!snapshot || snapshot.schemaVersion !== SCHEMA || snapshot.ownerAppId !== 'orderq-vnext'
    || snapshot.sourceDatabase !== 'oneapp-orderq-pre-m1-v6' || snapshot.legacyDefaultCompanyId !== 'ONEAPP'
    || snapshot.companyId !== text(scope.companyId) || snapshot.actorId !== text(scope.actorId)
    || !snapshot.readAt || Number.isNaN(Date.parse(snapshot.readAt))) throw new Error('INPUT_MATCHING_SNAPSHOT_SCOPE_INVALID');
  for (const field of ['products', 'mappings', 'history']) {
    if (!Array.isArray(snapshot[field]) || snapshot.counts?.[field] !== snapshot[field].length
      || snapshot[field].some(row => !row || row.companyId !== snapshot.companyId)) throw new Error('INPUT_MATCHING_SNAPSHOT_ROWS_INVALID');
  }
  const { contentHash, readAt, ...content } = snapshot;
  if (!contentHash || await sha256Hex(content) !== contentHash) throw new Error('INPUT_MATCHING_SNAPSHOT_HASH_INVALID');
  return deepFreeze(snapshot);
}

function result(snapshot) {
  return { status: snapshot.products.length || snapshot.mappings.length || snapshot.history.length ? 'READY' : 'EMPTY', snapshot };
}

// Startup and ordinary intake read only the SmartInput-owned cache. Owner code is
// loaded exclusively by the explicit refresh below; this is never an owner writer.
export async function loadLocalInputMatchingSnapshot(scope, { loadValue = loadSettingValue, isCurrent = () => true } = {}) {
  try {
    if (!isCurrent()) return stale();
    const value = await loadValue(scopeKey(scope));
    if (!isCurrent()) return stale();
    if (value === null || value === undefined) return { status: 'NOT_PREPARED', snapshot: null };
    const snapshot = await validateInputMatchingSnapshot(value, scope);
    return isCurrent() ? result(snapshot) : stale();
  } catch (error) { return failure(error); }
}

export async function refreshInputMatchingSnapshot(scope, {
  readOwner = async request => (await import('../orderq/input-matching-read-adapter.js?v=0.1.0')).readInputMatchingSnapshot(request),
  saveValue = saveSettingValue, isCurrent = () => true
} = {}) {
  try {
    const key = scopeKey(scope), requestId = (requests.get(key) || 0) + 1;
    requests.set(key, requestId);
    const current = () => isCurrent() && requests.get(key) === requestId;
    if (!current()) return stale();
    const response = await readOwner({ companyId: text(scope.companyId), actorId: text(scope.actorId) });
    if (!current()) return stale();
    if (!['READY', 'EMPTY'].includes(response?.status)) throw new Error(response?.error?.message || 'INPUT_MATCHING_OWNER_NOT_READY');
    const snapshot = await validateInputMatchingSnapshot(response.snapshot, scope);
    if (result(snapshot).status !== response.status) throw new Error('INPUT_MATCHING_OWNER_STATUS_INVALID');
    // Serialize writes per scope so an older in-flight write cannot replace a
    // newer refresh. Recheck actor/company both before persistence and activation.
    const pending = (writes.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
      if (!current()) return stale();
      await saveValue(key, snapshot);
      return current() ? result(snapshot) : stale();
    });
    writes.set(key, pending);
    try { return await pending; }
    finally { if (writes.get(key) === pending) writes.delete(key); }
  } catch (error) { return failure(error); }
}

export function inputContextFromMatchingSnapshot(snapshot, fallback) {
  if (!snapshot || snapshot.companyId !== fallback.companyId || snapshot.actorId !== fallback.actorId) return fallback;
  return { ...fallback, products: snapshot.products, mappings: snapshot.mappings, history: snapshot.history, revision: snapshot.contentHash };
}

export function inputMatchingAnalysisRevision(snapshot, fallback) {
  const scoped = snapshot && snapshot.companyId === fallback.companyId && snapshot.actorId === fallback.actorId;
  return JSON.stringify([fallback.companyId, fallback.actorId, scoped ? snapshot.contentHash : null, fallback.revision || '']);
}

export function canReuseInputAnalysis(batch, { contentHash, matchingRevision, automatic = false }) {
  // A refreshed snapshot never rewrites existing work merely because an automatic
  // analysis is scheduled. Explicit analysis may apply a new matching revision.
  return Boolean(batch?.contentHash && batch.contentHash === contentHash
    && (automatic || batch.inputMatchingRevision === matchingRevision));
}
