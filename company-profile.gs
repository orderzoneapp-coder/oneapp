/**
 * NEXUS company profile V1.
 * Server-owned company profile, accounting periods, audit, backups and one-time migration.
 */

const COMPANY_PROFILE_SCHEMA_VERSION = 'NEXUS_COMPANY_PROFILE_V1';
const COMPANY_PUBLIC_FOOTER_SCHEMA_VERSION = 'NEXUS_COMPANY_PUBLIC_FOOTER_V1';
const COMPANY_PROFILE_TASK_ID = 'NEXUS-COMPANY-20260827-01';
const COMPANY_PROFILE_DEFAULT_COMPANY_ID = 'ONEAPP';
const COMPANY_PROFILE_SERVICE_ACTOR = 'DEPLOYMENT_SERVICE:NEXUS_GATEWAY';
const COMPANY_PROFILE_SHEETS = Object.freeze({
  PROFILE: 'CompanyProfile_NEXUS',
  PERIODS: 'CompanyAccountingPeriods_NEXUS',
  AUDIT: 'CompanyAudit_NEXUS',
  BACKUPS: 'CompanyBackups_NEXUS',
  MIGRATIONS: 'CompanyMigrations_NEXUS'
});
const COMPANY_PROFILE_HEADERS = Object.freeze({
  PROFILE: ['companyId', 'schemaVersion', 'revision', 'updatedAt', 'updatedBy', 'payloadJson', 'payloadHash'],
  PERIODS: ['companyId', 'periodId', 'revision', 'periodNumber', 'startDate', 'endDate', 'enabled', 'updatedAt', 'updatedBy'],
  AUDIT: ['auditId', 'companyId', 'entityType', 'entityId', 'operation', 'beforeJson', 'afterJson', 'revision', 'requestId', 'actorUserId', 'actorLoginId', 'actorType', 'at'],
  BACKUPS: ['backupId', 'companyId', 'createdAt', 'revision', 'profileJson', 'periodsJson', 'digest', 'requestId', 'actorUserId'],
  MIGRATIONS: ['taskId', 'companyId', 'status', 'appliedAt', 'revision', 'requestId', 'deploymentCommit', 'resultHash']
});
const COMPANY_PROFILE_FIELDS = Object.freeze([
  'companyName', 'companyNameEn', 'businessNumber', 'representativeName',
  'establishedDate', 'openingDate', 'taxationType', 'businessTypes', 'businessItems',
  'jointBusinessEnabled', 'unitTaxationEnabled', 'taxInvoiceEmail',
  'certificateIssueReason', 'certificateIssuedDate', 'taxOfficeName', 'closingCycle',
  'companyPhone', 'homePhone', 'email', 'mobile', 'fax', 'homepage',
  'postalCode1', 'address1', 'postalCode2', 'address2', 'addressEn'
]);
const COMPANY_PROFILE_ARRAY_FIELDS = Object.freeze(['businessTypes', 'businessItems']);
const COMPANY_PROFILE_BOOLEAN_FIELDS = Object.freeze(['jointBusinessEnabled', 'unitTaxationEnabled']);
const COMPANY_PROFILE_DATE_FIELDS = Object.freeze(['establishedDate', 'openingDate', 'certificateIssuedDate']);
const COMPANY_PUBLIC_FOOTER_FIELDS = Object.freeze([
  'companyName', 'businessNumber', 'representativeName', 'companyPhone', 'businessAddress', 'homepage', 'revision'
]);
const COMPANY_PROFILE_MIGRATION_VALUES = Object.freeze({
  companyName: '원앱',
  businessNumber: '3801401523',
  representativeName: '이무철',
  openingDate: '2021-04-29',
  taxationType: '일반과세자',
  businessTypes: ['도매 및 소매업'],
  businessItems: ['전자상거래 소매업', '상품 중개업'],
  jointBusinessEnabled: null,
  unitTaxationEnabled: false,
  taxInvoiceEmail: null,
  certificateIssueReason: '정정',
  certificateIssuedDate: '2021-07-28',
  taxOfficeName: '송파세무서',
  postalCode1: '05699',
  address1: '서울특별시 송파구 양재대로 932, 9층 19호 (가락동, 가락동 농수산물도매시장)'
});

function companyProfileText_(value) {
  return String(value == null ? '' : value).normalize('NFKC').trim();
}

function companyProfileClone_(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function companyProfileCanonical_(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(companyProfileCanonical_).join(',') + ']';
  if (typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + companyProfileCanonical_(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function companyProfileHash_(value) {
  return sha256Hex(typeof value === 'string' ? value : companyProfileCanonical_(value));
}

function companyProfileCompanyId_(payload) {
  const requested = companyProfileText_(payload && payload.scope && payload.scope.companyId || COMPANY_PROFILE_DEFAULT_COMPANY_ID).toUpperCase();
  if (requested !== COMPANY_PROFILE_DEFAULT_COMPANY_ID) throw new Error('COMPANY_SCOPE_DENIED');
  return requested;
}

function companyProfileActor_(payload, actorType) {
  const request = payload && payload.nexusRequest || {};
  return {
    requestId: companyProfileText_(request.requestId || payload && payload.requestId),
    userId: companyProfileText_(request.subjectUserId),
    loginId: companyProfileText_(request.subjectLoginId),
    actorType: actorType || 'USER'
  };
}

function companyProfileRequireAdmin_(auth, payload) {
  const request = payload && payload.nexusRequest || {};
  const operationId = companyProfileText_(request.operationId);
  const allowedOperations = [
    'company.profile_read', 'company.profile_write', 'company.accounting_period_read',
    'company.accounting_period_write', 'company.certificate_extract',
    'company.backup_create', 'company.migrate_oneapp'
  ];
  const boundRoles = auth && Array.isArray(auth.roleIds) ? auth.roleIds : [];
  const gatewayRoles = payload && Array.isArray(payload.roleIds) ? payload.roleIds : [];
  const requiredBoundaryRole = ['company.profile_read', 'company.accounting_period_read', 'company.certificate_extract'].includes(operationId)
    ? 'FOUNDATION_READ'
    : 'FOUNDATION_WRITE';
  if (request.contractVersion !== 'NEXUS_AUTH_V2' || request.appId !== 'company' || !allowedOperations.includes(operationId)
      || !boundRoles.includes(requiredBoundaryRole) || !gatewayRoles.includes('COMPANY_ADMIN')) throw new Error('COMPANY_ADMIN_REQUIRED');
  return auth;
}

function companyProfileSheet_(ss, kind) {
  const name = COMPANY_PROFILE_SHEETS[kind];
  const headers = COMPANY_PROFILE_HEADERS[kind];
  if (!name || !headers) throw new Error('COMPANY_SHEET_KIND_INVALID');
  const sheet = getOrCreateSheet(ss, name);
  if (sheet.getLastRow() < 1) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  const actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0].map(companyProfileText_);
  if (companyProfileCanonical_(actual) !== companyProfileCanonical_(headers)) throw new Error('COMPANY_SHEET_SCHEMA_INVALID');
  return sheet;
}

function companyProfileRows_(sheet, headers) {
  if (sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues().map((values, index) => {
    const row = { _row: index + 2 };
    headers.forEach((header, column) => { row[header] = values[column]; });
    return row;
  });
}

function companyProfileAppend_(sheet, headers, value) {
  sheet.appendRow(headers.map(header => value[header] === undefined ? '' : value[header]));
  return sheet.getLastRow();
}

function companyProfileWriteRow_(sheet, rowNumber, headers, value) {
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([headers.map(header => value[header] === undefined ? '' : value[header])]);
}

function companyProfileSheetSnapshot_(sheet) {
  const lastRow = Math.max(1, sheet.getLastRow());
  const lastColumn = Math.max(1, sheet.getLastColumn());
  return { rows: lastRow, columns: lastColumn, values: sheet.getRange(1, 1, lastRow, lastColumn).getValues() };
}

function companyProfileRestoreSheet_(sheet, snapshot) {
  sheet.clearContents();
  sheet.getRange(1, 1, snapshot.rows, snapshot.columns).setValues(snapshot.values);
}

function companyProfileAtomic_(ss, kinds, callback) {
  const sheets = {};
  const snapshots = {};
  kinds.forEach(kind => {
    sheets[kind] = companyProfileSheet_(ss, kind);
    snapshots[kind] = companyProfileSheetSnapshot_(sheets[kind]);
  });
  try {
    return callback(sheets);
  } catch (error) {
    let rollbackFailure = null;
    kinds.slice().reverse().forEach(kind => {
      try { companyProfileRestoreSheet_(sheets[kind], snapshots[kind]); }
      catch (rollbackError) { rollbackFailure = rollbackFailure || rollbackError; }
    });
    if (rollbackFailure) throw new Error('COMPANY_ATOMIC_ROLLBACK_FAILED');
    throw error;
  }
}

function companyProfileEmpty_(companyId) {
  const profile = { companyId, schemaVersion: COMPANY_PROFILE_SCHEMA_VERSION };
  COMPANY_PROFILE_FIELDS.forEach(field => { profile[field] = null; });
  profile.revision = 0;
  profile.updatedAt = null;
  profile.updatedBy = null;
  return profile;
}

function companyProfileNormalizeDate_(value, field) {
  if (value === null || value === '') return null;
  const text = companyProfileText_(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error('COMPANY_DATE_INVALID');
  const date = new Date(text + 'T00:00:00.000Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error('COMPANY_DATE_INVALID');
  if (field === 'openingDate' && date.getTime() > Date.now()) throw new Error('COMPANY_OPENING_DATE_INVALID');
  return text;
}

function companyProfileValidBusinessNumber_(value) {
  const digits = companyProfileText_(value).replace(/[^0-9]/g, '');
  if (!/^\d{10}$/.test(digits)) return false;
  const numbers = digits.split('').map(Number);
  const weights = [1, 3, 7, 1, 3, 7, 1, 3];
  let sum = weights.reduce((result, weight, index) => result + numbers[index] * weight, 0);
  const lastProduct = numbers[8] * 5;
  sum += Math.floor(lastProduct / 10) + lastProduct % 10;
  return (10 - sum % 10) % 10 === numbers[9];
}

function companyProfileNormalizeField_(field, value) {
  if (COMPANY_PROFILE_ARRAY_FIELDS.includes(field)) {
    if (value === null || value === '') return null;
    if (!Array.isArray(value)) throw new Error('COMPANY_ARRAY_INVALID');
    const seen = {};
    const normalized = value.map(companyProfileText_).filter(item => item && !seen[item] && (seen[item] = true));
    return normalized.length ? normalized : null;
  }
  if (COMPANY_PROFILE_BOOLEAN_FIELDS.includes(field)) {
    if (value === null || value === '') return null;
    if (value !== true && value !== false) throw new Error('COMPANY_BOOLEAN_INVALID');
    return value;
  }
  if (COMPANY_PROFILE_DATE_FIELDS.includes(field)) return companyProfileNormalizeDate_(value, field);
  if (value === null || value === '') return null;
  const text = companyProfileText_(value);
  if (text.length > (field.startsWith('address') ? 500 : 200)) throw new Error('COMPANY_FIELD_TOO_LONG');
  if (field === 'businessNumber') {
    const digits = text.replace(/[^0-9]/g, '');
    if (!companyProfileValidBusinessNumber_(digits)) throw new Error('COMPANY_BUSINESS_NUMBER_INVALID');
    return digits;
  }
  if (/^postalCode/.test(field) && !/^\d{5}$/.test(text)) throw new Error('COMPANY_POSTAL_CODE_INVALID');
  if (['email', 'taxInvoiceEmail'].includes(field) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) throw new Error('COMPANY_EMAIL_INVALID');
  if (field === 'homepage' && !/^https:\/\/[a-z0-9.-]+(?:[:/]|$)/i.test(text)) throw new Error('COMPANY_HOMEPAGE_INVALID');
  if (['companyPhone', 'homePhone', 'mobile', 'fax'].includes(field)) {
    if (!/^[0-9+()\-\s]+$/.test(text) || text.replace(/\D/g, '').length < 7 || text.replace(/\D/g, '').length > 15) throw new Error('COMPANY_PHONE_INVALID');
  }
  if (field === 'closingCycle') {
    const month = Number(text);
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('COMPANY_CLOSING_CYCLE_INVALID');
    return String(month);
  }
  return text;
}

function companyProfileNormalizeChanges_(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('COMPANY_CHANGES_REQUIRED');
  const keys = Object.keys(changes);
  if (!keys.length) throw new Error('COMPANY_CHANGES_REQUIRED');
  const normalized = {};
  keys.forEach(field => {
    if (!COMPANY_PROFILE_FIELDS.includes(field)) throw new Error('COMPANY_FIELD_DENIED');
    normalized[field] = companyProfileNormalizeField_(field, changes[field]);
  });
  return normalized;
}

function companyProfileReadStored_(sheet, companyId) {
  const matchingRows = companyProfileRows_(sheet, COMPANY_PROFILE_HEADERS.PROFILE).filter(item => companyProfileText_(item.companyId).toUpperCase() === companyId);
  if (matchingRows.length > 1) throw new Error('COMPANY_PROFILE_DUPLICATE');
  const row = matchingRows[0];
  if (!row) return { row: null, profile: null };
  let profile;
  try { profile = JSON.parse(String(row.payloadJson || '')); }
  catch (_) { throw new Error('COMPANY_PROFILE_CORRUPT'); }
  if (!profile || profile.companyId !== companyId || Number(profile.revision) !== Number(row.revision)
      || companyProfileHash_(profile) !== companyProfileText_(row.payloadHash)) throw new Error('COMPANY_PROFILE_CORRUPT');
  return { row, profile };
}

function companyProfilePeriodView_(row) {
  return {
    periodId: companyProfileText_(row.periodId),
    revision: Number(row.revision || 0),
    periodNumber: Number(row.periodNumber),
    startDate: companyProfileText_(row.startDate),
    endDate: companyProfileText_(row.endDate),
    enabled: row.enabled === true || String(row.enabled).toUpperCase() === 'TRUE',
    updatedAt: companyProfileText_(row.updatedAt) || null,
    updatedBy: companyProfileText_(row.updatedBy) || null
  };
}

function companyProfileReadPeriods_(sheet, companyId) {
  return companyProfileRows_(sheet, COMPANY_PROFILE_HEADERS.PERIODS)
    .filter(row => companyProfileText_(row.companyId).toUpperCase() === companyId)
    .map(companyProfilePeriodView_)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.periodNumber - b.periodNumber);
}

function companyProfileAudit_(sheet, companyId, entityType, entityId, operation, before, after, revision, actor, now) {
  companyProfileAppend_(sheet, COMPANY_PROFILE_HEADERS.AUDIT, {
    auditId: 'CA-' + Utilities.getUuid(), companyId, entityType, entityId, operation,
    beforeJson: before == null ? '' : companyProfileCanonical_(before),
    afterJson: after == null ? '' : companyProfileCanonical_(after),
    revision, requestId: actor.requestId, actorUserId: actor.userId, actorLoginId: actor.loginId,
    actorType: actor.actorType, at: now
  });
}

function companyProfilePersist_(sheets, companyId, current, changes, actor, operation, now) {
  const next = Object.assign(companyProfileEmpty_(companyId), current || {}, changes || {});
  next.schemaVersion = COMPANY_PROFILE_SCHEMA_VERSION;
  next.companyId = companyId;
  next.revision = Number(current && current.revision || 0) + 1;
  next.updatedAt = now;
  next.updatedBy = actor.actorType === 'DEPLOYMENT_SERVICE' ? COMPANY_PROFILE_SERVICE_ACTOR : (actor.loginId || actor.userId || 'NEXUS_USER');
  if (!next.companyName || !next.businessNumber || !next.representativeName) throw new Error('COMPANY_REQUIRED_FIELDS_MISSING');
  if (!companyProfileValidBusinessNumber_(next.businessNumber)) throw new Error('COMPANY_BUSINESS_NUMBER_INVALID');
  const payloadJson = companyProfileCanonical_(next);
  const stored = companyProfileReadStored_(sheets.PROFILE, companyId);
  const rowValue = { companyId, schemaVersion: COMPANY_PROFILE_SCHEMA_VERSION, revision: next.revision, updatedAt: now, updatedBy: next.updatedBy, payloadJson, payloadHash: companyProfileHash_(next) };
  if (stored.row) companyProfileWriteRow_(sheets.PROFILE, stored.row._row, COMPANY_PROFILE_HEADERS.PROFILE, rowValue);
  else companyProfileAppend_(sheets.PROFILE, COMPANY_PROFILE_HEADERS.PROFILE, rowValue);
  companyProfileAudit_(sheets.AUDIT, companyId, 'PROFILE', companyId, operation, current, next, next.revision, actor, now);
  const verified = companyProfileReadStored_(sheets.PROFILE, companyId).profile;
  if (companyProfileCanonical_(verified) !== companyProfileCanonical_(next)) throw new Error('COMPANY_PROFILE_VERIFY_FAILED');
  return verified;
}

function companyProfilePublicSnapshot_(profile) {
  if (!profile) return null;
  const snapshot = {
    companyName: companyProfileText_(profile.companyName),
    businessNumber: companyProfileText_(profile.businessNumber),
    representativeName: companyProfileText_(profile.representativeName),
    companyPhone: companyProfileText_(profile.companyPhone),
    businessAddress: [profile.address1, profile.address2].map(companyProfileText_).filter(Boolean).join(' '),
    homepage: companyProfileText_(profile.homepage),
    revision: Number(profile.revision || 0)
  };
  if (Object.keys(snapshot).length !== COMPANY_PUBLIC_FOOTER_FIELDS.length
      || Object.keys(snapshot).some(key => !COMPANY_PUBLIC_FOOTER_FIELDS.includes(key))) {
    throw new Error('COMPANY_PUBLIC_PROJECTION_DENIED');
  }
  return snapshot;
}

function companyProfilePublicGet(ss, payload) {
  const companyId = companyProfileCompanyId_(payload);
  const profile = companyProfileReadStored_(companyProfileSheet_(ss, 'PROFILE'), companyId).profile;
  return {
    schemaVersion: COMPANY_PUBLIC_FOOTER_SCHEMA_VERSION,
    status: profile ? 'READY' : 'EMPTY',
    snapshot: companyProfilePublicSnapshot_(profile)
  };
}

function companyProfileGet(ss, payload, auth) {
  companyProfileRequireAdmin_(auth, payload);
  const companyId = companyProfileCompanyId_(payload);
  const profileSheet = companyProfileSheet_(ss, 'PROFILE');
  const periodSheet = companyProfileSheet_(ss, 'PERIODS');
  const stored = companyProfileReadStored_(profileSheet, companyId);
  const profile = stored.profile;
  return {
    schemaVersion: COMPANY_PROFILE_SCHEMA_VERSION,
    status: profile ? 'READY' : 'EMPTY',
    profile,
    accountingPeriods: companyProfileReadPeriods_(periodSheet, companyId)
  };
}

function companyProfileWrite(ss, payload, auth) {
  companyProfileRequireAdmin_(auth, payload);
  const companyId = companyProfileCompanyId_(payload);
  const changes = companyProfileNormalizeChanges_(payload && payload.changes);
  const expectedRevision = Number(payload && payload.expectedRevision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error('COMPANY_REVISION_REQUIRED');
  return companyProfileAtomic_(ss, ['PROFILE', 'AUDIT'], sheets => {
    const current = companyProfileReadStored_(sheets.PROFILE, companyId).profile;
    if (Number(current && current.revision || 0) !== expectedRevision) {
      const error = new Error('COMPANY_REVISION_CONFLICT');
      error.latestRevision = Number(current && current.revision || 0);
      throw error;
    }
    if (changes.businessNumber) {
      const duplicate = companyProfileRows_(sheets.PROFILE, COMPANY_PROFILE_HEADERS.PROFILE).some(row => {
        if (companyProfileText_(row.companyId).toUpperCase() === companyId) return false;
        try { return JSON.parse(String(row.payloadJson || '{}')).businessNumber === changes.businessNumber; }
        catch (_) { throw new Error('COMPANY_PROFILE_CORRUPT'); }
      });
      if (duplicate) throw new Error('COMPANY_BUSINESS_NUMBER_DUPLICATE');
    }
    const actor = companyProfileActor_(payload, 'USER');
    const profile = companyProfilePersist_(sheets, companyId, current, changes, actor, 'PROFILE_WRITE', new Date().toISOString());
    return { profile, publicSnapshot: companyProfilePublicSnapshot_(profile) };
  });
}

function companyProfileAccountingRead(ss, payload, auth) {
  companyProfileRequireAdmin_(auth, payload);
  const companyId = companyProfileCompanyId_(payload);
  return { accountingPeriods: companyProfileReadPeriods_(companyProfileSheet_(ss, 'PERIODS'), companyId) };
}

function companyProfileNormalizePeriod_(period) {
  if (!period || typeof period !== 'object' || Array.isArray(period)) throw new Error('COMPANY_PERIOD_REQUIRED');
  const allowed = ['periodId', 'periodNumber', 'startDate', 'endDate', 'enabled', 'revision'];
  Object.keys(period).forEach(key => { if (!allowed.includes(key)) throw new Error('COMPANY_PERIOD_FIELD_DENIED'); });
  const periodNumber = Number(period.periodNumber);
  const revision = Number(period.revision || 0);
  const startDate = companyProfileNormalizeDate_(period.startDate, 'periodStart');
  const endDate = companyProfileNormalizeDate_(period.endDate, 'periodEnd');
  if (!Number.isInteger(periodNumber) || periodNumber < 1 || periodNumber > 999) throw new Error('COMPANY_PERIOD_NUMBER_INVALID');
  if (!Number.isInteger(revision) || revision < 0) throw new Error('COMPANY_PERIOD_REVISION_INVALID');
  if (!startDate || !endDate || startDate > endDate) throw new Error('COMPANY_PERIOD_RANGE_INVALID');
  if (period.enabled !== true && period.enabled !== false) throw new Error('COMPANY_PERIOD_ENABLED_INVALID');
  const periodId = companyProfileText_(period.periodId);
  if (periodId && !/^CP-[A-Z0-9-]{1,80}$/.test(periodId)) throw new Error('COMPANY_PERIOD_ID_INVALID');
  return { periodId, revision, periodNumber, startDate, endDate, enabled: period.enabled };
}

function companyProfileAccountingWrite(ss, payload, auth) {
  companyProfileRequireAdmin_(auth, payload);
  const companyId = companyProfileCompanyId_(payload);
  const expectedRevision = Number(payload && payload.expectedRevision);
  const operation = companyProfileText_(payload && payload.operation).toUpperCase();
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new Error('COMPANY_REVISION_REQUIRED');
  if (!['UPSERT', 'DELETE'].includes(operation)) throw new Error('COMPANY_PERIOD_OPERATION_INVALID');
  return companyProfileAtomic_(ss, ['PROFILE', 'PERIODS', 'AUDIT'], sheets => {
    const stored = companyProfileReadStored_(sheets.PROFILE, companyId);
    const currentProfile = stored.profile;
    if (!currentProfile) throw new Error('COMPANY_PROFILE_REQUIRED');
    if (Number(currentProfile.revision) !== expectedRevision) {
      const error = new Error('COMPANY_REVISION_CONFLICT'); error.latestRevision = Number(currentProfile.revision); throw error;
    }
    const periods = companyProfileReadPeriods_(sheets.PERIODS, companyId);
    const requested = companyProfileNormalizePeriod_(payload && payload.period);
    const existing = requested.periodId ? periods.find(period => period.periodId === requested.periodId) : null;
    if (operation === 'DELETE' && !existing) throw new Error('COMPANY_PERIOD_NOT_FOUND');
    if (operation === 'DELETE' && existing.revision !== requested.revision) throw new Error('COMPANY_PERIOD_REVISION_CONFLICT');
    if (operation === 'UPSERT' && existing && existing.revision !== requested.revision) throw new Error('COMPANY_PERIOD_REVISION_CONFLICT');
    if (operation === 'UPSERT') {
      const overlap = periods.some(period => period.periodId !== requested.periodId && requested.startDate <= period.endDate && requested.endDate >= period.startDate);
      if (overlap) throw new Error('COMPANY_PERIOD_OVERLAP');
      if (periods.some(period => period.periodId !== requested.periodId && period.periodNumber === requested.periodNumber)) throw new Error('COMPANY_PERIOD_NUMBER_DUPLICATE');
    }
    const actor = companyProfileActor_(payload, 'USER');
    const now = new Date().toISOString();
    let after = null;
    if (operation === 'DELETE') {
      const row = companyProfileRows_(sheets.PERIODS, COMPANY_PROFILE_HEADERS.PERIODS).find(item => item.periodId === requested.periodId && companyProfileText_(item.companyId).toUpperCase() === companyId);
      sheets.PERIODS.deleteRow(row._row);
    } else {
      after = Object.assign({}, requested, {
        periodId: requested.periodId || 'CP-' + Utilities.getUuid().toUpperCase(),
        revision: Number(existing && existing.revision || 0) + 1,
        updatedAt: now, updatedBy: actor.loginId || actor.userId || 'NEXUS_USER'
      });
      const value = Object.assign({ companyId }, after);
      const row = existing && companyProfileRows_(sheets.PERIODS, COMPANY_PROFILE_HEADERS.PERIODS).find(item => item.periodId === existing.periodId);
      if (row) companyProfileWriteRow_(sheets.PERIODS, row._row, COMPANY_PROFILE_HEADERS.PERIODS, value);
      else companyProfileAppend_(sheets.PERIODS, COMPANY_PROFILE_HEADERS.PERIODS, value);
    }
    const nextProfile = companyProfilePersist_(sheets, companyId, currentProfile, {}, actor, 'ACCOUNTING_PERIOD_' + operation, now);
    companyProfileAudit_(sheets.AUDIT, companyId, 'ACCOUNTING_PERIOD', requested.periodId || after.periodId, operation, existing, after, nextProfile.revision, actor, now);
    return { profileRevision: nextProfile.revision, accountingPeriods: companyProfileReadPeriods_(sheets.PERIODS, companyId) };
  });
}

function companyProfileCertificateExtract(payload, auth) {
  companyProfileRequireAdmin_(auth, payload);
  const body = payload && payload.extraction;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('COMPANY_CERTIFICATE_EXTRACTION_REQUIRED');
  const canonical = companyProfileCanonical_(body).toLowerCase();
  if (/(image|file|blob|base64|rawtext|ocrtext|birth|생년월일|주민등록)/.test(canonical)) throw new Error('COMPANY_CERTIFICATE_SENSITIVE_DATA_DENIED');
  const allowedFields = ['companyName', 'businessNumber', 'representativeName', 'openingDate', 'taxationType', 'businessTypes', 'businessItems', 'jointBusinessEnabled', 'unitTaxationEnabled', 'taxInvoiceEmail', 'certificateIssueReason', 'certificateIssuedDate', 'taxOfficeName', 'postalCode1', 'address1'];
  const extracted = body.extractedFields && typeof body.extractedFields === 'object' ? body.extractedFields : {};
  const normalized = {};
  Object.keys(extracted).forEach(field => {
    if (!allowedFields.includes(field)) throw new Error('COMPANY_CERTIFICATE_FIELD_DENIED');
    normalized[field] = companyProfileNormalizeField_(field, extracted[field]);
  });
  const confidence = {};
  Object.entries(body.fieldConfidence || {}).forEach(([field, value]) => {
    if (!allowedFields.includes(field)) throw new Error('COMPANY_CERTIFICATE_FIELD_DENIED');
    const score = Number(value);
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('COMPANY_CERTIFICATE_CONFIDENCE_INVALID');
    confidence[field] = score;
  });
  const signals = Array.isArray(body.documentSignals) ? body.documentSignals.map(companyProfileText_).filter(Boolean).slice(0, 20) : [];
  if (!signals.includes('BUSINESS_REGISTRATION_CERTIFICATE')) throw new Error('COMPANY_CERTIFICATE_DOCUMENT_INVALID');
  return { extractedFields: normalized, fieldConfidence: confidence, sourceLabels: body.sourceLabels || {}, documentSignals: signals };
}

function companyProfileBackupCreate(ss, payload, auth) {
  companyProfileRequireAdmin_(auth, payload);
  const companyId = companyProfileCompanyId_(payload);
  return companyProfileAtomic_(ss, ['PROFILE', 'PERIODS', 'BACKUPS'], sheets => {
    const profile = companyProfileReadStored_(sheets.PROFILE, companyId).profile;
    const periods = companyProfileReadPeriods_(sheets.PERIODS, companyId);
    const actor = companyProfileActor_(payload, 'DEPLOYMENT_SERVICE');
    const backup = {
      backupId: 'CB-' + Utilities.getUuid(), companyId, createdAt: new Date().toISOString(),
      revision: Number(profile && profile.revision || 0), profileJson: companyProfileCanonical_(profile),
      periodsJson: companyProfileCanonical_(periods), requestId: actor.requestId, actorUserId: actor.userId
    };
    backup.digest = companyProfileHash_({ profile, periods });
    companyProfileAppend_(sheets.BACKUPS, COMPANY_PROFILE_HEADERS.BACKUPS, backup);
    return { backupId: backup.backupId, companyId, createdAt: backup.createdAt, revision: backup.revision, digest: backup.digest };
  });
}

function companyProfileMigrateOneapp(ss, payload, auth) {
  companyProfileRequireAdmin_(auth, payload);
  const companyId = companyProfileCompanyId_(payload);
  if (companyProfileText_(payload && payload.taskId) !== COMPANY_PROFILE_TASK_ID) throw new Error('COMPANY_MIGRATION_TASK_DENIED');
  const deploymentCommit = companyProfileText_(payload && payload.deploymentCommit).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(deploymentCommit)) throw new Error('COMPANY_MIGRATION_COMMIT_INVALID');
  return companyProfileAtomic_(ss, ['PROFILE', 'AUDIT', 'MIGRATIONS'], sheets => {
    const ledger = companyProfileRows_(sheets.MIGRATIONS, COMPANY_PROFILE_HEADERS.MIGRATIONS).find(row => row.taskId === COMPANY_PROFILE_TASK_ID && companyProfileText_(row.companyId).toUpperCase() === companyId && row.status === 'APPLIED');
    if (ledger) return { status: 'ALREADY_APPLIED', taskId: COMPANY_PROFILE_TASK_ID, companyId, revision: Number(ledger.revision), appliedAt: ledger.appliedAt, resultHash: ledger.resultHash };
    const rows = companyProfileRows_(sheets.PROFILE, COMPANY_PROFILE_HEADERS.PROFILE);
    const matches = rows.filter(row => {
      try { return JSON.parse(String(row.payloadJson || '{}')).businessNumber === COMPANY_PROFILE_MIGRATION_VALUES.businessNumber; }
      catch (_) { throw new Error('COMPANY_PROFILE_CORRUPT'); }
    });
    if (matches.length > 1) throw new Error('COMPANY_MIGRATION_DUPLICATE_BLOCKED');
    if (matches.length === 1 && companyProfileText_(matches[0].companyId).toUpperCase() !== companyId) throw new Error('COMPANY_MIGRATION_SCOPE_CONFLICT');
    const current = companyProfileReadStored_(sheets.PROFILE, companyId).profile;
    const actor = companyProfileActor_(payload, 'DEPLOYMENT_SERVICE');
    const now = new Date().toISOString();
    const next = companyProfilePersist_(sheets, companyId, current, companyProfileClone_(COMPANY_PROFILE_MIGRATION_VALUES), actor, 'MIGRATION_APPLY', now);
    const resultHash = companyProfileHash_(next);
    companyProfileAppend_(sheets.MIGRATIONS, COMPANY_PROFILE_HEADERS.MIGRATIONS, {
      taskId: COMPANY_PROFILE_TASK_ID, companyId, status: 'APPLIED', appliedAt: now,
      revision: next.revision, requestId: actor.requestId, deploymentCommit, resultHash
    });
    return { status: 'APPLIED', taskId: COMPANY_PROFILE_TASK_ID, companyId, revision: next.revision, appliedAt: now, resultHash, profile: next };
  });
}
