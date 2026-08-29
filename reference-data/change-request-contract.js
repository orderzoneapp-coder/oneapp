export const REFERENCE_CHANGE_REQUEST_SCHEMA_VERSION = 'ONEAPP_REFERENCE_CHANGE_REQUEST_V1';

export const REFERENCE_CHANGE_REQUEST_DOMAIN_OWNER = Object.freeze({
  PRODUCT: 'master-lookup',
  CUSTOMER: 'customer-master',
});

export const REFERENCE_CHANGE_REQUEST_OPERATIONS = Object.freeze([
  'CREATE',
  'UPDATE',
  'STATUS_CHANGE',
  'MAPPING_CHANGE',
]);

export const REFERENCE_CHANGE_REQUEST_STATUSES = Object.freeze([
  'PENDING',
  'DUPLICATE',
  'REJECTED',
  'APPLIED',
  'CONFLICT',
  'NOT_AVAILABLE',
  'ERROR',
]);

const REVISION_REQUIRED_OPERATIONS = new Set(['UPDATE', 'STATUS_CHANGE', 'MAPPING_CHANGE']);
const ACTOR_STATES = new Set(['VERIFIED', 'LAST_VERIFIED_OFFLINE', 'UNVERIFIED_LOCAL']);
const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'passphrase', 'accesstoken', 'refreshtoken', 'sessiontoken',
  'authtoken', 'apikey', 'clientsecret', 'secret', 'credential', 'credentials',
  'certificate', 'certificatepem', 'privatekey', 'residentregistrationnumber', 'ssn',
  '비밀번호', '암호', '토큰', '인증서', '개인키', '주민등록번호',
]);

const clean = (value) => String(value ?? '').trim();
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : stableStringify(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function cloneJson(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  Object.values(value).forEach((entry) => deepFreeze(entry, seen));
  return Object.freeze(value);
}

function normalizedKey(value) {
  return clean(value).normalize('NFKC').toLocaleLowerCase('en').replace(/[\s_.\-/]/g, '');
}

function sensitiveValueReason(value) {
  if (typeof value !== 'string') return '';
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)) return 'PRIVATE_KEY_VALUE_NOT_ALLOWED';
  if (/(?:^|\D)\d{6}-[1-8]\d{6}(?:\D|$)/.test(value)) return 'RESIDENT_NUMBER_VALUE_NOT_ALLOWED';
  return '';
}

function inspectSensitiveValues(value, path, errors, seen = new WeakSet()) {
  if (value === null || value === undefined) return;
  const valueReason = sensitiveValueReason(value);
  if (valueReason) errors.push({ code: valueReason, path });
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  Object.entries(value).forEach(([key, entry]) => {
    const entryPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEYS.has(normalizedKey(key))) errors.push({ code: 'SENSITIVE_KEY_NOT_ALLOWED', path: entryPath });
    inspectSensitiveValues(entry, entryPath, errors, seen);
  });
}

export function validateReferenceChangeRequest(input, options = {}) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return deepFreeze({ valid: false, errors: [{ code: 'REQUEST_OBJECT_REQUIRED', path: '' }] });
  }

  const requiredText = [
    'requestId', 'idempotencyKey', 'domain', 'ownerAppId', 'entityId', 'operation', 'requestedAt',
  ];
  requiredText.forEach((field) => {
    if (!clean(input[field])) errors.push({ code: 'REQUIRED_FIELD_MISSING', path: field });
  });
  if (input.schemaVersion !== REFERENCE_CHANGE_REQUEST_SCHEMA_VERSION) {
    errors.push({ code: 'SCHEMA_VERSION_INVALID', path: 'schemaVersion' });
  }

  const domain = clean(input.domain).toUpperCase();
  const expectedOwner = REFERENCE_CHANGE_REQUEST_DOMAIN_OWNER[domain];
  if (!expectedOwner) errors.push({ code: 'DOMAIN_INVALID', path: 'domain' });
  else if (clean(input.ownerAppId) !== expectedOwner) errors.push({ code: 'DOMAIN_OWNER_MISMATCH', path: 'ownerAppId' });
  if (options.expectedDomain && domain !== options.expectedDomain) errors.push({ code: 'OWNER_DOMAIN_REJECTED', path: 'domain' });
  if (options.expectedOwnerAppId && clean(input.ownerAppId) !== options.expectedOwnerAppId) {
    errors.push({ code: 'OWNER_APP_REJECTED', path: 'ownerAppId' });
  }

  const operation = clean(input.operation).toUpperCase();
  if (!REFERENCE_CHANGE_REQUEST_OPERATIONS.includes(operation)) errors.push({ code: 'OPERATION_INVALID', path: 'operation' });
  if (REVISION_REQUIRED_OPERATIONS.has(operation)) {
    if (!clean(input.baseSnapshotId)) errors.push({ code: 'BASE_SNAPSHOT_REQUIRED', path: 'baseSnapshotId' });
    if (input.baseRevision === undefined || input.baseRevision === null || input.baseRevision === '') {
      errors.push({ code: 'BASE_REVISION_REQUIRED', path: 'baseRevision' });
    }
  }

  if (!Array.isArray(input.changes) || input.changes.length === 0) {
    errors.push({ code: 'CHANGES_REQUIRED', path: 'changes' });
  } else {
    const fields = new Set();
    input.changes.forEach((change, index) => {
      const path = `changes[${index}]`;
      const field = clean(change?.field);
      if (!field) errors.push({ code: 'CHANGE_FIELD_REQUIRED', path: `${path}.field` });
      const normalizedField = normalizedKey(field);
      if (field && fields.has(normalizedField)) errors.push({ code: 'DUPLICATE_CHANGE_FIELD', path: `${path}.field` });
      fields.add(normalizedField);
      if (SENSITIVE_KEYS.has(normalizedField)) errors.push({ code: 'SENSITIVE_FIELD_NOT_ALLOWED', path: `${path}.field` });
      if (!change || !hasOwn(change, 'beforeValue')) errors.push({ code: 'BEFORE_VALUE_REQUIRED', path: `${path}.beforeValue` });
      if (!change || !hasOwn(change, 'proposedValue')) errors.push({ code: 'PROPOSED_VALUE_REQUIRED', path: `${path}.proposedValue` });
    });
  }

  if (!input.source || typeof input.source !== 'object' || !clean(input.source.appId)) {
    errors.push({ code: 'SOURCE_APP_ID_REQUIRED', path: 'source.appId' });
  }
  const requestedAt = clean(input.requestedAt);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(requestedAt)
    || !Number.isFinite(Date.parse(requestedAt))) {
    errors.push({ code: 'REQUESTED_AT_INVALID', path: 'requestedAt' });
  }
  if (input.actor?.actorState && !ACTOR_STATES.has(clean(input.actor.actorState))) {
    errors.push({ code: 'ACTOR_STATE_INVALID', path: 'actor.actorState' });
  }

  inspectSensitiveValues(input, '', errors);
  return deepFreeze({ valid: errors.length === 0, errors });
}

export async function referenceChangeRequestPayloadHash(input) {
  return sha256Hex(input);
}

export function rejectedChangeRequestResult(input, validation) {
  return deepFreeze({
    schemaVersion: REFERENCE_CHANGE_REQUEST_SCHEMA_VERSION,
    accepted: false,
    status: 'REJECTED',
    requestId: clean(input?.requestId),
    idempotencyKey: clean(input?.idempotencyKey),
    errors: cloneJson(validation?.errors || []),
  });
}

export const referenceChangeRequestContract = deepFreeze({
  schemaVersion: REFERENCE_CHANGE_REQUEST_SCHEMA_VERSION,
  domainOwner: REFERENCE_CHANGE_REQUEST_DOMAIN_OWNER,
  operations: REFERENCE_CHANGE_REQUEST_OPERATIONS,
  statuses: REFERENCE_CHANGE_REQUEST_STATUSES,
  validate: validateReferenceChangeRequest,
  payloadHash: referenceChangeRequestPayloadHash,
});

globalThis.ONEAPP_REFERENCE_CHANGE_REQUEST_V1 = referenceChangeRequestContract;
globalThis.ONEAPP_REFERENCE_CHANGE_REQUEST_CONTRACT = referenceChangeRequestContract;
