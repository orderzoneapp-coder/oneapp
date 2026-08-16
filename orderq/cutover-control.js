import { runtimeStorageKey } from './admin-test-runtime.js?v=0.10.2';

export const ORDERQ_CUTOVER_STORAGE_KEY = 'oneapp.orderq.cutover.control.v1';
export const ORDERQ_ADMIN_TEST_CUTOVER_STORAGE_KEY = 'oneapp.orderq.admin-test.cutover.control.v1';

export const CUTOVER_MODE = Object.freeze({
  LEGACY_PRIMARY: 'LEGACY_PRIMARY',
  SHADOW: 'SHADOW',
  PILOT_WRITE: 'PILOT_WRITE',
  VNEXT_PRIMARY: 'VNEXT_PRIMARY'
});

export const CUTOVER_WRITE_MODES = Object.freeze([
  CUTOVER_MODE.PILOT_WRITE,
  CUTOVER_MODE.VNEXT_PRIMARY
]);

const MODE_SET = new Set(Object.values(CUTOVER_MODE));

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function storageOrDefault(storage) {
  const result = storage || globalThis.localStorage;
  if (!result || typeof result.getItem !== 'function' || typeof result.setItem !== 'function') {
    throw new Error('ORDERQ_CUTOVER_STORAGE_UNAVAILABLE');
  }
  return result;
}

function defaultControl() {
  return {
    schemaVersion: 'ORDERQ_CUTOVER_CONTROL_V1',
    mode: CUTOVER_MODE.SHADOW,
    revision: 0,
    updatedAt: '',
    updatedBy: '',
    reasonCode: 'SAFE_DEFAULT',
    reasonNote: '',
    history: []
  };
}

export function normalizeCutoverMode(value) {
  const mode = text(value).toUpperCase();
  return MODE_SET.has(mode) ? mode : CUTOVER_MODE.SHADOW;
}

export function isOfficialWriteMode(value) {
  return CUTOVER_WRITE_MODES.includes(normalizeCutoverMode(value));
}

export function readCutoverControl(storage) {
  const target = storageOrDefault(storage);
  const key = runtimeStorageKey(ORDERQ_CUTOVER_STORAGE_KEY, ORDERQ_ADMIN_TEST_CUTOVER_STORAGE_KEY);
  const raw = target.getItem(key);
  if (!raw) return defaultControl();
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultControl();
    return {
      ...defaultControl(),
      ...parsed,
      mode: normalizeCutoverMode(parsed.mode),
      revision: Math.max(0, Number(parsed.revision || 0)),
      history: Array.isArray(parsed.history) ? parsed.history.slice(-100) : []
    };
  } catch {
    return defaultControl();
  }
}

export function setCutoverMode({
  mode,
  actorId,
  reasonCode,
  reasonNote = '',
  expectedRevision,
  storage,
  changedAt = new Date().toISOString()
} = {}) {
  const target = storageOrDefault(storage);
  const key = runtimeStorageKey(ORDERQ_CUTOVER_STORAGE_KEY, ORDERQ_ADMIN_TEST_CUTOVER_STORAGE_KEY);
  const requestedMode = normalizeCutoverMode(mode);
  if (requestedMode !== text(mode).toUpperCase()) throw new Error(`ORDERQ_CUTOVER_MODE_INVALID:${text(mode)}`);
  const actor = text(actorId);
  const reason = text(reasonCode);
  if (!actor) throw new Error('ORDERQ_CUTOVER_ACTOR_REQUIRED');
  if (!reason) throw new Error('ORDERQ_CUTOVER_REASON_REQUIRED');
  const current = readCutoverControl(target);
  if (expectedRevision !== undefined && Number(expectedRevision) !== current.revision) {
    throw new Error(`ORDERQ_CUTOVER_REVISION_CONFLICT:${current.revision}`);
  }
  const event = {
    eventId: `CUTOVER-${current.revision + 1}`,
    fromMode: current.mode,
    toMode: requestedMode,
    actorId: actor,
    changedAt: text(changedAt),
    reasonCode: reason,
    reasonNote: text(reasonNote)
  };
  const next = {
    schemaVersion: 'ORDERQ_CUTOVER_CONTROL_V1',
    mode: requestedMode,
    revision: current.revision + 1,
    updatedAt: event.changedAt,
    updatedBy: actor,
    reasonCode: reason,
    reasonNote: event.reasonNote,
    history: [...current.history, event].slice(-100)
  };
  target.setItem(key, JSON.stringify(next));
  return next;
}

export function assertLocalOfficialWriteEnabled(commandType, storage) {
  const control = readCutoverControl(storage);
  if (!isOfficialWriteMode(control.mode)) {
    throw new Error(`ORDERQ_CUTOVER_LOCAL_WRITE_BLOCKED:${control.mode}:${text(commandType).toUpperCase()}`);
  }
  return control;
}

export function evaluateCutoverBoundary(localMode, centralMode) {
  const local = normalizeCutoverMode(localMode);
  const central = normalizeCutoverMode(centralMode);
  const localWrite = isOfficialWriteMode(local);
  const centralWrite = isOfficialWriteMode(central);
  return {
    localMode: local,
    centralMode: central,
    writeAllowed: localWrite && centralWrite,
    mismatch: localWrite !== centralWrite || (localWrite && local !== central),
    reasonCode: !localWrite ? 'LOCAL_MODE_BLOCKED'
      : !centralWrite ? 'CENTRAL_MODE_BLOCKED'
        : local !== central ? 'MODE_MISMATCH' : 'WRITE_ALLOWED'
  };
}

export function cutoverRoute(mode) {
  return normalizeCutoverMode(mode) === CUTOVER_MODE.LEGACY_PRIMARY
    ? '../orderops/list.html'
    : './index.html';
}
