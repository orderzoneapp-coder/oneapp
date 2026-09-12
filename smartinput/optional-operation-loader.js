export const OPTIONAL_OPERATION_TIMEOUT_MS = Object.freeze({
  externalScript: 15_000,
  localModule: 5_000,
  externalReference: 7_000,
  estimateList: 2_500,
  capability: 5_000
});

export const OPTIONAL_OPERATION_ERROR_CODE = Object.freeze({
  TIMEOUT: 'OPTIONAL_OPERATION_TIMEOUT',
  NETWORK: 'OPTIONAL_OPERATION_NETWORK_ERROR',
  EVALUATION: 'OPTIONAL_OPERATION_EVALUATION_ERROR',
  GLOBAL_MISSING: 'OPTIONAL_OPERATION_GLOBAL_MISSING',
  STALE: 'OPTIONAL_OPERATION_STALE',
  RESULT_UNKNOWN: 'RESULT_UNKNOWN',
  RESULT_LOOKUP_FAILED: 'RESULT_LOOKUP_FAILED'
});

export class OptionalOperationError extends Error {
  constructor(message, {
    code,
    feature = '',
    assetVersion = '',
    attemptId = '',
    commandId = '',
    retryable = true,
    cause
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'OptionalOperationError';
    this.code = code || 'OPTIONAL_OPERATION_ERROR';
    this.feature = feature;
    this.assetVersion = assetVersion;
    this.attemptId = attemptId;
    this.commandId = commandId;
    this.retryable = retryable;
    if (cause && !this.cause) this.cause = cause;
  }
}

const value = input => String(input ?? '').trim();
const positiveTimeout = (input, fallback) => {
  const normalized = Number(input);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
};

const cloneValue = input => {
  if (input === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(input);
  return JSON.parse(JSON.stringify(input));
};

const valuesEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const arrayEntryKey = input => {
  if (!input || typeof input !== 'object') return `${typeof input}:${JSON.stringify(input)}`;
  for (const field of ['id', 'rowId', 'fieldId', 'customFieldId', 'key', 'date', 'value']) {
    if (input[field] !== undefined && input[field] !== null && String(input[field]).trim()) {
      return `record:${field}:${String(input[field])}`;
    }
  }
  return `record:json:${JSON.stringify(input)}`;
};
const indexedArrayEntries = input => {
  const occurrences = new Map();
  return (Array.isArray(input) ? input : []).map(entry => {
    const key = arrayEntryKey(entry);
    const occurrence = (occurrences.get(key) || 0) + 1;
    occurrences.set(key, occurrence);
    return { id: `${key}#${occurrence}`, value: entry };
  });
};

function mergeHydratedArray(baseline, live, loaded) {
  const baselineEntries = indexedArrayEntries(baseline);
  const liveEntries = indexedArrayEntries(live);
  const loadedEntries = indexedArrayEntries(loaded);
  const baselineById = new Map(baselineEntries.map(entry => [entry.id, entry.value]));
  const liveById = new Map(liveEntries.map(entry => [entry.id, entry.value]));
  const loadedById = new Map(loadedEntries.map(entry => [entry.id, entry.value]));
  const explicitlyRemoved = new Set(baselineEntries
    .filter(entry => !liveById.has(entry.id))
    .map(entry => entry.id));
  const retainedLoaded = loadedEntries.filter(entry => !explicitlyRemoved.has(entry.id));
  const retainedLoadedIds = new Set(retainedLoaded.map(entry => entry.id));
  const visibleLive = liveEntries.filter(entry => {
    if (!baselineById.has(entry.id)) return true;
    if (loadedById.has(entry.id)) return true;
    return !valuesEqual(entry.value, baselineById.get(entry.id));
  });
  const liveIds = new Set(visibleLive.map(entry => entry.id));
  const output = visibleLive.map(entry => ({
    id: entry.id,
    value: loadedById.has(entry.id)
      ? mergeHydratedSnapshotPreservingLiveChanges(
        baselineById.get(entry.id),
        entry.value,
        loadedById.get(entry.id)
      )
      : cloneValue(entry.value)
  }));

  for (let index = 0; index < retainedLoaded.length;) {
    if (liveIds.has(retainedLoaded[index].id)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < retainedLoaded.length && !liveIds.has(retainedLoaded[index].id)) index += 1;
    const run = retainedLoaded.slice(start, index).map(entry => ({ id: entry.id, value: cloneValue(entry.value) }));
    let previousId = '';
    for (let prior = start - 1; prior >= 0; prior -= 1) {
      if (liveIds.has(retainedLoaded[prior].id)) {
        previousId = retainedLoaded[prior].id;
        break;
      }
    }
    let nextId = '';
    for (let next = index; next < retainedLoaded.length; next += 1) {
      if (liveIds.has(retainedLoaded[next].id)) {
        nextId = retainedLoaded[next].id;
        break;
      }
    }
    const previousIndex = previousId ? output.findIndex(entry => entry.id === previousId) : -1;
    const nextIndex = nextId ? output.findIndex(entry => entry.id === nextId) : -1;
    const insertionIndex = previousIndex >= 0 ? previousIndex + 1 : (nextIndex >= 0 ? nextIndex : output.length);
    output.splice(insertionIndex, 0, ...run);
  }

  return output
    .filter(entry => liveIds.has(entry.id) || retainedLoadedIds.has(entry.id))
    .map(entry => entry.value);
}

export function mergeHydratedSnapshotPreservingLiveChanges(baseline, live, loaded) {
  if (valuesEqual(live, baseline)) return cloneValue(loaded);
  if (Array.isArray(live) && Array.isArray(loaded)) {
    return mergeHydratedArray(Array.isArray(baseline) ? baseline : [], live, loaded);
  }
  const isRecord = input => input && typeof input === 'object' && !Array.isArray(input);
  if (!isRecord(live) || !isRecord(loaded)) return cloneValue(live);
  const baselineRecord = isRecord(baseline) ? baseline : {};
  return Object.fromEntries([...new Set([
    ...Object.keys(baselineRecord),
    ...Object.keys(live),
    ...Object.keys(loaded)
  ])].map(key => [key, mergeHydratedSnapshotPreservingLiveChanges(
    baselineRecord[key],
    live[key],
    loaded[key]
  )]));
}

export function createHydrationWriteGate({
  write,
  normalize = cloneValue,
  unavailableMessage = '기존 자료를 불러오지 못해 변경 내용을 저장하지 않았습니다.'
} = {}) {
  if (typeof write !== 'function') throw new TypeError('write가 필요합니다.');
  let hydrationResult = null;
  let resolveHydration;
  let hydration;
  let writeQueue = Promise.resolve();

  const startHydrationCycle = () => {
    hydrationResult = null;
    hydration = new Promise(resolve => { resolveHydration = resolve; });
  };
  startHydrationCycle();

  const settle = result => {
    if (hydrationResult) return hydrationResult;
    hydrationResult = Object.freeze(result);
    resolveHydration(hydrationResult);
    return hydrationResult;
  };
  const enqueue = input => {
    const snapshot = normalize(cloneValue(typeof input === 'function' ? input() : input));
    const pending = writeQueue.then(() => write(snapshot));
    writeQueue = pending.catch(() => {});
    return pending.then(() => snapshot);
  };
  const persist = async getCurrent => {
    const currentHydration = hydration;
    const result = await currentHydration;
    if (result.status !== 'READY') throw new Error(unavailableMessage, { cause: result.error || undefined });
    return enqueue(getCurrent);
  };

  const beginRetry = () => {
    if (hydrationResult?.status !== 'ERROR') return hydrationResult?.status || 'LOADING';
    startHydrationCycle();
    return 'LOADING';
  };

  return Object.freeze({
    settleReady: () => settle({ status: 'READY', error: null }),
    settleError: error => settle({ status: 'ERROR', error: error || null }),
    beginRetry,
    enqueue,
    persist,
    status: () => hydrationResult?.status || 'LOADING'
  });
}

function moduleFailureCode(error) {
  const code = value(error?.code).toUpperCase();
  const message = value(error?.message).toLowerCase();
  if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(code)
    || /failed to fetch dynamically imported module|error loading dynamically imported module|cannot find module|module not found|failed to resolve module specifier/.test(message)) {
    return OPTIONAL_OPERATION_ERROR_CODE.NETWORK;
  }
  return OPTIONAL_OPERATION_ERROR_CODE.EVALUATION;
}

function moduleFailureMessage(error, fallback) {
  if (value(fallback)) return value(fallback);
  if (moduleFailureCode(error) === OPTIONAL_OPERATION_ERROR_CODE.NETWORK) {
    return '선택 기능 모듈을 불러오지 못했습니다.';
  }
  return '선택 기능 모듈을 실행하지 못했습니다.';
}

export function isOptionalOperationStale(error) {
  return error?.code === OPTIONAL_OPERATION_ERROR_CODE.STALE;
}

export function isOptionalAssetLoadFailure(error) {
  return [
    OPTIONAL_OPERATION_ERROR_CODE.TIMEOUT,
    OPTIONAL_OPERATION_ERROR_CODE.NETWORK,
    OPTIONAL_OPERATION_ERROR_CODE.EVALUATION,
    OPTIONAL_OPERATION_ERROR_CODE.GLOBAL_MISSING
  ].includes(error?.code);
}

export function createOptionalOperationLoader({
  globalScope = globalThis,
  documentRef = globalThis.document,
  importModule = specifier => import(specifier),
  schedule = globalThis.setTimeout?.bind(globalThis),
  cancel = globalThis.clearTimeout?.bind(globalThis)
} = {}) {
  const assetCache = new Map();
  const currentOperations = new Map();
  let attemptSequence = 0;

  const nextAttemptId = prefix => `${prefix}-${++attemptSequence}`;
  const cacheKey = ({ kind, feature, assetVersion, location }) => [kind, feature, assetVersion, location].map(value).join('|');
  const clearOwnFailedAttempt = (key, entry) => {
    if (assetCache.get(key) === entry) assetCache.delete(key);
  };

  function loadScript({
    feature,
    assetVersion,
    url,
    globalName,
    timeoutMs = OPTIONAL_OPERATION_TIMEOUT_MS.externalScript,
    unavailableMessage = '선택 기능을 불러오지 못했습니다.'
  }) {
    const liveGlobal = globalScope?.[globalName];
    if (liveGlobal) return Promise.resolve(liveGlobal);
    if (!documentRef?.createElement || !documentRef?.head?.append) {
      return Promise.reject(new OptionalOperationError(unavailableMessage, {
        code: OPTIONAL_OPERATION_ERROR_CODE.NETWORK,
        feature,
        assetVersion,
        retryable: true
      }));
    }

    const key = cacheKey({ kind: 'script', feature, assetVersion, location: url });
    const cached = assetCache.get(key);
    if (cached) return cached.promise;

    const attemptId = nextAttemptId('asset');
    let begin;
    const entry = { attemptId, promise: null };
    const promise = new Promise((resolve, reject) => {
      begin = () => {
        const script = documentRef.createElement('script');
        let timer = null;
        let settled = false;
        const cleanup = removeScript => {
          if (timer !== null) cancel?.(timer);
          timer = null;
          script.onload = null;
          script.onerror = null;
          if (removeScript) script.remove?.();
        };
        const fail = (code, cause) => {
          if (settled) return;
          settled = true;
          cleanup(true);
          clearOwnFailedAttempt(key, entry);
          reject(new OptionalOperationError(unavailableMessage, {
            code,
            feature,
            assetVersion,
            attemptId,
            retryable: true,
            cause
          }));
        };
        const succeed = result => {
          if (settled) return;
          settled = true;
          cleanup(false);
          resolve(result);
        };

        script.src = url;
        script.async = true;
        script.dataset.oneappOptionalFeature = value(feature);
        script.dataset.oneappAssetVersion = value(assetVersion);
        script.dataset.oneappAttemptId = attemptId;
        script.onload = () => {
          const loadedGlobal = globalScope?.[globalName];
          if (!loadedGlobal) {
            fail(OPTIONAL_OPERATION_ERROR_CODE.GLOBAL_MISSING);
            return;
          }
          succeed(loadedGlobal);
        };
        script.onerror = event => fail(OPTIONAL_OPERATION_ERROR_CODE.NETWORK, event?.error);
        timer = schedule?.(
          () => fail(OPTIONAL_OPERATION_ERROR_CODE.TIMEOUT),
          positiveTimeout(timeoutMs, OPTIONAL_OPERATION_TIMEOUT_MS.externalScript)
        );
        try {
          documentRef.head.append(script);
        } catch (error) {
          fail(OPTIONAL_OPERATION_ERROR_CODE.NETWORK, error);
        }
      };
    });
    entry.promise = promise;
    assetCache.set(key, entry);
    begin();
    return promise;
  }

  function loadModule({
    feature,
    assetVersion,
    specifier,
    timeoutMs = OPTIONAL_OPERATION_TIMEOUT_MS.localModule,
    unavailableMessage = ''
  }) {
    const key = cacheKey({ kind: 'module', feature, assetVersion, location: specifier });
    const cached = assetCache.get(key);
    if (cached) return cached.promise;

    const attemptId = nextAttemptId('module');
    const entry = { attemptId, promise: null };
    let timer = null;
    let settled = false;
    const imported = Promise.resolve().then(() => importModule(specifier));
    const promise = new Promise((resolve, reject) => {
      const fail = (code, cause, message = unavailableMessage) => {
        if (settled) return;
        settled = true;
        if (timer !== null) cancel?.(timer);
        timer = null;
        clearOwnFailedAttempt(key, entry);
        reject(new OptionalOperationError(moduleFailureMessage(cause, message), {
          code,
          feature,
          assetVersion,
          attemptId,
          retryable: code !== OPTIONAL_OPERATION_ERROR_CODE.EVALUATION,
          cause
        }));
      };
      timer = schedule?.(
        () => fail(OPTIONAL_OPERATION_ERROR_CODE.TIMEOUT, null, unavailableMessage || '선택 기능 모듈 로딩 시간이 초과되었습니다.'),
        positiveTimeout(timeoutMs, OPTIONAL_OPERATION_TIMEOUT_MS.localModule)
      );
      imported.then(result => {
        if (settled) return;
        settled = true;
        if (timer !== null) cancel?.(timer);
        timer = null;
        resolve(result);
      }, error => fail(moduleFailureCode(error), error));
    });
    entry.promise = promise;
    assetCache.set(key, entry);
    return promise;
  }

  function beginOperation({ feature, assetVersion = '', workspaceEpoch = 0, inputGeneration = 0 }) {
    const token = Object.freeze({
      feature: value(feature),
      assetVersion: value(assetVersion),
      attemptId: nextAttemptId('operation'),
      workspaceEpoch,
      inputGeneration
    });
    currentOperations.set(token.feature, token);
    return token;
  }

  function invalidateOperation(feature, { workspaceEpoch = 0, inputGeneration = 0 } = {}) {
    currentOperations.set(value(feature), Object.freeze({
      feature: value(feature),
      assetVersion: '',
      attemptId: nextAttemptId('invalidated'),
      workspaceEpoch,
      inputGeneration,
      invalidated: true
    }));
  }

  function isCurrent(token, context = {}) {
    if (!token || currentOperations.get(token.feature)?.attemptId !== token.attemptId) return false;
    if ('workspaceEpoch' in context && context.workspaceEpoch !== token.workspaceEpoch) return false;
    if ('inputGeneration' in context && context.inputGeneration !== token.inputGeneration) return false;
    return true;
  }

  function assertCurrent(token, context = {}) {
    if (isCurrent(token, context)) return token;
    throw new OptionalOperationError('이전 작업의 늦은 결과를 적용하지 않았습니다.', {
      code: OPTIONAL_OPERATION_ERROR_CODE.STALE,
      feature: token?.feature,
      assetVersion: token?.assetVersion,
      attemptId: token?.attemptId,
      retryable: false
    });
  }

  return Object.freeze({
    loadScript,
    loadModule,
    beginOperation,
    invalidateOperation,
    isCurrent,
    assertCurrent
  });
}

export function createWriteResultTracker({
  schedule = globalThis.setTimeout?.bind(globalThis),
  cancel = globalThis.clearTimeout?.bind(globalThis)
} = {}) {
  const commands = new Map();
  let recordSequence = 0;
  const commandKey = (feature, commandId) => `${value(feature)}|${value(commandId)}`;

  function resultUnknown(record) {
    return new OptionalOperationError('쓰기 결과를 확인할 수 없습니다. 같은 명령 ID의 결과를 먼저 조회하세요.', {
      code: OPTIONAL_OPERATION_ERROR_CODE.RESULT_UNKNOWN,
      feature: record.feature,
      commandId: record.commandId,
      attemptId: record.attemptId,
      retryable: true
    });
  }

  function submit({ feature = 'write', commandId, execute, timeoutMs }) {
    if (!value(commandId) || typeof execute !== 'function') throw new TypeError('commandId와 execute가 필요합니다.');
    const key = commandKey(feature, commandId);
    const existing = commands.get(key);
    if (existing?.status === 'PENDING') return existing.promise;
    if (existing?.status === 'COMMITTED') return Promise.resolve(existing.result);
    if (existing?.status === 'RESULT_UNKNOWN') return Promise.reject(existing.error);

    const record = {
      feature: value(feature),
      commandId: value(commandId),
      attemptId: `write-${recordSequence += 1}`,
      status: 'PENDING',
      promise: null,
      result: undefined,
      error: null
    };
    let timer = null;
    let publicSettled = false;
    const execution = Promise.resolve().then(() => execute({ commandId: record.commandId }));
    record.promise = new Promise((resolve, reject) => {
      timer = schedule?.(() => {
        if (record.status !== 'PENDING') return;
        record.status = 'RESULT_UNKNOWN';
        record.error = resultUnknown(record);
        publicSettled = true;
        reject(record.error);
      }, positiveTimeout(timeoutMs, OPTIONAL_OPERATION_TIMEOUT_MS.externalReference));
      execution.then(result => {
        if (timer !== null) cancel?.(timer);
        timer = null;
        if (record.status === 'COMMITTED') return;
        record.status = 'COMMITTED';
        record.result = result;
        record.error = null;
        if (!publicSettled) {
          publicSettled = true;
          resolve(result);
        }
      }, error => {
        if (timer !== null) cancel?.(timer);
        timer = null;
        if (record.status === 'COMMITTED') {
          record.lateError = error;
          return;
        }
        if (record.status === 'RESULT_UNKNOWN') {
          record.lateError = error;
          return;
        }
        commands.delete(key);
        if (!publicSettled) {
          publicSettled = true;
          reject(error);
        }
      });
    });
    commands.set(key, record);
    return record.promise;
  }

  async function resolveUnknown({ feature = 'write', commandId, lookup }) {
    const key = commandKey(feature, commandId);
    const record = commands.get(key);
    if (record?.status === 'COMMITTED') return record.result;
    if (record?.status !== 'RESULT_UNKNOWN') return undefined;
    if (typeof lookup !== 'function') throw record.error;
    const unknownError = record.error || resultUnknown(record);
    try {
      const resolution = await lookup({ commandId: record.commandId });
      if (record.status === 'COMMITTED') return record.result;
      if (resolution?.known !== true && resolution?.safeToRetry === true) {
        commands.delete(key);
        return undefined;
      }
      if (!resolution || resolution.known !== true) throw unknownError;
      record.status = 'COMMITTED';
      record.result = resolution.result;
      record.error = null;
      return record.result;
    } catch (error) {
      if (record.status === 'COMMITTED') return record.result;
      if (error === unknownError || error?.code === OPTIONAL_OPERATION_ERROR_CODE.RESULT_UNKNOWN) throw error;
      throw new OptionalOperationError('쓰기 결과 조회에 실패했습니다. 명령을 새 ID로 다시 실행하지 않았습니다.', {
        code: OPTIONAL_OPERATION_ERROR_CODE.RESULT_LOOKUP_FAILED,
        feature: record.feature,
        commandId: record.commandId,
        attemptId: record.attemptId,
        retryable: true,
        cause: error
      });
    }
  }

  function status({ feature = 'write', commandId }) {
    return commands.get(commandKey(feature, commandId))?.status || 'NOT_STARTED';
  }

  return Object.freeze({ submit, resolveUnknown, status });
}
