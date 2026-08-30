import { cloneJson, deepFreeze, sha256Hex } from '../reference-data/change-request-contract.js';

export const SMARTPARSER_ANALYSIS_RESULT_SCHEMA_VERSION = 'ONEAPP_SMARTPARSER_ANALYSIS_RESULT_V1';
export const SMARTPARSER_ANALYSIS_RESULT_VERSION = 'ONEAPP_SMARTPARSER_ANALYSIS_RESULT_V1';
export const SMARTPARSER_SOURCE_APP_ID = 'smart-parser';

export const SMARTPARSER_ANALYSIS_ISSUE_FLAGS = Object.freeze([
  'LARGE_CHANGE',
  'NO_OLD_PRICE',
  'ZERO_PRICE',
  'SPEC_DIFFERENCE',
  'SOLD_OUT',
  'DUPLICATE',
]);

const clean = (value) => String(value ?? '').trim();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const TOP_LEVEL_FIELDS = new Set(['schemaVersion', 'analysisId', 'idempotencyKey', 'createdAt', 'sourceAppId', 'sourceMetadata', 'baseProductSnapshot', 'rows', 'summary', 'validation']);
const ROW_FIELDS = new Set(['rowId', 'parsedFields', 'match', 'pricePreview', 'ruleEvidence', 'issues', 'stopRecommendation', 'proposedChanges', 'decision']);
const CHANGE_FIELDS = new Set(['field', 'beforeValue', 'proposedValue', 'reason']);

export function normalizeSmartParserProductCode(value) {
  return clean(value).normalize('NFKC').replace(/[\s-]+/g, '').toUpperCase();
}

function originalKind(value, suppliedKind = '') {
  const normalized = clean(suppliedKind).toUpperCase();
  if (['MISSING', 'BLANK', 'ZERO', 'VALUE'].includes(normalized)) return normalized;
  if (value === undefined) return 'MISSING';
  if (value === null || value === '') return 'BLANK';
  if ((typeof value === 'number' && value === 0) || (typeof value === 'string' && clean(value) === '0')) return 'ZERO';
  return 'VALUE';
}

function normalizeParsedFields(input = {}) {
  return Object.fromEntries(Object.entries(input && typeof input === 'object' ? input : {}).map(([field, raw]) => {
    const envelope = raw && typeof raw === 'object' && hasOwn(raw, 'value')
      ? raw
      : { value: raw };
    return [clean(field), {
      value: cloneJson(envelope.value),
      originalKind: originalKind(envelope.value, envelope.originalKind),
    }];
  }).filter(([field]) => field));
}

function normalizeChanges(input = []) {
  return (Array.isArray(input) ? input : []).map((change) => ({
    field: clean(change?.field),
    beforeValue: cloneJson(hasOwn(change, 'beforeValue') ? change.beforeValue : ''),
    proposedValue: cloneJson(hasOwn(change, 'proposedValue') ? change.proposedValue : ''),
    reason: clean(change?.reason),
  }));
}

function normalizeIssues(input = {}) {
  const normalized = {};
  SMARTPARSER_ANALYSIS_ISSUE_FLAGS.forEach((flag) => {
    normalized[flag] = input?.[flag] === true;
  });
  return normalized;
}

function normalizeRow(row = {}, index = 0) {
  const productCode = clean(row?.match?.productCode ?? row?.productCode);
  const normalizedProductCode = normalizeSmartParserProductCode(
    row?.match?.normalizedProductCode || productCode,
  );
  return {
    rowId: clean(row.rowId) || `row-${index + 1}`,
    parsedFields: normalizeParsedFields(row.parsedFields),
    match: {
      status: clean(row?.match?.status),
      productCode,
      normalizedProductCode,
      isNewProduct: row?.match?.isNewProduct === true,
      candidates: cloneJson(Array.isArray(row?.match?.candidates) ? row.match.candidates : []),
    },
    pricePreview: cloneJson(row.pricePreview && typeof row.pricePreview === 'object' ? row.pricePreview : {}),
    ruleEvidence: cloneJson(row.ruleEvidence && typeof row.ruleEvidence === 'object' ? row.ruleEvidence : {}),
    issues: normalizeIssues(row.issues),
    stopRecommendation: row.stopRecommendation === true,
    proposedChanges: normalizeChanges(row.proposedChanges),
    decision: {
      selected: row?.decision?.selected === true,
      excluded: row?.decision?.excluded === true,
      blocked: row?.decision?.blocked === true,
    },
  };
}

function summarize(rows) {
  const selectedRows = rows.filter((row) => row.decision.selected && !row.decision.excluded);
  const issueCounts = Object.fromEntries(SMARTPARSER_ANALYSIS_ISSUE_FLAGS.map((flag) => [
    flag,
    rows.filter((row) => row.issues[flag]).length,
  ]));
  return {
    rowCount: rows.length,
    selectedCount: selectedRows.length,
    excludedCount: rows.filter((row) => row.decision.excluded).length,
    blockedCount: rows.filter((row) => row.decision.blocked).length,
    createCount: selectedRows.filter((row) => row.match.isNewProduct).length,
    updateCount: selectedRows.filter((row) => !row.match.isNewProduct).length,
    proposalCount: selectedRows.reduce((total, row) => total + row.proposedChanges.length, 0),
    stopRecommendationCount: rows.filter((row) => row.stopRecommendation).length,
    issueCounts,
  };
}

function validateCore(result) {
  const errors = [];
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return [{ code: 'ANALYSIS_RESULT_OBJECT_REQUIRED', path: '' }];
  }
  Object.keys(result).filter((field) => !TOP_LEVEL_FIELDS.has(field)).forEach((field) => {
    errors.push({ code: 'UNKNOWN_FIELD', path: field });
  });
  if (result.schemaVersion !== SMARTPARSER_ANALYSIS_RESULT_SCHEMA_VERSION) errors.push({ code: 'SCHEMA_VERSION_INVALID', path: 'schemaVersion' });
  ['analysisId', 'idempotencyKey', 'createdAt'].forEach((field) => {
    if (!clean(result[field])) errors.push({ code: 'REQUIRED_FIELD_MISSING', path: field });
  });
  if (result.sourceAppId !== SMARTPARSER_SOURCE_APP_ID) errors.push({ code: 'SOURCE_APP_INVALID', path: 'sourceAppId' });
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(clean(result.createdAt))
    || !Number.isFinite(Date.parse(result.createdAt))) {
    errors.push({ code: 'CREATED_AT_INVALID', path: 'createdAt' });
  }
  const base = result.baseProductSnapshot;
  if (!base || typeof base !== 'object') errors.push({ code: 'BASE_PRODUCT_SNAPSHOT_REQUIRED', path: 'baseProductSnapshot' });
  else {
    ['schemaVersion', 'snapshotId', 'revision', 'status'].forEach((field) => {
      if (!clean(base[field])) errors.push({ code: 'BASE_SNAPSHOT_FIELD_REQUIRED', path: `baseProductSnapshot.${field}` });
    });
    const baseStatus = clean(base.status).toUpperCase();
    if (!['READY', 'EMPTY', 'ERROR'].includes(baseStatus)) errors.push({ code: 'BASE_SNAPSHOT_STATUS_INVALID', path: 'baseProductSnapshot.status' });
    if (baseStatus === 'ERROR') errors.push({ code: 'BASE_SNAPSHOT_NOT_SUBMITTABLE', path: 'baseProductSnapshot.status' });
  }
  if (!Array.isArray(result.rows)) errors.push({ code: 'ROWS_REQUIRED', path: 'rows' });
  else {
    const rowIds = new Set();
    const selectedCodes = new Map();
    result.rows.forEach((row, index) => {
      const path = `rows[${index}]`;
      Object.keys(row && typeof row === 'object' ? row : {}).filter((field) => !ROW_FIELDS.has(field)).forEach((field) => {
        errors.push({ code: 'UNKNOWN_FIELD', path: `${path}.${field}` });
      });
      if (!clean(row?.rowId)) errors.push({ code: 'ROW_ID_REQUIRED', path: `${path}.rowId` });
      else if (rowIds.has(row.rowId)) errors.push({ code: 'DUPLICATE_ROW_ID', path: `${path}.rowId` });
      rowIds.add(row?.rowId);
      const fields = new Set();
      (Array.isArray(row?.proposedChanges) ? row.proposedChanges : []).forEach((change, changeIndex) => {
        Object.keys(change && typeof change === 'object' ? change : {}).filter((field) => !CHANGE_FIELDS.has(field)).forEach((field) => {
          errors.push({ code: 'UNKNOWN_FIELD', path: `${path}.proposedChanges[${changeIndex}].${field}` });
        });
        const field = clean(change?.field);
        if (!field) errors.push({ code: 'PROPOSED_FIELD_REQUIRED', path: `${path}.proposedChanges[${changeIndex}].field` });
        const normalizedField = field.normalize('NFKC').toLocaleLowerCase('ko').replace(/\s+/g, '');
        if (fields.has(normalizedField)) errors.push({ code: 'DUPLICATE_PROPOSED_FIELD', path: `${path}.proposedChanges[${changeIndex}].field` });
        fields.add(normalizedField);
        if (!hasOwn(change, 'beforeValue')) errors.push({ code: 'BEFORE_VALUE_REQUIRED', path: `${path}.proposedChanges[${changeIndex}].beforeValue` });
        if (!hasOwn(change, 'proposedValue')) errors.push({ code: 'PROPOSED_VALUE_REQUIRED', path: `${path}.proposedChanges[${changeIndex}].proposedValue` });
      });
      if (row?.decision?.selected && !row?.decision?.excluded) {
        const code = normalizeSmartParserProductCode(row?.match?.normalizedProductCode || row?.match?.productCode);
        if (!code) errors.push({ code: 'SELECTED_PRODUCT_CODE_REQUIRED', path: `${path}.match.productCode` });
        else {
          const indexes = selectedCodes.get(code) || [];
          indexes.push(index);
          selectedCodes.set(code, indexes);
        }
      }
    });
    selectedCodes.forEach((indexes, code) => {
      if (indexes.length < 2) return;
      indexes.forEach((index) => errors.push({ code: 'DUPLICATE_SELECTED_PRODUCT_CODE', path: `rows[${index}].match.productCode`, detail: code }));
    });
  }
  return errors;
}

export function validateSmartParserAnalysisResult(result) {
  const errors = validateCore(result);
  const blockedRows = Array.isArray(result?.rows)
    ? result.rows.filter((row) => row?.decision?.blocked || row?.issues?.DUPLICATE).length
    : 0;
  const valid = errors.length === 0 && blockedRows === 0;
  return deepFreeze({ valid, status: valid ? 'VALID' : 'BLOCKED', blockedRows, errors: cloneJson(errors) });
}

export function createSmartParserAnalysisResult(input = {}) {
  const rows = (Array.isArray(input.rows) ? input.rows : []).map(normalizeRow);
  const baseInput = input.baseProductSnapshot || {};
  const baseProductSnapshot = {
    schemaVersion: clean(baseInput.schemaVersion),
    snapshotId: clean(baseInput.snapshotId),
    revision: clean(baseInput.revision ?? baseInput.snapshotVersion),
    status: clean(baseInput.status).toUpperCase(),
  };
  const core = {
    schemaVersion: SMARTPARSER_ANALYSIS_RESULT_SCHEMA_VERSION,
    analysisId: clean(input.analysisId),
    idempotencyKey: clean(input.idempotencyKey),
    createdAt: clean(input.createdAt),
    sourceAppId: SMARTPARSER_SOURCE_APP_ID,
    sourceMetadata: cloneJson(input.sourceMetadata && typeof input.sourceMetadata === 'object' ? input.sourceMetadata : {}),
    baseProductSnapshot,
    rows,
    summary: summarize(rows),
  };
  const validation = validateSmartParserAnalysisResult(core);
  return deepFreeze({ ...cloneJson(core), validation: cloneJson(validation) });
}

export async function smartParserAnalysisPayloadHash(result) {
  const value = cloneJson(result || {});
  delete value.analysisId;
  delete value.idempotencyKey;
  delete value.createdAt;
  delete value.validation;
  return sha256Hex(value);
}

export function createProductChangeRequestsFromAnalysis(result, options = {}) {
  const validation = validateSmartParserAnalysisResult(result);
  if (!validation.valid) {
    const error = new Error('SMARTPARSER_ANALYSIS_RESULT_NOT_SUBMITTABLE');
    error.validation = validation;
    throw error;
  }
  const requestedAt = clean(options.requestedAt) || result.createdAt;
  const actor = cloneJson(options.actor && typeof options.actor === 'object'
    ? options.actor
    : { actorState: 'UNVERIFIED_LOCAL' });
  return deepFreeze(result.rows.filter((row) => (
    row.decision.selected
    && !row.decision.excluded
    && !row.decision.blocked
    && row.proposedChanges.length > 0
  )).map((row) => ({
    schemaVersion: 'ONEAPP_REFERENCE_CHANGE_REQUEST_V1',
    requestId: `SP-${result.analysisId}-${row.rowId}`,
    idempotencyKey: `${result.idempotencyKey}:${row.rowId}`,
    domain: 'PRODUCT',
    ownerAppId: 'master-lookup',
    entityId: row.match.productCode,
    operation: row.match.isNewProduct ? 'CREATE' : 'UPDATE',
    baseSnapshotId: result.baseProductSnapshot.snapshotId,
    baseRevision: result.baseProductSnapshot.revision,
    requestedAt,
    actor,
    source: {
      appId: SMARTPARSER_SOURCE_APP_ID,
      analysisId: result.analysisId,
      analysisSchemaVersion: SMARTPARSER_ANALYSIS_RESULT_SCHEMA_VERSION,
      rowId: row.rowId,
      metadata: cloneJson(result.sourceMetadata),
    },
    changes: row.proposedChanges.map((change) => ({
      field: change.field,
      beforeValue: cloneJson(change.beforeValue),
      proposedValue: cloneJson(change.proposedValue),
      reason: change.reason,
    })),
  })));
}

export const smartParserAnalysisResultContract = deepFreeze({
  version: SMARTPARSER_ANALYSIS_RESULT_VERSION,
  schemaVersion: SMARTPARSER_ANALYSIS_RESULT_SCHEMA_VERSION,
  sourceAppId: SMARTPARSER_SOURCE_APP_ID,
  issueFlags: SMARTPARSER_ANALYSIS_ISSUE_FLAGS,
  create: createSmartParserAnalysisResult,
  validate: validateSmartParserAnalysisResult,
  payloadHash: smartParserAnalysisPayloadHash,
  toProductChangeRequests: createProductChangeRequestsFromAnalysis,
});

globalThis.ONEAPP_SMARTPARSER_ANALYSIS_RESULT_V1 = smartParserAnalysisResultContract;
