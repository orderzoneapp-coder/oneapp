import { hashEstimatePlan } from './independent-estimate.js';

export const SMARTINPUT_ESTIMATE_MASTER_APPLY_SCHEMA = 'SMARTINPUT_ESTIMATE_MASTER_APPLY_V1';
export const SMARTINPUT_MASTER_INTENT_SCHEMA = 'ONEAPP_SMARTINPUT_ESTIMATE_MASTER_INTENT_V1';
export const ESTIMATE_MASTER_FIELDS = Object.freeze({
  purchasePriceB: '입고B', wholesaleA: '도매A', wholesaleB: '도매B', promoPrice: '행사가'
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const clone = value => structuredClone(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const jsonEqual = (a, b) => Object.is(a, b);
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function contextPresent({ companyId, actor }) {
  return nonempty(companyId) && nonempty(actor?.actorId) && nonempty(actor?.actorState);
}
const codeOf = value => typeof value === 'string' ? value.trim() : '';

/**
 * Builds an intent, not an authorization. The owner must independently validate the real
 * session, company ownership, product identity, source receipts and transaction preimages.
 * confirmedFields are read from durable estimate outcomes by the integrating controller;
 * a screen value or an optimistic UI success flag is not an eligible input source.
 */
export async function createEstimateMasterIntent({ enabled = false, commandId, operationId, companyId, actor,
  reason, baseSnapshotId, baseContentHash, expectedRevision, products = [], confirmedFields = [], selectedFields = [] } = {}) {
  if (!enabled) return freeze({ status: 'DISABLED', command: null, issues: [] });
  if (!contextPresent({ companyId, actor })) return freeze({ status: 'CONTEXT_REQUIRED', command: null, issues: [] });
  if (!nonempty(commandId) || !nonempty(operationId) || !nonempty(reason)
    || !nonempty(baseSnapshotId) || !nonempty(baseContentHash) || expectedRevision === undefined) fail('MASTER_COMMAND_EVIDENCE_REQUIRED');
  const fields = new Set(selectedFields);
  if ([...fields].some(field => !own(ESTIMATE_MASTER_FIELDS, field))) fail('MASTER_FIELD_NOT_ALLOWED');
  const productByCode = new Map();
  products.forEach(product => {
    const primary = codeOf(product?.['코드']);
    const secondary = codeOf(product?.['품목코드']);
    const code = primary || secondary;
    if (!code || (primary && secondary && primary !== secondary) || productByCode.has(code)) fail('MASTER_PRODUCT_IDENTITY_INVALID');
    productByCode.set(code, product);
  });
  const issues = [];
  const grouped = new Map();
  confirmedFields.forEach(source => {
    if (!fields.has(source.field)) return;
    if (!['SAVED', 'UNCHANGED'].includes(source.estimateStatus) || source.conflict === true) {
      issues.push({ code: 'MASTER_SOURCE_NOT_CONFIRMED', estimateId: source.estimateId || '', field: source.field });
      return;
    }
    if (source.companyId !== companyId || !nonempty(source.estimateId) || !nonempty(source.ownedRowId)
      || !nonempty(source.operationId) || !Number.isSafeInteger(source.estimateRevision) || source.estimateRevision < 0
      || !Array.isArray(source.sourceRefs) || !source.sourceRefs.length || source.sourceRefs.some(ref => !nonempty(ref))) {
      issues.push({ code: 'MASTER_SOURCE_EVIDENCE_REQUIRED', estimateId: source.estimateId || '', field: source.field });
      return;
    }
    if (['ABSENT', 'BLANK'].includes(source.valueKind)) return;
    const code = codeOf(source.code);
    const product = productByCode.get(code);
    if (!product || (source.productId && product.productId !== source.productId)) {
      issues.push({ code: 'MASTER_PRODUCT_UNRESOLVED', code, field: source.field });
      return;
    }
    if (source.valueKind === 'CLEAR' ? source.explicitClear !== true
      : source.valueKind !== 'VALUE' || typeof source.value !== 'number' || !Number.isFinite(source.value)) {
      issues.push({ code: 'MASTER_VALUE_NOT_AUTHORIZED', code, field: source.field });
      return;
    }
    // Numeric blanks are represented explicitly. This module never turns a blank into zero.
    const afterValue = source.valueKind === 'CLEAR' ? null : source.value;
    const field = ESTIMATE_MASTER_FIELDS[source.field];
    const key = JSON.stringify([code, field]);
    (grouped.get(key) || (grouped.set(key, []), grouped.get(key))).push({ source, product, code, field, afterValue });
  });
  const patches = [];
  const sources = new Map();
  grouped.forEach(group => {
    const first = group[0];
    if (group.some(item => !jsonEqual(item.afterValue, first.afterValue) || item.source.valueKind !== first.source.valueKind)) {
      issues.push({ code: 'MASTER_FIELD_VALUE_CONFLICT', code: first.code, field: first.field,
        estimateIds: [...new Set(group.map(item => item.source.estimateId))] });
      return;
    }
    const beforeValue = own(first.product, first.field) ? first.product[first.field] : null;
    if (beforeValue !== null && typeof beforeValue !== 'number' && typeof beforeValue !== 'string') {
      issues.push({ code: 'MASTER_PREIMAGE_TYPE_UNSUPPORTED', code: first.code, field: first.field });
      return;
    }
    patches.push({ code: first.code, field: first.field, beforeValue,
      beforePresent: own(first.product, first.field), afterValue: first.afterValue, valueKind: first.source.valueKind,
      sourceRefs: [...new Set(group.flatMap(item => item.source.sourceRefs))] });
    group.forEach(({ source }) => {
      const key = JSON.stringify([source.estimateId, source.estimateRevision, source.operationId]);
      if (!sources.has(key)) sources.set(key, { estimateId: source.estimateId, revision: source.estimateRevision,
        operationId: source.operationId, rowIds: [], fieldIds: [] });
      const entry = sources.get(key);
      if (!entry.rowIds.includes(source.ownedRowId)) entry.rowIds.push(source.ownedRowId);
      if (!entry.fieldIds.includes(source.field)) entry.fieldIds.push(source.field);
    });
  });
  if (!patches.length) return freeze({ status: issues.length ? 'REVIEW_REQUIRED' : 'NO_CANDIDATES', command: null, issues });
  const payload = { schemaVersion: SMARTINPUT_ESTIMATE_MASTER_APPLY_SCHEMA, sourceAppId: 'smart-input', ownerAppId: 'master-lookup',
    commandId, operationId, companyId, actor: clone(actor), reason, baseSnapshotId, baseContentHash,
    expectedRevision, sourceEstimates: [...sources.values()], patches };
  const command = { ...payload, payloadHash: await hashEstimatePlan(payload) };
  // Keep equal values in the command: only the owner can durably decide UNCHANGED.
  return freeze({ schemaVersion: SMARTINPUT_MASTER_INTENT_SCHEMA, status: issues.length ? 'PARTIAL_REVIEW' : 'READY',
    command, issues });
}

function validateIntent(intent) {
  const command = intent?.command;
  if (intent?.schemaVersion !== SMARTINPUT_MASTER_INTENT_SCHEMA || !command
    || command.schemaVersion !== SMARTINPUT_ESTIMATE_MASTER_APPLY_SCHEMA
    || command.sourceAppId !== 'smart-input' || command.ownerAppId !== 'master-lookup'
    || !contextPresent(command) || !nonempty(command.commandId) || !nonempty(command.payloadHash)) fail('MASTER_INTENT_INVALID');
  return command;
}
function queryArguments(command) {
  return { companyId: command.companyId, commandId: command.commandId, payloadHash: command.payloadHash, actor: clone(command.actor) };
}
function resultMatches(result, command) {
  return result?.companyId === command.companyId && result.commandId === command.commandId && result.payloadHash === command.payloadHash;
}
function unknown(command, code) {
  return { status: 'RESULT_UNKNOWN', companyId: command.companyId, commandId: command.commandId, payloadHash: command.payloadHash, code };
}

/**
 * A dependency-injected dispatch boundary, deliberately not connected to production yet.
 * persistIntent must resolve only after its transaction completes; it must CAS the full
 * immutable command under the same key and reject changed payloads for a reused commandId.
 * The owner independently enforces the same receipt rule in its own database transaction.
 */
export async function executeEstimateMasterIntent({ intent, persistIntent, owner, resume = false } = {}) {
  if (!intent?.command && ['DISABLED', 'CONTEXT_REQUIRED', 'NO_CANDIDATES', 'REVIEW_REQUIRED'].includes(intent?.status)) return clone(intent);
  const command = clone(validateIntent(intent));
  const { payloadHash, ...payload } = command;
  if (await hashEstimatePlan(payload) !== payloadHash) fail('MASTER_PAYLOAD_HASH_MISMATCH');
  if (typeof persistIntent !== 'function' || typeof owner?.commitReviewedSmartInputEstimate !== 'function'
    || typeof owner?.getSmartInputEstimateCommandResult !== 'function') fail('MASTER_CAPABILITY_UNAVAILABLE');
  let recoveredIntent = false;
  try {
    const persisted = await persistIntent(freeze(clone(intent)));
    if (!persisted?.durable || !resultMatches(persisted, command)) fail('MASTER_INTENT_NOT_DURABLE');
    recoveredIntent = persisted.existing === true;
  } catch (error) {
    return { status: 'NOT_DISPATCHED', commandId: command.commandId, code: error.code || error.message };
  }
  if (resume || recoveredIntent) {
    let result;
    try { result = await owner.getSmartInputEstimateCommandResult(queryArguments(command)); }
    catch (error) { return unknown(command, error.code || 'MASTER_RESULT_LOOKUP_FAILED'); }
    if (!resultMatches(result, command)) return unknown(command, 'MASTER_RESULT_IDENTITY_MISMATCH');
    if (['APPLIED', 'UNCHANGED', 'CONFLICT'].includes(result.status)) return clone(result);
    if (result.status !== 'CONFIRMED_NOT_APPLIED') return unknown(command, 'MASTER_PRIOR_RESULT_UNRESOLVED');
  }
  try {
    const result = await owner.commitReviewedSmartInputEstimate(freeze(command));
    if (!resultMatches(result, command)) return unknown(command, 'MASTER_RESULT_IDENTITY_MISMATCH');
    if (['APPLIED', 'UNCHANGED', 'FAILED', 'CONFLICT', 'CONTEXT_REQUIRED', 'RESULT_UNKNOWN'].includes(result.status)) return clone(result);
    return unknown(command, 'MASTER_RESULT_UNRECOGNIZED');
  } catch (error) {
    // A thrown transport/read/post-commit error does not establish that no write happened.
    return unknown(command, error.code || 'MASTER_RESULT_UNRESOLVED');
  }
}

/** Resume history/notification publication only. Never call a product commit here. */
export async function resumeEstimateMasterPublication({ intent, owner } = {}) {
  const command = validateIntent(intent);
  if (typeof owner?.resumeSmartInputEstimateCommandPublication !== 'function') fail('MASTER_PUBLICATION_CAPABILITY_UNAVAILABLE');
  const result = await owner.resumeSmartInputEstimateCommandPublication({ companyId: command.companyId, commandId: command.commandId, actor: clone(command.actor) });
  if (!resultMatches(result, command)) return unknown(command, 'MASTER_RESULT_IDENTITY_MISMATCH');
  return clone(result);
}
