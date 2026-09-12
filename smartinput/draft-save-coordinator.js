export const AUTOSAVE_JOURNAL_SCHEMA = 'ONEAPP_SMART_INPUT_AUTOSAVE_JOURNAL_V2';

const clone = value => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));
const pathKey = path => path.map(part => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
const pathParts = path => String(path || '').split('/').filter(Boolean)
  .map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'));

export function createAutosaveDocumentKey({ companyId = '', mode = '', documentId = '' } = {}) {
  if (!companyId || !mode || !documentId) throw new Error('SMARTINPUT_AUTOSAVE_DOCUMENT_KEY_INCOMPLETE');
  return [companyId, mode, documentId].map(value => encodeURIComponent(String(value))).join(':');
}

export function createAutosavePatch(before, after) {
  const operations = [];
  const visit = (left, right, path = []) => {
    if (Object.is(left, right)) return;
    const leftObject = left && typeof left === 'object';
    const rightObject = right && typeof right === 'object';
    if (Array.isArray(left) && Array.isArray(right)) {
      const stableShape = left.length === right.length && left.every((item, index) => {
        const leftId = item && typeof item === 'object' ? item.rowId : null;
        const rightId = right[index] && typeof right[index] === 'object' ? right[index].rowId : null;
        return leftId || rightId ? leftId === rightId : true;
      });
      if (stableShape) {
        right.forEach((value, index) => visit(left[index], value, [...path, index]));
        return;
      }
      operations.push({ op: 'set', path: pathKey(path), value: clone(right) });
      return;
    }
    if (!leftObject || !rightObject || Array.isArray(left) || Array.isArray(right)) {
      operations.push({ op: 'set', path: pathKey(path), value: clone(right) });
      return;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    keys.forEach(key => {
      if (!Object.prototype.hasOwnProperty.call(right, key)) operations.push({ op: 'delete', path: pathKey([...path, key]) });
      else visit(left[key], right[key], [...path, key]);
    });
  };
  visit(before, after);
  return operations;
}

export function applyAutosavePatch(snapshot, operations = []) {
  let result = clone(snapshot);
  operations.forEach(operation => {
    const parts = pathParts(operation.path);
    if (!parts.length) {
      result = operation.op === 'delete' ? null : clone(operation.value);
      return;
    }
    let target = result;
    parts.slice(0, -1).forEach(part => {
      if (!target[part] || typeof target[part] !== 'object') target[part] = {};
      target = target[part];
    });
    const leaf = parts.at(-1);
    if (operation.op === 'delete') delete target[leaf];
    else target[leaf] = clone(operation.value);
  });
  return result;
}

function recordsByKey(records = []) {
  return new Map(records.filter(record => record?.key).map(record => [record.key, record]));
}

export function recoverAutosaveDocuments(records = []) {
  const byKey = recordsByKey(records);
  const recovered = new Map();
  records.filter(record => record?.recordType === 'head').forEach(head => {
    const base = byKey.get(head.baseKey);
    if (!base || base.recordType !== 'base' || base.docKey !== head.docKey) return;
    let snapshot = clone(base.snapshot);
    let version = Number(base.version || 0);
    for (const patchKey of head.patchKeys || []) {
      const patch = byKey.get(patchKey);
      if (!patch || patch.recordType !== 'patch' || patch.docKey !== head.docKey || Number(patch.fromVersion) !== version) return;
      snapshot = applyAutosavePatch(snapshot, patch.operations);
      version = Number(patch.toVersion);
    }
    if (version !== Number(head.durableVersion)) return;
    const previous = recovered.get(head.docKey);
    if (!previous || Number(previous.durableVersion) < version) {
      recovered.set(head.docKey, { snapshot, durableVersion: version, head: clone(head) });
    }
  });
  return recovered;
}

export function createDraftSaveCoordinator({ commit, cleanup = async () => {}, now = () => new Date().toISOString(), compactAfter = 40 } = {}) {
  if (typeof commit !== 'function') throw new Error('SMARTINPUT_AUTOSAVE_COMMIT_REQUIRED');
  const documents = new Map();

  const stateFor = docKey => {
    if (!documents.has(docKey)) documents.set(docKey, {
      nextVersion: 0,
      durableVersion: 0,
      durableSnapshot: null,
      head: null,
      pending: null,
      inFlight: null,
      waiters: []
    });
    return documents.get(docKey);
  };

  const settle = state => {
    state.waiters = state.waiters.filter(waiter => {
      if (waiter.version > state.durableVersion) return true;
      waiter.resolve({ durableVersion: state.durableVersion });
      return false;
    });
  };

  const pump = async (docKey, state) => {
    if (state.inFlight || !state.pending) return state.inFlight;
    const pending = state.pending;
    state.pending = null;
    const write = (async () => {
      const timestamp = now();
      const createBase = !state.head || (state.head.patchKeys || []).length >= compactAfter;
      const base = createBase ? {
        key: `base:${docKey}:${pending.version}`,
        schemaVersion: AUTOSAVE_JOURNAL_SCHEMA,
        recordType: 'base', docKey, companyId: pending.companyId,
        version: pending.version, snapshot: pending.snapshot, updatedAt: timestamp
      } : null;
      const patch = createBase ? null : {
        key: `patch:${docKey}:${pending.version}`,
        schemaVersion: AUTOSAVE_JOURNAL_SCHEMA,
        recordType: 'patch', docKey, companyId: pending.companyId,
        fromVersion: state.durableVersion, toVersion: pending.version,
        operations: createAutosavePatch(state.durableSnapshot, pending.snapshot), updatedAt: timestamp
      };
      const head = {
        key: `head:${docKey}`,
        schemaVersion: AUTOSAVE_JOURNAL_SCHEMA,
        recordType: 'head', docKey, companyId: pending.companyId,
        durableVersion: pending.version,
        baseKey: base?.key || state.head.baseKey,
        patchKeys: base ? [] : [...(state.head.patchKeys || []), patch.key],
        updatedAt: timestamp
      };
      await commit({ base, patch, head, workspace: pending.workspace, expectedDurableVersion: state.durableVersion });
      const obsoleteKeys = base && state.head ? [state.head.baseKey, ...(state.head.patchKeys || [])] : [];
      state.durableVersion = pending.version;
      state.durableSnapshot = pending.snapshot;
      state.head = head;
      settle(state);
      if (obsoleteKeys.length) void Promise.resolve(cleanup(obsoleteKeys)).catch(() => undefined);
      return { docKey, durableVersion: pending.version, updatedAt: timestamp };
    })();
    state.inFlight = write;
    let committed = false;
    try {
      const result = await write;
      committed = true;
      return result;
    } catch (error) {
      if (!state.pending || state.pending.version < pending.version) state.pending = pending;
      state.waiters.filter(waiter => waiter.version <= pending.version).forEach(waiter => waiter.reject(error));
      state.waiters = state.waiters.filter(waiter => waiter.version > pending.version);
      throw error;
    } finally {
      state.inFlight = null;
      if (committed && state.pending) void pump(docKey, state).catch(() => undefined);
    }
  };

  return Object.freeze({
    hydrate(records = []) {
      const recovered = recoverAutosaveDocuments(records);
      recovered.forEach((value, docKey) => {
        const state = stateFor(docKey);
        state.nextVersion = value.durableVersion;
        state.durableVersion = value.durableVersion;
        state.durableSnapshot = value.snapshot;
        state.head = value.head;
      });
      return recovered;
    },
    queue({ companyId, mode, documentId, snapshot, workspace = null }) {
      const docKey = createAutosaveDocumentKey({ companyId, mode, documentId });
      const state = stateFor(docKey);
      const version = ++state.nextVersion;
      state.pending = { companyId, version, snapshot: clone(snapshot), workspace: workspace ? clone(workspace) : null };
      const promise = new Promise((resolve, reject) => state.waiters.push({ version, resolve, reject }));
      void pump(docKey, state).catch(() => undefined);
      return { docKey, version, promise };
    },
    async flushDocument(docKey) {
      const state = stateFor(docKey);
      // Capture the leave boundary; edits queued later keep their own save tickets.
      const targetVersion = state.nextVersion;
      if (state.inFlight) await state.inFlight.catch(() => undefined);
      while (state.durableVersion < targetVersion) {
        // Completing one write can synchronously start its successor and clear pending.
        if (state.inFlight) await state.inFlight;
        else if (state.pending) await pump(docKey, state);
        else throw new Error('SMARTINPUT_AUTOSAVE_FLUSH_INCOMPLETE');
      }
      return { docKey, durableVersion: state.durableVersion };
    },
    async flushWorkspace() {
      return Promise.all([...documents.keys()].map(docKey => this.flushDocument(docKey)));
    },
    recoveredSnapshot(docKey) {
      const state = stateFor(docKey);
      return state.durableSnapshot ? clone(state.durableSnapshot) : null;
    },
    status(docKey) {
      const state = stateFor(docKey);
      return { nextVersion: state.nextVersion, durableVersion: state.durableVersion, pending: Boolean(state.pending), inFlight: Boolean(state.inFlight) };
    }
  });
}
