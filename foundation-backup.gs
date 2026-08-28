/**
 * ONEAPP NEXUS Foundation B+ backup authority.
 *
 * Local databases remain the operational source.  This module only accepts
 * immutable backup versions and exposes payloads for an administrator-driven
 * restore flow.  It never mutates browser data and never performs a pull.
 */

const FOUNDATION_BACKUP_SCHEMA_VERSION = 'FOUNDATION_BACKUP_V1';
const FOUNDATION_BACKUP_CHUNK_SIZE = 42000;
const FOUNDATION_BACKUP_DOMAINS = Object.freeze({ PRODUCT: true, CUSTOMER: true });
const FOUNDATION_BACKUP_SHEETS = Object.freeze({
  HEAD: 'FoundationBackupHead',
  VERSION: 'FoundationBackupVersion',
  CHUNK: 'FoundationBackupChunk',
  EVENT: 'FoundationCustomerEvent',
  DEVICE: 'FoundationDevice',
  PRIMARY: 'FoundationPrimary',
  OPERATION: 'FoundationOperationResult',
  RESTORE_AUDIT: 'FoundationRestoreAudit'
});

function foundationBackupText(value) {
  return String(value == null ? '' : value).trim();
}

function foundationBackupClone(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function foundationBackupCanonical(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(foundationBackupCanonical).join(',') + ']';
  if (typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + foundationBackupCanonical(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function foundationBackupHash(value) {
  const text = typeof value === 'string' ? value : foundationBackupCanonical(value);
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return digest.map(function (signed) {
    const byte = signed < 0 ? signed + 256 : signed;
    return byte.toString(16).padStart(2, '0');
  }).join('');
}

function foundationBackupError(code, details) {
  const error = new Error(code);
  Object.keys(details || {}).forEach(function (key) { error[key] = details[key]; });
  return error;
}

function foundationBackupRequireCompany(auth) {
  const companyId = foundationBackupText(auth && auth.allowedScope && auth.allowedScope.companyId);
  if (!companyId) throw foundationBackupError('COMPANY_SCOPE_DENIED');
  return companyId;
}

function foundationBackupDomain(value) {
  const domainType = foundationBackupText(value).toUpperCase();
  if (!FOUNDATION_BACKUP_DOMAINS[domainType]) throw foundationBackupError('BACKUP_DOMAIN_INVALID');
  return domainType;
}

function foundationBackupEnsureHeader(sheet, headers) {
  if (sheet.getLastRow() > 0) return;
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function foundationBackupRows(sheet, width) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
}

function foundationBackupSheet(ss, kind, headers) {
  const sheet = getOrCreateSheet(ss, FOUNDATION_BACKUP_SHEETS[kind]);
  foundationBackupEnsureHeader(sheet, headers);
  return sheet;
}

const FOUNDATION_BACKUP_HEADERS = Object.freeze({
  HEAD: ['companyId', 'domainType', 'serverRevision', 'backupId', 'contentHash', 'schemaVersion', 'recordCount', 'deviceId', 'primaryEpoch', 'backupKind', 'createdAt', 'entityRevisionsJson'],
  VERSION: ['companyId', 'domainType', 'serverRevision', 'backupId', 'payloadDigest', 'contentHash', 'schemaVersion', 'recordCount', 'deviceId', 'primaryEpoch', 'backupKind', 'chunkCount', 'charCount', 'createdAt', 'actorUserId'],
  CHUNK: ['companyId', 'domainType', 'serverRevision', 'backupId', 'chunkIndex', 'chunkCount', 'payloadDigest', 'payloadChunk', 'createdAt'],
  EVENT: ['companyId', 'eventId', 'customerId', 'entityRevision', 'previousEntityRevision', 'backupId', 'eventHash', 'canonicalEvent', 'createdAt'],
  DEVICE: ['companyId', 'deviceId', 'displayName', 'status', 'registeredAt', 'updatedAt', 'actorUserId'],
  PRIMARY: ['companyId', 'deviceId', 'primaryEpoch', 'promotedAt', 'actorUserId', 'reason'],
  OPERATION: ['companyId', 'operationKey', 'payloadDigest', 'responseJson', 'createdAt'],
  RESTORE_AUDIT: ['companyId', 'restoreId', 'domainType', 'serverRevision', 'deviceId', 'result', 'localHashBefore', 'localHashAfter', 'recordCountBefore', 'recordCountAfter', 'createdAt', 'actorUserId']
});

function foundationBackupLatestHead(ss, companyId, domainType) {
  const sheet = ss.getSheetByName(FOUNDATION_BACKUP_SHEETS.HEAD);
  const rows = foundationBackupRows(sheet, FOUNDATION_BACKUP_HEADERS.HEAD.length)
    .filter(function (row) { return String(row[0]) === companyId && String(row[1]) === domainType; });
  if (!rows.length) return null;
  const row = rows[rows.length - 1];
  let entityRevisions = {};
  try { entityRevisions = JSON.parse(String(row[11] || '{}')); } catch (_) { entityRevisions = {}; }
  return {
    companyId: String(row[0]), domainType: String(row[1]), serverRevision: Number(row[2] || 0),
    backupId: String(row[3]), contentHash: String(row[4]), schemaVersion: String(row[5]),
    recordCount: Number(row[6] || 0), deviceId: String(row[7]), primaryEpoch: Number(row[8] || 0),
    backupKind: String(row[9]), createdAt: String(row[10]), entityRevisions: entityRevisions
  };
}

function foundationBackupLatestPrimary(ss, companyId) {
  const sheet = ss.getSheetByName(FOUNDATION_BACKUP_SHEETS.PRIMARY);
  const rows = foundationBackupRows(sheet, FOUNDATION_BACKUP_HEADERS.PRIMARY.length)
    .filter(function (row) { return String(row[0]) === companyId; });
  if (!rows.length) return null;
  const row = rows[rows.length - 1];
  return { companyId: String(row[0]), deviceId: String(row[1]), primaryEpoch: Number(row[2] || 0), promotedAt: String(row[3]) };
}

function foundationBackupRegisteredDevice(ss, companyId, deviceId) {
  const sheet = ss.getSheetByName(FOUNDATION_BACKUP_SHEETS.DEVICE);
  const rows = foundationBackupRows(sheet, FOUNDATION_BACKUP_HEADERS.DEVICE.length)
    .filter(function (row) { return String(row[0]) === companyId && String(row[1]) === deviceId; });
  if (!rows.length) return null;
  const row = rows[rows.length - 1];
  return { companyId: String(row[0]), deviceId: String(row[1]), displayName: String(row[2]), status: String(row[3]), registeredAt: String(row[4]), updatedAt: String(row[5]) };
}

function foundationBackupFindOperation(ss, companyId, operationKey) {
  const sheet = ss.getSheetByName(FOUNDATION_BACKUP_SHEETS.OPERATION);
  const rows = foundationBackupRows(sheet, FOUNDATION_BACKUP_HEADERS.OPERATION.length)
    .filter(function (row) { return String(row[0]) === companyId && String(row[1]) === operationKey; });
  if (!rows.length) return null;
  const row = rows[rows.length - 1];
  return { payloadDigest: String(row[2]), response: JSON.parse(String(row[3] || '{}')) };
}

function foundationBackupRememberOperation(ss, companyId, operationKey, payloadDigest, response, now) {
  const existing = foundationBackupFindOperation(ss, companyId, operationKey);
  if (existing) {
    if (existing.payloadDigest !== payloadDigest) throw foundationBackupError('IDEMPOTENCY_PAYLOAD_MISMATCH');
    return existing.response;
  }
  foundationBackupSheet(ss, 'OPERATION', FOUNDATION_BACKUP_HEADERS.OPERATION)
    .appendRow([companyId, operationKey, payloadDigest, JSON.stringify(response), now]);
  return response;
}

function foundationBackupValidateCommon(payload, expectedKind) {
  if (!payload || payload.schemaVersion !== FOUNDATION_BACKUP_SCHEMA_VERSION) throw foundationBackupError('BACKUP_SCHEMA_UNSUPPORTED');
  const domainType = foundationBackupDomain(payload.domainType);
  const backupKind = foundationBackupText(payload.backupKind).toUpperCase();
  if (backupKind !== expectedKind) throw foundationBackupError('BACKUP_KIND_INVALID');
  const backupId = foundationBackupText(payload.backupId);
  const deviceId = foundationBackupText(payload.deviceId);
  if (!/^[A-Z0-9][A-Z0-9._:-]{7,127}$/i.test(backupId)) throw foundationBackupError('BACKUP_ID_INVALID');
  if (!/^DEV-[A-Z0-9._:-]{8,127}$/i.test(deviceId)) throw foundationBackupError('DEVICE_ID_INVALID');
  const baseServerRevision = Number(payload.baseServerRevision);
  const localRevision = Number(payload.localRevision);
  const primaryEpoch = Number(payload.primaryEpoch);
  const recordCount = Number(payload.recordCount);
  if (![baseServerRevision, localRevision, primaryEpoch, recordCount].every(Number.isInteger)
      || baseServerRevision < 0 || localRevision < 1 || primaryEpoch < 1 || recordCount < 0) {
    throw foundationBackupError('BACKUP_REVISION_INVALID');
  }
  return { domainType, backupKind, backupId, deviceId, baseServerRevision, localRevision, primaryEpoch, recordCount };
}

function foundationBackupAssertPrimary(primary, device, common) {
  if (!device || device.status !== 'ACTIVE') throw foundationBackupError('PRIMARY_DEVICE_REQUIRED');
  if (!primary || primary.deviceId !== common.deviceId) throw foundationBackupError('PRIMARY_DEVICE_REQUIRED');
  if (Number(primary.primaryEpoch) !== common.primaryEpoch) throw foundationBackupError('PRIMARY_EPOCH_STALE', { primaryEpoch: Number(primary.primaryEpoch || 0) });
}

function foundationBackupRevisionDecision(headRevision, baseServerRevision) {
  const head = Number(headRevision || 0);
  const base = Number(baseServerRevision || 0);
  if (base < head) return { status: 'DIVERGED', code: 'BACKUP_BASE_REVISION_STALE', headRevision: head };
  if (base > head) return { status: 'REVISION_AHEAD_INVALID', code: 'BACKUP_BASE_REVISION_AHEAD', headRevision: head };
  return { status: 'ACCEPT', code: '', headRevision: head };
}

function foundationBackupValidateCustomerEvents(events, previousRevisions) {
  if (!Array.isArray(events) || !events.length || events.length > 500) throw foundationBackupError('CUSTOMER_EVENT_BATCH_INVALID');
  const next = Object.assign({}, previousRevisions || {});
  const ids = {};
  events.forEach(function (event) {
    const eventId = foundationBackupText(event && event.eventId);
    const customerId = foundationBackupText(event && event.customerId);
    const current = Number(event && event.entityRevision);
    const previous = Number(event && event.previousEntityRevision);
    if (!eventId || !customerId || !Number.isInteger(current) || !Number.isInteger(previous) || current !== previous + 1) {
      throw foundationBackupError('CUSTOMER_EVENT_REVISION_INVALID');
    }
    if (ids[eventId]) throw foundationBackupError('CUSTOMER_EVENT_DUPLICATE');
    ids[eventId] = true;
    const known = Number(next[customerId] || 0);
    if (known !== previous) throw foundationBackupError('CUSTOMER_EVENT_SEQUENCE_CONFLICT', { customerId: customerId, expectedRevision: known });
    next[customerId] = current;
  });
  return next;
}

function foundationBackupValidateCustomerSnapshot(snapshot) {
  const customers = Array.isArray(snapshot && snapshot.customers) ? snapshot.customers : [];
  const customerIds = {};
  customers.forEach(function (customer) {
    const id = foundationBackupText(customer && customer.customerId);
    if (!id || customerIds[id]) throw foundationBackupError('CUSTOMER_SNAPSHOT_ID_INVALID');
    customerIds[id] = true;
  });
  ['aliases', 'sourceLinks'].forEach(function (key) {
    (Array.isArray(snapshot && snapshot[key]) ? snapshot[key] : []).forEach(function (row) {
      if (!customerIds[foundationBackupText(row && row.customerId)]) throw foundationBackupError('CUSTOMER_SNAPSHOT_REFERENCE_INVALID');
    });
  });
  customers.forEach(function (customer) {
    if (foundationBackupText(customer.qualityStatus) === 'SUPERSEDED'
        && !customerIds[foundationBackupText(customer.canonicalCustomerId || customer.supersededByCustomerId)]) {
      throw foundationBackupError('CUSTOMER_SNAPSHOT_REFERENCE_INVALID');
    }
  });
  return customers.reduce(function (map, customer) {
    map[foundationBackupText(customer.customerId)] = Math.max(1, Number(customer.revision || 1));
    return map;
  }, {});
}

function foundationBackupReadVersionPayload(ss, companyId, domainType, serverRevision) {
  const versionSheet = ss.getSheetByName(FOUNDATION_BACKUP_SHEETS.VERSION);
  const versions = foundationBackupRows(versionSheet, FOUNDATION_BACKUP_HEADERS.VERSION.length)
    .filter(function (row) { return String(row[0]) === companyId && String(row[1]) === domainType && Number(row[2]) === Number(serverRevision); });
  if (!versions.length) throw foundationBackupError('BACKUP_VERSION_NOT_FOUND');
  const version = versions[versions.length - 1];
  const chunkSheet = ss.getSheetByName(FOUNDATION_BACKUP_SHEETS.CHUNK);
  const chunks = foundationBackupRows(chunkSheet, FOUNDATION_BACKUP_HEADERS.CHUNK.length)
    .filter(function (row) { return String(row[0]) === companyId && String(row[1]) === domainType && Number(row[2]) === Number(serverRevision) && String(row[3]) === String(version[3]); })
    .sort(function (left, right) { return Number(left[4]) - Number(right[4]); });
  const expectedCount = Number(version[11]);
  if (chunks.length !== expectedCount || chunks.some(function (row) { return Number(row[5]) !== expectedCount || String(row[6]) !== String(version[5]); })) {
    throw foundationBackupError('BACKUP_VERSION_CORRUPT');
  }
  const canonical = chunks.map(function (row) { return String(row[7] || ''); }).join('');
  if (canonical.length !== Number(version[12]) || foundationBackupHash(canonical) !== String(version[5])) throw foundationBackupError('BACKUP_VERSION_CORRUPT');
  return { version: version, payload: JSON.parse(canonical) };
}

function foundationBackupPersistVersion(ss, companyId, common, request, body, contentHash, payloadDigest, entityRevisions, auth, now) {
  const serverRevision = common.baseServerRevision + 1;
  const canonical = foundationBackupCanonical(body);
  const chunks = splitTextBySize(canonical, FOUNDATION_BACKUP_CHUNK_SIZE);
  const chunkSheet = foundationBackupSheet(ss, 'CHUNK', FOUNDATION_BACKUP_HEADERS.CHUNK);
  const start = chunkSheet.getLastRow() + 1;
  const rows = chunks.map(function (chunk, index) {
    return [companyId, common.domainType, serverRevision, common.backupId, index + 1, chunks.length, contentHash, chunk, now];
  });
  chunkSheet.getRange(start, 1, rows.length, FOUNDATION_BACKUP_HEADERS.CHUNK.length).setValues(rows);

  const verification = rows.map(function (row) { return String(row[7]); }).join('');
  if (foundationBackupHash(verification) !== contentHash || verification !== canonical) throw foundationBackupError('BACKUP_STAGE_VERIFY_FAILED');

  if (common.backupKind === 'CUSTOMER_EVENTS') {
    const eventSheet = foundationBackupSheet(ss, 'EVENT', FOUNDATION_BACKUP_HEADERS.EVENT);
    const existing = foundationBackupRows(eventSheet, FOUNDATION_BACKUP_HEADERS.EVENT.length)
      .filter(function (row) { return String(row[0]) === companyId; })
      .reduce(function (map, row) { map[String(row[1])] = String(row[6]); return map; }, {});
    body.events.forEach(function (event) {
      const eventHash = foundationBackupHash(event);
      const eventId = foundationBackupText(event.eventId);
      if (existing[eventId] && existing[eventId] !== eventHash) throw foundationBackupError('CUSTOMER_EVENT_REPLAY_MISMATCH');
      if (!existing[eventId]) eventSheet.appendRow([companyId, eventId, foundationBackupText(event.customerId), Number(event.entityRevision), Number(event.previousEntityRevision), common.backupId, eventHash, foundationBackupCanonical(event), now]);
    });
  }

  foundationBackupSheet(ss, 'VERSION', FOUNDATION_BACKUP_HEADERS.VERSION).appendRow([
    companyId, common.domainType, serverRevision, common.backupId, payloadDigest, contentHash,
    request.schemaVersion, common.recordCount, common.deviceId, common.primaryEpoch, common.backupKind,
    chunks.length, canonical.length, now, foundationBackupText(auth && auth.nexusRequest && auth.nexusRequest.subjectUserId)
  ]);
  foundationBackupReadVersionPayload(ss, companyId, common.domainType, serverRevision);
  foundationBackupSheet(ss, 'HEAD', FOUNDATION_BACKUP_HEADERS.HEAD).appendRow([
    companyId, common.domainType, serverRevision, common.backupId, contentHash, request.schemaVersion,
    common.recordCount, common.deviceId, common.primaryEpoch, common.backupKind, now, JSON.stringify(entityRevisions || {})
  ]);
  return serverRevision;
}

function foundationBackupRepairPendingVersions(ss, companyId, domainType) {
  let head = foundationBackupLatestHead(ss, companyId, domainType);
  const versionSheet = ss.getSheetByName(FOUNDATION_BACKUP_SHEETS.VERSION);
  if (!versionSheet) return head;
  const versions = foundationBackupRows(versionSheet, FOUNDATION_BACKUP_HEADERS.VERSION.length)
    .filter(function (row) { return String(row[0]) === companyId && String(row[1]) === domainType && Number(row[2]) > Number(head && head.serverRevision || 0); })
    .sort(function (left, right) { return Number(left[2]) - Number(right[2]); });
  while (versions.length) {
    const expectedRevision = Number(head && head.serverRevision || 0) + 1;
    const candidates = versions.filter(function (row) { return Number(row[2]) === expectedRevision; });
    if (!candidates.length) break;
    const backupIds = candidates.reduce(function (set, row) { set[String(row[3])] = true; return set; }, {});
    if (Object.keys(backupIds).length !== 1) throw foundationBackupError('BACKUP_PENDING_VERSION_AMBIGUOUS', { serverRevision: expectedRevision });
    const row = candidates[candidates.length - 1];
    const loaded = foundationBackupReadVersionPayload(ss, companyId, domainType, expectedRevision);
    let entityRevisions = head && head.entityRevisions || {};
    const backupKind = String(row[10]);
    if (backupKind === 'CUSTOMER_EVENTS') entityRevisions = foundationBackupValidateCustomerEvents(loaded.payload.events, entityRevisions);
    if (backupKind === 'CUSTOMER_SNAPSHOT') entityRevisions = foundationBackupValidateCustomerSnapshot(loaded.payload);
    foundationBackupSheet(ss, 'HEAD', FOUNDATION_BACKUP_HEADERS.HEAD).appendRow([
      companyId, domainType, expectedRevision, String(row[3]), String(row[5]), String(row[6]),
      Number(row[7]), String(row[8]), Number(row[9]), backupKind, String(row[13]), JSON.stringify(entityRevisions || {})
    ]);
    head = foundationBackupLatestHead(ss, companyId, domainType);
    versions.splice(0, candidates.length);
  }
  return head;
}

function foundationBackupWrite(ss, payload, auth, expectedKind) {
  const companyId = foundationBackupRequireCompany(auth);
  const common = foundationBackupValidateCommon(payload, expectedKind);
  const body = expectedKind === 'PRODUCT_SNAPSHOT' ? payload.snapshot
    : (expectedKind === 'CUSTOMER_EVENTS' ? { events: payload.events } : payload.snapshot);
  if (!body || typeof body !== 'object') throw foundationBackupError('BACKUP_PAYLOAD_INVALID');
  const contentHash = foundationBackupHash(body);
  if (foundationBackupText(payload.contentHash).toLowerCase() !== contentHash) throw foundationBackupError('BACKUP_HASH_MISMATCH');
  const payloadDigest = foundationBackupHash({
    schemaVersion: payload.schemaVersion, domainType: common.domainType, backupKind: common.backupKind,
    backupId: common.backupId, deviceId: common.deviceId, baseServerRevision: common.baseServerRevision,
    localRevision: common.localRevision, primaryEpoch: common.primaryEpoch, recordCount: common.recordCount,
    contentHash: contentHash, body: body
  });
  const replay = foundationBackupFindOperation(ss, companyId, common.backupId);
  if (replay) {
    if (replay.payloadDigest !== payloadDigest) throw foundationBackupError('IDEMPOTENCY_PAYLOAD_MISMATCH');
    return Object.assign({}, replay.response, { replayed: true });
  }
  const repairedHead = foundationBackupRepairPendingVersions(ss, companyId, common.domainType);
  const versionSheet = ss.getSheetByName(FOUNDATION_BACKUP_SHEETS.VERSION);
  const replayVersion = foundationBackupRows(versionSheet, FOUNDATION_BACKUP_HEADERS.VERSION.length)
    .find(function (row) { return String(row[0]) === companyId && String(row[3]) === common.backupId; });
  if (replayVersion) {
    if (String(replayVersion[4]) !== payloadDigest) throw foundationBackupError('IDEMPOTENCY_PAYLOAD_MISMATCH');
    return { status: 'ACKED', replayed: true, backupId: common.backupId, domainType: common.domainType, serverRevision: Number(replayVersion[2]), contentHash: contentHash };
  }

  foundationBackupAssertPrimary(
    foundationBackupLatestPrimary(ss, companyId),
    foundationBackupRegisteredDevice(ss, companyId, common.deviceId),
    common
  );
  const head = repairedHead || foundationBackupLatestHead(ss, companyId, common.domainType);
  const decision = foundationBackupRevisionDecision(head && head.serverRevision, common.baseServerRevision);
  if (decision.status !== 'ACCEPT') {
    const rejected = { status: decision.status, code: decision.code, backupId: common.backupId, domainType: common.domainType, headRevision: decision.headRevision };
    foundationBackupRememberOperation(ss, companyId, common.backupId, payloadDigest, rejected, new Date().toISOString());
    return rejected;
  }

  if (head && head.contentHash === contentHash && expectedKind !== 'CUSTOMER_EVENTS') {
    const duplicate = { status: 'ACKED', duplicateContent: true, backupId: common.backupId, domainType: common.domainType, serverRevision: head.serverRevision, contentHash: contentHash };
    foundationBackupRememberOperation(ss, companyId, common.backupId, payloadDigest, duplicate, new Date().toISOString());
    return duplicate;
  }

  let entityRevisions = head && head.entityRevisions || {};
  if (expectedKind === 'CUSTOMER_EVENTS') entityRevisions = foundationBackupValidateCustomerEvents(payload.events, entityRevisions);
  if (expectedKind === 'CUSTOMER_SNAPSHOT') entityRevisions = foundationBackupValidateCustomerSnapshot(payload.snapshot);
  const actualRecordCount = expectedKind === 'CUSTOMER_EVENTS' ? payload.events.length
    : (common.domainType === 'PRODUCT' ? (Array.isArray(payload.snapshot && payload.snapshot.products) ? payload.snapshot.products.length : 0)
      : (Array.isArray(payload.snapshot && payload.snapshot.customers) ? payload.snapshot.customers.length : 0));
  if (actualRecordCount !== common.recordCount) throw foundationBackupError('BACKUP_RECORD_COUNT_MISMATCH');

  const now = new Date().toISOString();
  const serverRevision = foundationBackupPersistVersion(ss, companyId, common, payload, body, contentHash, payloadDigest, entityRevisions, auth, now);
  const response = { status: 'ACKED', replayed: false, backupId: common.backupId, domainType: common.domainType, serverRevision: serverRevision, contentHash: contentHash, ackedAt: now };
  return foundationBackupRememberOperation(ss, companyId, common.backupId, payloadDigest, response, now);
}

function foundationBackupHeadRead(ss, payload, auth) {
  if (!payload || payload.schemaVersion !== FOUNDATION_BACKUP_SCHEMA_VERSION) throw foundationBackupError('BACKUP_SCHEMA_UNSUPPORTED');
  const companyId = foundationBackupRequireCompany(auth);
  const requested = foundationBackupText(payload.domainType).toUpperCase();
  const domains = requested ? [foundationBackupDomain(requested)] : Object.keys(FOUNDATION_BACKUP_DOMAINS);
  const primary = foundationBackupLatestPrimary(ss, companyId);
  return {
    schemaVersion: FOUNDATION_BACKUP_SCHEMA_VERSION,
    heads: domains.map(function (domain) { return foundationBackupLatestHead(ss, companyId, domain) || { companyId: companyId, domainType: domain, serverRevision: 0, recordCount: 0, contentHash: '', createdAt: '' }; }),
    primary: primary || { companyId: companyId, deviceId: '', primaryEpoch: 0, promotedAt: '' }
  };
}

function foundationBackupDeviceRegister(ss, payload, auth) {
  if (!payload || payload.schemaVersion !== FOUNDATION_BACKUP_SCHEMA_VERSION) throw foundationBackupError('BACKUP_SCHEMA_UNSUPPORTED');
  const companyId = foundationBackupRequireCompany(auth);
  const deviceId = foundationBackupText(payload.deviceId);
  if (!/^DEV-[A-Z0-9._:-]{8,127}$/i.test(deviceId)) throw foundationBackupError('DEVICE_ID_INVALID');
  const now = new Date().toISOString();
  const previous = foundationBackupRegisteredDevice(ss, companyId, deviceId);
  const displayName = foundationBackupText(payload.displayName).slice(0, 100) || 'NEXUS 장치';
  foundationBackupSheet(ss, 'DEVICE', FOUNDATION_BACKUP_HEADERS.DEVICE).appendRow([
    companyId, deviceId, displayName, 'ACTIVE', previous && previous.registeredAt || now, now,
    foundationBackupText(auth && auth.nexusRequest && auth.nexusRequest.subjectUserId)
  ]);
  const primary = foundationBackupLatestPrimary(ss, companyId);
  return { schemaVersion: FOUNDATION_BACKUP_SCHEMA_VERSION, deviceId: deviceId, displayName: displayName, status: 'ACTIVE', isPrimary: Boolean(primary && primary.deviceId === deviceId), primaryEpoch: Number(primary && primary.primaryEpoch || 0) };
}

function foundationBackupDeviceStatus(ss, payload, auth) {
  if (!payload || payload.schemaVersion !== FOUNDATION_BACKUP_SCHEMA_VERSION) throw foundationBackupError('BACKUP_SCHEMA_UNSUPPORTED');
  const companyId = foundationBackupRequireCompany(auth);
  const deviceId = foundationBackupText(payload.deviceId);
  const device = foundationBackupRegisteredDevice(ss, companyId, deviceId);
  const primary = foundationBackupLatestPrimary(ss, companyId);
  return { schemaVersion: FOUNDATION_BACKUP_SCHEMA_VERSION, device: device, primary: primary, isPrimary: Boolean(device && primary && primary.deviceId === deviceId) };
}

function foundationBackupDevicePromote(ss, payload, auth) {
  if (!payload || payload.schemaVersion !== FOUNDATION_BACKUP_SCHEMA_VERSION) throw foundationBackupError('BACKUP_SCHEMA_UNSUPPORTED');
  const companyId = foundationBackupRequireCompany(auth);
  const deviceId = foundationBackupText(payload.deviceId);
  const device = foundationBackupRegisteredDevice(ss, companyId, deviceId);
  if (!device || device.status !== 'ACTIVE') throw foundationBackupError('DEVICE_NOT_REGISTERED');
  const previous = foundationBackupLatestPrimary(ss, companyId);
  const expectedEpoch = Number(payload.expectedPrimaryEpoch || 0);
  if (expectedEpoch !== Number(previous && previous.primaryEpoch || 0)) throw foundationBackupError('PRIMARY_EPOCH_CONFLICT', { primaryEpoch: Number(previous && previous.primaryEpoch || 0) });
  const nextEpoch = expectedEpoch + 1;
  const now = new Date().toISOString();
  foundationBackupSheet(ss, 'PRIMARY', FOUNDATION_BACKUP_HEADERS.PRIMARY).appendRow([
    companyId, deviceId, nextEpoch, now,
    foundationBackupText(auth && auth.nexusRequest && auth.nexusRequest.subjectUserId),
    foundationBackupText(payload.reason).slice(0, 500)
  ]);
  return { schemaVersion: FOUNDATION_BACKUP_SCHEMA_VERSION, deviceId: deviceId, primaryEpoch: nextEpoch, promotedAt: now };
}

function foundationBackupVersionList(ss, payload, auth) {
  if (!payload || payload.schemaVersion !== FOUNDATION_BACKUP_SCHEMA_VERSION) throw foundationBackupError('BACKUP_SCHEMA_UNSUPPORTED');
  const companyId = foundationBackupRequireCompany(auth);
  const domainType = foundationBackupDomain(payload.domainType);
  const limit = Math.max(1, Math.min(100, Number(payload.limit || 20)));
  const sheet = ss.getSheetByName(FOUNDATION_BACKUP_SHEETS.VERSION);
  return foundationBackupRows(sheet, FOUNDATION_BACKUP_HEADERS.VERSION.length)
    .filter(function (row) { return String(row[0]) === companyId && String(row[1]) === domainType; })
    .slice(-limit).reverse().map(function (row) {
      return { domainType: String(row[1]), serverRevision: Number(row[2]), backupId: String(row[3]), contentHash: String(row[5]), schemaVersion: String(row[6]), recordCount: Number(row[7]), deviceId: String(row[8]), primaryEpoch: Number(row[9]), backupKind: String(row[10]), createdAt: String(row[13]), actorUserId: String(row[14]) };
    });
}

function foundationBackupVersionRead(ss, payload, auth) {
  if (!payload || payload.schemaVersion !== FOUNDATION_BACKUP_SCHEMA_VERSION) throw foundationBackupError('BACKUP_SCHEMA_UNSUPPORTED');
  const companyId = foundationBackupRequireCompany(auth);
  const domainType = foundationBackupDomain(payload.domainType);
  const serverRevision = Number(payload.serverRevision);
  if (!Number.isInteger(serverRevision) || serverRevision < 1) throw foundationBackupError('BACKUP_REVISION_INVALID');
  const loaded = foundationBackupReadVersionPayload(ss, companyId, domainType, serverRevision);
  const row = loaded.version;
  return { schemaVersion: String(row[6]), domainType: domainType, serverRevision: serverRevision, backupId: String(row[3]), payloadDigest: String(row[4]), contentHash: String(row[5]), recordCount: Number(row[7]), deviceId: String(row[8]), primaryEpoch: Number(row[9]), backupKind: String(row[10]), createdAt: String(row[13]), payload: loaded.payload };
}

function foundationBackupRestoreAuditWrite(ss, payload, auth) {
  if (!payload || payload.schemaVersion !== FOUNDATION_BACKUP_SCHEMA_VERSION) throw foundationBackupError('BACKUP_SCHEMA_UNSUPPORTED');
  const companyId = foundationBackupRequireCompany(auth);
  const domainType = foundationBackupDomain(payload.domainType);
  const restoreId = foundationBackupText(payload.restoreId);
  if (!/^RST-[A-Z0-9._:-]{8,127}$/i.test(restoreId)) throw foundationBackupError('RESTORE_ID_INVALID');
  const digest = foundationBackupHash(payload);
  const previous = foundationBackupFindOperation(ss, companyId, restoreId);
  if (previous) {
    if (previous.payloadDigest !== digest) throw foundationBackupError('IDEMPOTENCY_PAYLOAD_MISMATCH');
    return Object.assign({}, previous.response, { replayed: true });
  }
  const now = new Date().toISOString();
  foundationBackupSheet(ss, 'RESTORE_AUDIT', FOUNDATION_BACKUP_HEADERS.RESTORE_AUDIT).appendRow([
    companyId, restoreId, domainType, Number(payload.serverRevision || 0), foundationBackupText(payload.deviceId),
    foundationBackupText(payload.result), foundationBackupText(payload.localHashBefore), foundationBackupText(payload.localHashAfter),
    Number(payload.recordCountBefore || 0), Number(payload.recordCountAfter || 0), now,
    foundationBackupText(auth && auth.nexusRequest && auth.nexusRequest.subjectUserId)
  ]);
  const response = { status: 'RECORDED', restoreId: restoreId, recordedAt: now };
  return foundationBackupRememberOperation(ss, companyId, restoreId, digest, response, now);
}
