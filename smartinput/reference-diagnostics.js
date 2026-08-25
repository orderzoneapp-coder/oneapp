export const REFERENCE_PHASE = Object.freeze({
  COMMON_PRODUCT: 'COMMON_PRODUCT',
  ORDERQ_PRODUCT: 'ORDERQ_PRODUCT',
  CUSTOMER: 'CUSTOMER',
  SHIPPING: 'SHIPPING',
  SETTINGS: 'SETTINGS'
});

const ALLOWED_PHASES = new Set(Object.values(REFERENCE_PHASE));
const ALLOWED_STATES = new Set(['START', 'END', 'ERROR', 'TIMEOUT']);
const ALLOWED_SOURCES = new Set([
  'MERCHOPS_DB_OR_SNAPSHOT',
  'ORDERQ_DB',
  'CUSTOMER_MASTER',
  'ORDERQ_CLOUD_CUSTOMER_MASTER',
  'ORDERQ_LOCAL_CACHE',
  'SMARTINPUT_DB'
]);

function safeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function safeElapsed(value) {
  const elapsed = Number(value);
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed) : 0;
}

function isTimeout(error) {
  return error?.name === 'TimeoutError' || /(?:시간 초과|초과되었습니다)/.test(String(error?.message || ''));
}

export function createReferenceDiagnostics({
  logger = event => globalThis.console?.info?.('[SmartInputReference]', JSON.stringify(event)),
  now = () => globalThis.performance?.now?.() ?? Date.now()
} = {}) {
  const active = new Map();
  const emit = ({ phase, state, source, elapsedMs = 0, count = 0 }) => {
    if (!ALLOWED_PHASES.has(phase) || !ALLOWED_STATES.has(state) || !ALLOWED_SOURCES.has(source)) return;
    logger(Object.freeze({
      phase,
      state,
      source,
      elapsedMs: safeElapsed(elapsedMs),
      count: safeCount(count)
    }));
  };
  return {
    start(phase, source) {
      const startedAt = now();
      let closed = false;
      emit({ phase, state: 'START', source });
      const span = {
        end(count = 0, finalSource = source) {
          if (closed) return;
          closed = true;
          active.delete(phase);
          emit({ phase, state: 'END', source: finalSource, elapsedMs: now() - startedAt, count });
        },
        fail(error, finalSource = source) {
          if (closed) return;
          closed = true;
          active.delete(phase);
          emit({ phase, state: isTimeout(error) ? 'TIMEOUT' : 'ERROR', source: finalSource, elapsedMs: now() - startedAt });
        }
      };
      active.set(phase, span);
      return span;
    },
    timeoutActive(phases = [], error = Object.assign(new Error('시간 초과'), { name: 'TimeoutError' })) {
      for (const phase of phases) {
        const span = active.get(phase);
        if (!span) continue;
        span.fail(error);
        return phase;
      }
      return '';
    }
  };
}

export async function runReferencePhase(diagnostics, phase, source, loader, countOf = value => value?.length || 0) {
  const span = diagnostics.start(phase, source);
  try {
    const value = await loader();
    span.end(countOf(value));
    return value;
  } catch (error) {
    span.fail(error);
    throw error;
  }
}
