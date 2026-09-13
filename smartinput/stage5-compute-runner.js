const DEFAULT_WORKER_THRESHOLD_ROWS = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

const now = () => globalThis.performance?.now?.() ?? Date.now();

function abortError() {
  const error = new Error('계산 작업이 취소되었습니다.');
  error.name = 'AbortError';
  return error;
}

function runDirect({ feature, phase, direct, path = 'direct', onMetric }) {
  const startedAt = now();
  try {
    const value = direct();
    onMetric?.({ feature, phase, path, durationMs: now() - startedAt });
    return value;
  } catch (error) {
    onMetric?.({ feature, phase, path, status: 'ERROR', durationMs: now() - startedAt });
    throw error;
  }
}

export async function runStage5Compute({
  feature,
  phase,
  payload,
  rowCount = 0,
  direct,
  signal = null,
  thresholdRows = DEFAULT_WORKER_THRESHOLD_ROWS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  workerFactory = null,
  onMetric = null
} = {}) {
  if (typeof direct !== 'function') throw new TypeError('direct 계산 함수가 필요합니다.');
  if (signal?.aborted) throw abortError();
  const WorkerConstructor = globalThis.Worker;
  if (Number(rowCount) < Number(thresholdRows)
    || (!workerFactory && typeof WorkerConstructor !== 'function')) {
    return runDirect({ feature, phase, direct, onMetric });
  }

  let worker;
  const jobId = globalThis.crypto?.randomUUID?.() || `stage5-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const queuedAt = now();
  try {
    worker = workerFactory
      ? workerFactory()
      : new WorkerConstructor(new URL('./stage5-compute-worker.js?v=0.1.0', import.meta.url), { type: 'module', name: 'smartinput-stage5-compute' });
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = callback => value => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout?.(timer);
        signal?.removeEventListener?.('abort', onAbort);
        callback(value);
      };
      const onAbort = () => finish(reject)(abortError());
      const timer = globalThis.setTimeout?.(() => finish(reject)(new Error('계산 작업 시간이 초과되었습니다.')), timeoutMs);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      worker.onmessage = event => {
        const message = event.data || {};
        if (message.jobId !== jobId || message.status === 'PROGRESS') return;
        if (message.status === 'READY') finish(resolve)(message);
        else finish(reject)(new Error(message.message || 'Worker 계산에 실패했습니다.'));
      };
      worker.onerror = event => finish(reject)(event.error || new Error(event.message || 'Worker를 실행하지 못했습니다.'));
      worker.postMessage({ jobId, feature, phase, payload });
    });
    onMetric?.({ feature, phase, path: 'worker', durationMs: now() - queuedAt, computeMs: result.metrics?.computeMs ?? null });
    return result.payload;
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) throw error;
    return runDirect({ feature, phase, direct, path: 'fallback-direct', onMetric });
  } finally {
    worker?.terminate?.();
  }
}

export { DEFAULT_WORKER_THRESHOLD_ROWS };
