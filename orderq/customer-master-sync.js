export function createCustomerMasterSyncCoordinator({ isConfigured, push, pull }) {
  let flight = null;
  let requested = false;

  async function run(onStatus) {
    if (!isConfigured()) return { configured: false, push: null, pull: null, pushError: null, pullError: null };
    let pushResult = null;
    let pullResult = null;
    let pushError = null;
    let pullError = null;
    onStatus?.({ phase: 'PUSHING' });
    try { pushResult = await push(); }
    catch (error) { pushError = error; }
    onStatus?.({ phase: 'PULLING', push: pushResult, pushError });
    try { pullResult = await pull(); }
    catch (error) { pullError = error; }
    return { configured: true, push: pushResult, pull: pullResult, pushError, pullError };
  }

  function synchronize({ onStatus = null } = {}) {
    requested = true;
    if (flight) return flight;
    flight = (async () => {
      let result = null;
      do {
        requested = false;
        result = await run(onStatus);
      } while (requested);
      return result;
    })().finally(() => { flight = null; });
    return flight;
  }

  return { synchronize };
}

export function shouldPreserveLocalEntityChange(queueRows, change) {
  return (queueRows || []).some(row => row.entityType === change?.entityType && row.entityId === change?.entityId
    && ['PENDING', 'RETRY', 'CONFLICT'].includes(row.status) && row.localOnly !== true);
}
