export const SOURCE_STATUSES = Object.freeze({
  REGISTERED: 'REGISTERED',
  ANALYZING: 'ANALYZING',
  STAGED: 'STAGED',
  PARTIALLY_APPLIED: 'PARTIALLY_APPLIED',
  APPLIED: 'APPLIED',
  FAILED: 'FAILED',
  REMOVED: 'REMOVED'
});

export const STAGED_ROW_STATES = Object.freeze({
  PENDING: 'PENDING',
  ERROR: 'ERROR',
  ALREADY_APPLIED: 'ALREADY_APPLIED',
  EXCLUDED: 'EXCLUDED',
  APPLIED: 'APPLIED'
});

export const SOURCE_STATUS_LABELS = Object.freeze({
  REGISTERED: '등록',
  ANALYZING: '분석 중',
  STAGED: '추가 예정',
  PARTIALLY_APPLIED: '일부 추가',
  APPLIED: '추가 완료',
  FAILED: '분석 실패',
  REMOVED: '원본 제거'
});

const SOURCE_KINDS = new Set(['IMAGE', 'TEXT', 'EXCEL_FILE', 'EXCEL_PASTE', 'VOICE']);
const SOURCE_STATUS_VALUES = new Set(Object.values(SOURCE_STATUSES));
const STAGED_STATE_VALUES = new Set(Object.values(STAGED_ROW_STATES));

function text(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function normalizedNumber(value) {
  if (value === null || value === undefined || text(value) === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function isoNow(now = Date.now()) {
  const date = now instanceof Date ? now : new Date(now);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function createTemporaryId(now = Date.now(), random = Math.random()) {
  const numericNow = Number(now);
  const timestamp = Number.isFinite(numericNow) ? numericNow : new Date(now).getTime();
  return `src:pending:${(Number.isFinite(timestamp) ? timestamp : Date.now()).toString(36)}-${Math.floor(Number(random) * 0xffffff).toString(36)}`;
}

export function sourceKindForMethod(method, { template = false, file = false } = {}) {
  if (method === 'photo') return 'IMAGE';
  if (method === 'voice') return 'VOICE';
  if (method === 'excel-template' || template) return file ? 'EXCEL_FILE' : 'EXCEL_PASTE';
  if (method === 'excel') return file ? 'EXCEL_FILE' : 'TEXT';
  return 'TEXT';
}

export async function sha256Hex(bytes, cryptoImpl = globalThis.crypto) {
  const source = bytes instanceof Uint8Array
    ? bytes
    : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new TextEncoder().encode(String(bytes ?? '')));
  if (!cryptoImpl?.subtle?.digest) throw new Error('SOURCE_HASH_UNAVAILABLE');
  const digest = await cryptoImpl.subtle.digest('SHA-256', source);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sourceIdFromBytes(bytes, cryptoImpl = globalThis.crypto) {
  return `src:sha256:${await sha256Hex(bytes, cryptoImpl)}`;
}

export async function sourceIdFromText(value, cryptoImpl = globalThis.crypto) {
  return sourceIdFromBytes(new TextEncoder().encode(String(value ?? '')), cryptoImpl);
}

export function typedSourceIdentityBytes(inputKind, bytes) {
  const raw = bytes instanceof Uint8Array
    ? bytes
    : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new TextEncoder().encode(String(bytes ?? '')));
  const prefix = new TextEncoder().encode(`${text(inputKind) || 'RAW'}\0`);
  const combined = new Uint8Array(prefix.byteLength + raw.byteLength);
  combined.set(prefix, 0);
  combined.set(raw, prefix.byteLength);
  return combined;
}

export function normalizeSourceRecord(input = {}) {
  const sourceId = text(input.sourceId) || createTemporaryId();
  return {
    sourceId,
    kind: SOURCE_KINDS.has(input.kind) ? input.kind : 'TEXT',
    displayName: text(input.displayName) || '원본',
    status: SOURCE_STATUS_VALUES.has(input.status) ? input.status : SOURCE_STATUSES.REGISTERED,
    createdAt: text(input.createdAt) || isoNow(),
    analysisRevision: Math.max(0, Number(input.analysisRevision || 0)),
    parserVersion: text(input.parserVersion),
    previewRef: text(input.previewRef),
    previewText: String(input.previewText ?? ''),
    removedAt: input.removedAt ? text(input.removedAt) : null,
    failureMessage: text(input.failureMessage),
    analysisMeta: input.analysisMeta && typeof input.analysisMeta === 'object' ? clone(input.analysisMeta) : null
  };
}

export function normalizeStagedSourceRow(input = {}) {
  return {
    sourceId: text(input.sourceId),
    sourceRowKey: text(input.sourceRowKey),
    logicalRowDigest: text(input.logicalRowDigest),
    analysisRevision: Math.max(1, Number(input.analysisRevision || 1)),
    state: STAGED_STATE_VALUES.has(input.state) ? input.state : STAGED_ROW_STATES.PENDING,
    values: input.values && typeof input.values === 'object' ? clone(input.values) : {},
    appliedWorkRowId: text(input.appliedWorkRowId),
    errorMessage: text(input.errorMessage)
  };
}

export function normalizeApplicationLedger(input = {}) {
  return {
    sourceId: text(input.sourceId),
    sourceRowKey: text(input.sourceRowKey),
    logicalRowDigest: text(input.logicalRowDigest),
    workRowId: text(input.workRowId),
    appliedAt: text(input.appliedAt) || isoNow(),
    deletedFromWorkTableAt: input.deletedFromWorkTableAt ? text(input.deletedFromWorkTableAt) : null,
    reapplyAuthorizedAt: input.reapplyAuthorizedAt ? text(input.reapplyAuthorizedAt) : null
  };
}

export function ensureSourceWorkspace(modeDraft = {}) {
  const sources = Array.isArray(modeDraft.sources) ? modeDraft.sources : [];
  sources.forEach(source => Object.assign(source, normalizeSourceRecord(source)));
  modeDraft.sources = sources.filter((source, index) => sources.findIndex(item => item.sourceId === source.sourceId) === index);
  const stagedRows = Array.isArray(modeDraft.stagedSourceRows) ? modeDraft.stagedSourceRows : [];
  stagedRows.forEach(row => Object.assign(row, normalizeStagedSourceRow(row)));
  modeDraft.stagedSourceRows = stagedRows.filter(row => row.sourceId && row.sourceRowKey);
  const ledger = Array.isArray(modeDraft.sourceApplicationLedger) ? modeDraft.sourceApplicationLedger : [];
  ledger.forEach(entry => Object.assign(entry, normalizeApplicationLedger(entry)));
  modeDraft.sourceApplicationLedger = ledger.filter(entry => entry.sourceId && entry.sourceRowKey);
  const visible = modeDraft.sources.filter(source => source.status !== SOURCE_STATUSES.REMOVED);
  modeDraft.activeSourceId = visible.some(source => source.sourceId === text(modeDraft.activeSourceId))
    ? text(modeDraft.activeSourceId)
    : (visible.at(-1)?.sourceId || '');
  return modeDraft;
}

export function registerProvisionalSource(modeDraft, input = {}) {
  ensureSourceWorkspace(modeDraft);
  const source = normalizeSourceRecord({
    ...input,
    sourceId: text(input.sourceId) || createTemporaryId(input.now, input.random),
    status: SOURCE_STATUSES.REGISTERED,
    createdAt: isoNow(input.now)
  });
  modeDraft.sources.push(source);
  modeDraft.activeSourceId = source.sourceId;
  return source;
}

export function finalizeSourceIdentity(modeDraft, temporaryId, stableSourceId, patch = {}) {
  ensureSourceWorkspace(modeDraft);
  const nextSourceId = text(stableSourceId);
  if (!nextSourceId.startsWith('src:sha256:')) throw new Error('SOURCE_ID_INVALID');
  const provisionalIndex = modeDraft.sources.findIndex(source => source.sourceId === temporaryId);
  const provisional = provisionalIndex >= 0 ? modeDraft.sources[provisionalIndex] : normalizeSourceRecord({ sourceId: temporaryId, ...patch });
  const duplicate = modeDraft.sources.find(source => source.sourceId === nextSourceId && source.status !== SOURCE_STATUSES.REMOVED);
  if (duplicate) {
    if (provisionalIndex >= 0 && duplicate !== provisional) modeDraft.sources.splice(provisionalIndex, 1);
    modeDraft.activeSourceId = duplicate.sourceId;
    return { source: duplicate, duplicate: true, replacedSourceId: temporaryId };
  }
  const removed = modeDraft.sources.find(source => source.sourceId === nextSourceId && source.status === SOURCE_STATUSES.REMOVED);
  if (removed) {
    Object.assign(removed, normalizeSourceRecord({ ...removed, ...provisional, ...patch, sourceId: nextSourceId, status: SOURCE_STATUSES.REGISTERED, removedAt: null }));
    if (provisionalIndex >= 0 && modeDraft.sources[provisionalIndex] !== removed) modeDraft.sources.splice(provisionalIndex, 1);
    modeDraft.activeSourceId = removed.sourceId;
    return { source: removed, duplicate: false, restored: true, replacedSourceId: temporaryId };
  }
  const finalized = normalizeSourceRecord({ ...provisional, ...patch, sourceId: nextSourceId });
  if (provisionalIndex >= 0) modeDraft.sources.splice(provisionalIndex, 1, finalized);
  else modeDraft.sources.push(finalized);
  modeDraft.stagedSourceRows.forEach(row => { if (row.sourceId === temporaryId) row.sourceId = nextSourceId; });
  modeDraft.sourceApplicationLedger.forEach(entry => { if (entry.sourceId === temporaryId) entry.sourceId = nextSourceId; });
  if (modeDraft.activeSourceId === temporaryId || !modeDraft.activeSourceId) modeDraft.activeSourceId = nextSourceId;
  return { source: finalized, duplicate: false, replacedSourceId: temporaryId };
}

export function visibleSources(modeDraft) {
  ensureSourceWorkspace(modeDraft);
  return modeDraft.sources.filter(source => source.status !== SOURCE_STATUSES.REMOVED);
}

export function activeSource(modeDraft) {
  ensureSourceWorkspace(modeDraft);
  return modeDraft.sources.find(source => source.sourceId === modeDraft.activeSourceId && source.status !== SOURCE_STATUSES.REMOVED) || null;
}

export function activateSource(modeDraft, sourceId) {
  ensureSourceWorkspace(modeDraft);
  const source = modeDraft.sources.find(item => item.sourceId === sourceId && item.status !== SOURCE_STATUSES.REMOVED);
  if (!source) return null;
  modeDraft.activeSourceId = source.sourceId;
  return source;
}

export function adjacentSource(modeDraft, direction = 1) {
  const sources = visibleSources(modeDraft);
  if (!sources.length) return null;
  const index = Math.max(0, sources.findIndex(source => source.sourceId === modeDraft.activeSourceId));
  const nextIndex = Math.max(0, Math.min(sources.length - 1, index + (direction < 0 ? -1 : 1)));
  return activateSource(modeDraft, sources[nextIndex].sourceId);
}

export function setSourceStatus(modeDraft, sourceId, status, patch = {}) {
  ensureSourceWorkspace(modeDraft);
  const source = modeDraft.sources.find(item => item.sourceId === sourceId);
  if (!source) return null;
  source.status = SOURCE_STATUS_VALUES.has(status) ? status : source.status;
  Object.assign(source, patch);
  if (status !== SOURCE_STATUSES.FAILED) source.failureMessage = '';
  return source;
}

export function logicalRowIdentity(values = {}, index = 0) {
  const normalizedRawText = text(values.rawText || values.rawExpression).replace(/\s+/g, ' ').toLowerCase();
  const normalizedValue = normalizedRawText
    ? { rawText: normalizedRawText }
    : {
        itemCode: text(values.externalItemCode || values.itemCode).toLowerCase(),
        itemName: text(values.itemName || values.productText).replace(/\s+/g, ' ').toLowerCase(),
        specification: text(values.specification).replace(/\s+/g, ' ').toLowerCase(),
        quantity: normalizedNumber(values.quantity),
        unit: text(values.unit).toLowerCase(),
        unitPrice: normalizedNumber(values.unitPrice),
        supplyAmount: normalizedNumber(values.supplyAmount)
      };
  return stableJson({
    voucherGroup: values.sourceVoucherIndex ?? 1,
    table: text(values.sourceSheetName || values.sourceDocumentKey),
    sourceRowPosition: Number(values.sourceRowNo || values.sourceLineNo || index + 1),
    normalizedValue
  });
}

function refreshSourceApplicationStatus(modeDraft, sourceId) {
  const source = modeDraft.sources.find(item => item.sourceId === sourceId);
  if (!source || source.status === SOURCE_STATUSES.REMOVED) return source;
  const rows = modeDraft.stagedSourceRows.filter(row => row.sourceId === sourceId);
  const ledger = modeDraft.sourceApplicationLedger.filter(entry => entry.sourceId === sourceId);
  const pending = rows.some(row => [STAGED_ROW_STATES.PENDING, STAGED_ROW_STATES.ERROR].includes(row.state));
  const applied = rows.some(row => [STAGED_ROW_STATES.APPLIED, STAGED_ROW_STATES.ALREADY_APPLIED].includes(row.state)) || ledger.length > 0;
  const deleted = ledger.some(entry => entry.deletedFromWorkTableAt);
  if (!rows.length) source.status = SOURCE_STATUSES.FAILED;
  else if (pending && applied) source.status = SOURCE_STATUSES.PARTIALLY_APPLIED;
  else if (pending) source.status = SOURCE_STATUSES.STAGED;
  else if (deleted) source.status = SOURCE_STATUSES.PARTIALLY_APPLIED;
  else source.status = SOURCE_STATUSES.APPLIED;
  return source;
}

export async function stageSourceRows(modeDraft, sourceId, rows = [], options = {}) {
  ensureSourceWorkspace(modeDraft);
  const source = modeDraft.sources.find(item => item.sourceId === sourceId);
  if (!source) throw new Error('SOURCE_NOT_FOUND');
  if (!sourceId.startsWith('src:sha256:')) throw new Error('SOURCE_HASH_REQUIRED');
  const parserVersion = text(options.parserVersion) || 'SMARTINPUT_SOURCE_PARSER_V1';
  const hashText = options.hashText || sourceIdFromText;
  const analysisRevision = Number(source.analysisRevision || 0) + 1;
  const ledger = modeDraft.sourceApplicationLedger.filter(entry => entry.sourceId === sourceId);
  const staged = [];
  for (let index = 0; index < rows.length; index += 1) {
    const values = clone(rows[index] || {});
    const identity = logicalRowIdentity(values, index);
    const logicalRowDigest = (await hashText(identity)).replace(/^src:sha256:/, '');
    const sourceRowDigest = (await hashText(`${sourceId}\n${parserVersion}\n${identity}`)).replace(/^src:sha256:/, '');
    const sourceRowKey = `row:sha256:${sourceRowDigest}`;
    const applied = ledger.find(entry => entry.sourceRowKey === sourceRowKey || entry.logicalRowDigest === logicalRowDigest);
    const reapplyAuthorized = Boolean(applied?.deletedFromWorkTableAt && applied?.reapplyAuthorizedAt);
    staged.push(normalizeStagedSourceRow({
      sourceId,
      sourceRowKey,
      logicalRowDigest,
      analysisRevision,
      state: applied && !reapplyAuthorized ? STAGED_ROW_STATES.ALREADY_APPLIED : STAGED_ROW_STATES.PENDING,
      values,
      appliedWorkRowId: reapplyAuthorized ? '' : (applied?.workRowId || '')
    }));
  }
  modeDraft.stagedSourceRows = [
    ...modeDraft.stagedSourceRows.filter(row => row.sourceId !== sourceId),
    ...staged
  ];
  source.analysisRevision = analysisRevision;
  source.parserVersion = parserVersion;
  source.analysisMeta = options.analysisMeta && typeof options.analysisMeta === 'object' ? clone(options.analysisMeta) : source.analysisMeta;
  refreshSourceApplicationStatus(modeDraft, sourceId);
  source.failureMessage = staged.length ? '' : text(options.failureMessage || '분석 결과가 없습니다.');
  return staged;
}

export function stagedRowsForSource(modeDraft, sourceId = modeDraft.activeSourceId) {
  ensureSourceWorkspace(modeDraft);
  return modeDraft.stagedSourceRows.filter(row => row.sourceId === sourceId);
}

export function pendingRowsForSource(modeDraft, sourceId = modeDraft.activeSourceId, selectedKeys = null) {
  const selected = selectedKeys ? new Set(selectedKeys) : null;
  return stagedRowsForSource(modeDraft, sourceId).filter(row => row.state === STAGED_ROW_STATES.PENDING
    && (!selected || selected.has(row.sourceRowKey)));
}

export function recordSourceApplications(modeDraft, sourceId, applications = [], now = Date.now()) {
  ensureSourceWorkspace(modeDraft);
  const appliedAt = isoNow(now);
  applications.forEach(application => {
    const staged = modeDraft.stagedSourceRows.find(row => row.sourceId === sourceId && row.sourceRowKey === application.sourceRowKey);
    if (!staged) return;
    staged.state = STAGED_ROW_STATES.APPLIED;
    staged.appliedWorkRowId = text(application.workRowId);
    const existing = modeDraft.sourceApplicationLedger.find(entry => entry.sourceId === sourceId
      && (entry.sourceRowKey === staged.sourceRowKey || entry.logicalRowDigest === staged.logicalRowDigest));
    const record = normalizeApplicationLedger({
      sourceId,
      sourceRowKey: staged.sourceRowKey,
      logicalRowDigest: staged.logicalRowDigest,
      workRowId: application.workRowId,
      appliedAt,
      deletedFromWorkTableAt: null,
      reapplyAuthorizedAt: null
    });
    if (existing) Object.assign(existing, record);
    else modeDraft.sourceApplicationLedger.push(record);
  });
  const sourceRows = stagedRowsForSource(modeDraft, sourceId);
  refreshSourceApplicationStatus(modeDraft, sourceId);
  return sourceRows;
}

export function markWorkRowsDeleted(modeDraft, workRowIds = [], now = Date.now()) {
  ensureSourceWorkspace(modeDraft);
  const ids = new Set(workRowIds.map(text).filter(Boolean));
  const deletedAt = isoNow(now);
  const affectedSources = new Set();
  modeDraft.sourceApplicationLedger.forEach(entry => {
    if (!ids.has(entry.workRowId) || entry.deletedFromWorkTableAt) return;
    entry.deletedFromWorkTableAt = deletedAt;
    entry.reapplyAuthorizedAt = null;
    affectedSources.add(entry.sourceId);
    const staged = modeDraft.stagedSourceRows.find(row => row.sourceId === entry.sourceId
      && (row.sourceRowKey === entry.sourceRowKey || row.logicalRowDigest === entry.logicalRowDigest));
    if (staged) staged.state = STAGED_ROW_STATES.ALREADY_APPLIED;
  });
  affectedSources.forEach(sourceId => {
    const source = modeDraft.sources.find(item => item.sourceId === sourceId);
    if (source && source.status !== SOURCE_STATUSES.REMOVED) source.status = SOURCE_STATUSES.PARTIALLY_APPLIED;
  });
  return affectedSources.size;
}

export function authorizeDeletedRowsForReapply(modeDraft, sourceId, now = Date.now()) {
  ensureSourceWorkspace(modeDraft);
  const authorizedAt = isoNow(now);
  let count = 0;
  modeDraft.sourceApplicationLedger.forEach(entry => {
    if (entry.sourceId !== sourceId || !entry.deletedFromWorkTableAt) return;
    entry.reapplyAuthorizedAt = authorizedAt;
    const staged = modeDraft.stagedSourceRows.find(row => row.sourceId === sourceId
      && (row.sourceRowKey === entry.sourceRowKey || row.logicalRowDigest === entry.logicalRowDigest));
    if (staged) {
      staged.state = STAGED_ROW_STATES.PENDING;
      staged.appliedWorkRowId = '';
      count += 1;
    }
  });
  if (count) refreshSourceApplicationStatus(modeDraft, sourceId);
  return count;
}

export function removeSource(modeDraft, sourceId, { discardPending = true, now = Date.now() } = {}) {
  ensureSourceWorkspace(modeDraft);
  const source = modeDraft.sources.find(item => item.sourceId === sourceId);
  if (!source) return { removed: false, discarded: 0, nextSourceId: modeDraft.activeSourceId };
  const previousVisible = visibleSources(modeDraft);
  const previousIndex = previousVisible.findIndex(item => item.sourceId === sourceId);
  const pendingStates = new Set([STAGED_ROW_STATES.PENDING, STAGED_ROW_STATES.ERROR, STAGED_ROW_STATES.EXCLUDED]);
  const discarded = modeDraft.stagedSourceRows.filter(row => row.sourceId === sourceId && pendingStates.has(row.state)).length;
  if (discardPending) {
    modeDraft.stagedSourceRows = modeDraft.stagedSourceRows.filter(row => row.sourceId !== sourceId || !pendingStates.has(row.state));
  }
  source.status = SOURCE_STATUSES.REMOVED;
  source.removedAt = isoNow(now);
  const remaining = visibleSources(modeDraft);
  const next = remaining[Math.min(previousIndex, Math.max(0, remaining.length - 1))]
    || remaining[Math.max(0, previousIndex - 1)]
    || null;
  modeDraft.activeSourceId = next?.sourceId || '';
  return { removed: true, discarded, nextSourceId: modeDraft.activeSourceId };
}

export function sourceSummary(modeDraft, sourceId = modeDraft.activeSourceId) {
  const source = modeDraft.sources?.find(item => item.sourceId === sourceId) || null;
  const rows = stagedRowsForSource(modeDraft, sourceId);
  return {
    source,
    total: rows.length,
    pending: rows.filter(row => row.state === STAGED_ROW_STATES.PENDING).length,
    applied: rows.filter(row => row.state === STAGED_ROW_STATES.APPLIED).length,
    alreadyApplied: rows.filter(row => row.state === STAGED_ROW_STATES.ALREADY_APPLIED).length,
    errors: rows.filter(row => row.state === STAGED_ROW_STATES.ERROR).length,
    excluded: rows.filter(row => row.state === STAGED_ROW_STATES.EXCLUDED).length,
    deleted: (modeDraft.sourceApplicationLedger || []).filter(entry => entry.sourceId === sourceId && entry.deletedFromWorkTableAt).length
  };
}
