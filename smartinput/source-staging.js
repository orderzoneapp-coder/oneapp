const text = value => String(value ?? '').normalize('NFKC').trim();

function canonicalCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return text(value).replace(/\s+/g, ' ');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

export async function sha256Hex(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle?.digest) throw Object.assign(new Error('SHA-256을 사용할 수 없습니다.'), { code: 'SOURCE_HASH_UNAVAILABLE' });
  const bytes = new TextEncoder().encode(String(value ?? ''));
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizedParsedSource(parsed = {}, { mode = 'order' } = {}) {
  return JSON.stringify(stableValue({
    mode,
    header: (parsed.mappings || []).map(mapping => ({ fieldId: mapping.fieldId, sourceHeader: canonicalCell(mapping.sourceHeader) })),
    rows: (parsed.rows || []).map(row => String(row.rawText ?? '')
      .split('\t')
      .map(canonicalCell))
  }));
}

export async function normalizedSourceHash(parsed, options = {}) {
  return sha256Hex(normalizedParsedSource(parsed, options), options.cryptoImpl);
}

export function normalizeStaging(input = {}, normalizeRow = value => value) {
  const rows = Array.isArray(input.rows) ? input.rows.map(normalizeRow) : [];
  return {
    status: ['PENDING', 'APPLIED', 'ALREADY_PROCESSED', 'CONFLICT'].includes(input.status) ? input.status : (rows.length ? 'PENDING' : 'EMPTY'),
    sourceHash: text(input.sourceHash),
    sourceName: text(input.sourceName),
    sheetName: text(input.sheetName),
    headerRowNumber: Number(input.headerRowNumber || 0),
    mappings: Array.isArray(input.mappings) ? input.mappings.map(mapping => ({ ...mapping })) : [],
    columns: Array.isArray(input.columns) ? input.columns.map(column => ({ ...column })) : [],
    rows,
    warnings: Array.isArray(input.warnings) ? input.warnings.map(warning => ({ ...warning })) : [],
    batch: input.batch && typeof input.batch === 'object' ? { ...input.batch } : null,
    templateMode: input.templateMode === 'FILL' ? 'FILL' : 'CREATE',
    templateId: text(input.templateId),
    templateName: text(input.templateName),
    templateRevision: Number(input.templateRevision || 0),
    templateSave: input.templateSave && typeof input.templateSave === 'object'
      ? { status: text(input.templateSave.status), message: text(input.templateSave.message), templateId: text(input.templateSave.templateId) }
      : { status: 'PENDING', message: '', templateId: '' },
    createdAt: text(input.createdAt) || new Date().toISOString()
  };
}

export function createStaging(input = {}, normalizeRow = value => value) {
  return normalizeStaging({ ...input, status: input.status || 'PENDING' }, normalizeRow);
}

export function applyStaging(modeDraft, contract) {
  const staging = normalizeStaging(modeDraft.staging, contract.normalizeRow);
  if (staging.status === 'APPLIED') return { applied: false, rows: [], staging };
  if (staging.status !== 'PENDING') throw Object.assign(new Error('추가할 분석 결과가 없습니다.'), { code: 'STAGING_NOT_APPLICABLE' });
  const beforeIds = new Set((modeDraft.rows || []).map(row => row.rowId));
  const nextRows = contract.applyParserResults(modeDraft.rows || [], staging.batch, staging.rows);
  const applied = nextRows.filter(row => !beforeIds.has(row.rowId));
  modeDraft.rows = nextRows;
  modeDraft.staging = { ...staging, status: 'APPLIED', rows: staging.rows };
  if (staging.batch && !(modeDraft.batches || []).some(batch => batch.batchId === staging.batch.batchId)) {
    modeDraft.batches.push(staging.batch);
  }
  return { applied: true, rows: applied, staging: modeDraft.staging };
}

export function clearStaging(modeDraft) {
  modeDraft.staging = normalizeStaging();
  return modeDraft.staging;
}

export function sourceHashesForRows(rows = []) {
  return [...new Set(rows.map(row => text(row.sourceFingerprint)).filter(Boolean))];
}
