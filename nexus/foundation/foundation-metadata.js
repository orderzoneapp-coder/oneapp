(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NEXUS_FOUNDATION = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const SCHEMA_VERSION = 'FOUNDATION_METADATA_V1';
  const CACHE_PREFIX = 'oneapp:foundation-metadata:v1:';
  const SESSION_SCOPE_KEY = 'oneapp:foundation-metadata:session-scope:v1';
  const SELECTION_PREFIX = 'oneapp:foundation-mapping-set:v1:';
  const VALID_ENTITY = new Set(['PRODUCT', 'CUSTOMER']);

  const text = value => String(value ?? '').trim();
  const clone = value => JSON.parse(JSON.stringify(value));
  const normalizeHeader = value => String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('ko-KR')
    .replace(/[\s_.\-\/()]+/gu, '');

  function errorWithCode(code, details) {
    const error = new Error(code);
    error.code = code;
    if (details !== undefined) error.details = details;
    return error;
  }

  function entity(value) {
    const normalized = text(value).toUpperCase();
    if (!VALID_ENTITY.has(normalized)) throw errorWithCode('FOUNDATION_METADATA_ENTITY_INVALID');
    return normalized;
  }

  function storage() {
    return root && root.localStorage;
  }

  function sessionStorageRef() {
    return root && root.sessionStorage;
  }

  function sessionIdentity() {
    const session = root && root.ONEAPP_AUTH && root.ONEAPP_AUTH.session || {};
    return text(session.userId || session.subjectUserId || session.loginId);
  }

  function clearAllCaches() {
    const target = storage();
    if (target) {
      const keys = [];
      for (let index = 0; index < target.length; index += 1) {
        const key = target.key(index);
        if (key && (key.startsWith(CACHE_PREFIX) || key.startsWith(SELECTION_PREFIX))) keys.push(key);
      }
      keys.forEach(key => target.removeItem(key));
    }
    sessionStorageRef()?.removeItem(SESSION_SCOPE_KEY);
  }

  function currentScope() {
    try {
      const parsed = JSON.parse(sessionStorageRef()?.getItem(SESSION_SCOPE_KEY) || 'null');
      if (!parsed || !text(parsed.companyId) || text(parsed.identity) !== sessionIdentity()) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function rememberScope(companyId) {
    const previous = currentScope();
    if (previous && previous.companyId !== companyId) storage()?.removeItem(CACHE_PREFIX + previous.companyId);
    sessionStorageRef()?.setItem(SESSION_SCOPE_KEY, JSON.stringify({ companyId, identity: sessionIdentity() }));
  }

  function readCache(companyId) {
    try {
      const parsed = JSON.parse(storage()?.getItem(CACHE_PREFIX + companyId) || 'null');
      if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || parsed.companyId !== companyId) {
        storage()?.removeItem(CACHE_PREFIX + companyId);
        return null;
      }
      return Object.assign(parsed, { readOnly: true, source: 'READ_ONLY_CACHE', state: 'READ_ONLY_CACHE' });
    } catch (_) {
      return null;
    }
  }

  function writeCache(metadata) {
    if (!metadata || metadata.schemaVersion !== SCHEMA_VERSION || !text(metadata.companyId)) return;
    const safe = clone(metadata);
    delete safe.readOnly;
    delete safe.source;
    delete safe.state;
    storage()?.setItem(CACHE_PREFIX + safe.companyId, JSON.stringify(safe));
    rememberScope(safe.companyId);
  }

  async function gateway(operationId, payload) {
    const auth = root && root.ONEAPP_AUTH;
    if (!auth || typeof auth.gateway !== 'function') throw errorWithCode('FOUNDATION_METADATA_GATEWAY_UNAVAILABLE');
    await auth.ready;
    return auth.gateway(operationId, payload);
  }

  async function load(entityType, options) {
    const normalizedEntity = text(entityType) ? entity(entityType) : null;
    try {
      const data = await gateway('foundation.metadata_read', {
        schemaVersion: SCHEMA_VERSION,
        entityType: normalizedEntity,
        includeDisabled: !options || options.includeDisabled !== false
      });
      if (!data || data.schemaVersion !== SCHEMA_VERSION || !text(data.companyId)) throw errorWithCode('FOUNDATION_METADATA_RESPONSE_INVALID');
      const metadata = Object.assign(clone(data), {
        readOnly: data.recoveredFromCorruption === true,
        source: data.recoveredFromCorruption === true ? 'RECOVERED_SERVER_SNAPSHOT' : 'SERVER',
        state: data.recoveredFromCorruption === true ? 'READ_ONLY_CACHE' : 'READY'
      });
      if (!metadata.readOnly) writeCache(metadata);
      return metadata;
    } catch (error) {
      const scope = currentScope();
      const cached = scope ? readCache(scope.companyId) : null;
      if (cached) return Object.assign(cached, { loadError: text(error && error.message || error) });
      const wrapped = errorWithCode('FOUNDATION_METADATA_LOAD_FAILED', { cause: text(error && error.message || error) });
      throw wrapped;
    }
  }

  async function save(expectedRevision, changes) {
    if (!Array.isArray(changes) || !changes.length) throw errorWithCode('FOUNDATION_METADATA_CHANGES_REQUIRED');
    const response = await gateway('foundation.metadata_write', {
      schemaVersion: SCHEMA_VERSION,
      expectedRevision: Number(expectedRevision),
      changes: clone(changes)
    });
    return response;
  }

  function selectionKey(companyId, entityType, sourceSystem) {
    return `${SELECTION_PREFIX}${companyId}:${entity(entityType)}:${text(sourceSystem || 'GENERIC').toUpperCase()}`;
  }

  function rememberMappingSet(metadata, entityType, mappingSetId) {
    if (!metadata || !text(metadata.companyId)) return;
    const selected = (metadata.mappingSets || []).find(set => set.mappingSetId === text(mappingSetId));
    const key = selectionKey(metadata.companyId, entityType, selected && selected.sourceSystem);
    if (text(mappingSetId)) storage()?.setItem(key, text(mappingSetId));
    else storage()?.removeItem(key);
  }

  function chooseMappingSet(metadata, entityType, sourceSystem, explicitId) {
    const type = entity(entityType);
    const source = text(sourceSystem || 'GENERIC').toUpperCase();
    const active = (metadata.mappingSets || []).filter(set => set.entityType === type && set.enabled !== false);
    const explicit = active.find(set => set.mappingSetId === text(explicitId));
    const storedId = text(storage()?.getItem(selectionKey(metadata.companyId, type, source)));
    const selected = explicit || active.find(set => set.sourceSystem === source && set.mappingSetId === storedId)
      || active.find(set => set.sourceSystem === source && set.isDefault)
      || null;
    if (selected) rememberMappingSet(metadata, type, selected.mappingSetId);
    return selected;
  }

  function aliasCandidates(fields, systemField) {
    const map = new Map();
    fields.filter(field => field.systemField === systemField && field.enabled !== false).forEach(field => {
      [field.displayName, ...(field.legacyAliases || [])].filter(Boolean).forEach(alias => {
        const normalized = normalizeHeader(alias);
        if (!normalized) return;
        const candidates = map.get(normalized) || [];
        if (!candidates.some(candidate => candidate.fieldId === field.fieldId)) candidates.push(field);
        map.set(normalized, candidates);
      });
    });
    return map;
  }

  function resolveHeaders(metadata, options) {
    if (!metadata || metadata.readOnly) throw errorWithCode('FOUNDATION_METADATA_READ_ONLY');
    const type = entity(options && options.entityType);
    const headers = Array.isArray(options && options.headers) ? options.headers : [];
    const selectedSet = chooseMappingSet(metadata, type, options && options.sourceSystem, options && options.mappingSetId);
    const explicit = new Map();
    if (selectedSet) {
      (metadata.mappings || []).filter(mapping => mapping.mappingSetId === selectedSet.mappingSetId)
        .forEach(mapping => explicit.set(mapping.normalizedHeader, mapping));
    }
    const fields = (metadata.fields || []).filter(field => field.entityType === type);
    const byId = new Map(fields.map(field => [field.fieldId, field]));
    const systemAliases = aliasCandidates(fields, true);
    const customAliases = aliasCandidates(fields, false);
    const normalizedSeen = new Map();
    headers.forEach((header, index) => {
      const normalized = normalizeHeader(header);
      if (!normalized) return;
      const previous = normalizedSeen.get(normalized);
      if (previous !== undefined) throw errorWithCode('MAPPING_SOURCE_HEADER_DUPLICATE', { indexes: [previous, index], normalizedHeader: normalized });
      normalizedSeen.set(normalized, index);
    });
    const resolved = headers.map((header, index) => {
      const originalHeader = String(header ?? '');
      const normalizedHeader = normalizeHeader(originalHeader);
      const base = { index, originalHeader, normalizedHeader, status: 'UNMAPPED', field: null, reasonCode: '' };
      if (!normalizedHeader) return Object.assign(base, { status: 'EMPTY', reasonCode: 'MAPPING_HEADER_INVALID' });
      const saved = explicit.get(normalizedHeader);
      if (saved) {
        if (saved.action === 'IGNORE') return Object.assign(base, { status: 'IGNORED', reasonCode: 'MAPPING_EXPLICIT_IGNORE', mapping: saved });
        if (saved.enabled === false) return Object.assign(base, { status: 'DISABLED', reasonCode: 'MAPPING_FIELD_DISABLED', mapping: saved });
        const field = byId.get(saved.targetFieldId);
        if (!field || field.enabled === false) return Object.assign(base, { status: 'DISABLED', reasonCode: 'MAPPING_FIELD_DISABLED', mapping: saved });
        return Object.assign(base, { status: 'MAPPED', field, source: 'EXPLICIT', mapping: saved });
      }
      const system = systemAliases.get(normalizedHeader) || [];
      if (system.length > 1) throw errorWithCode('MAPPING_ALIAS_AMBIGUOUS', { index, normalizedHeader, fieldIds: system.map(field => field.fieldId) });
      if (system.length === 1) return Object.assign(base, { status: 'MAPPED', field: system[0], source: 'SYSTEM_ALIAS' });
      const custom = customAliases.get(normalizedHeader) || [];
      if (custom.length > 1) throw errorWithCode('MAPPING_ALIAS_AMBIGUOUS', { index, normalizedHeader, fieldIds: custom.map(field => field.fieldId) });
      if (custom.length === 1) return Object.assign(base, { status: 'MAPPED', field: custom[0], source: 'CUSTOM_ALIAS' });
      return base;
    });
    const targetSeen = new Map();
    resolved.filter(row => row.status === 'MAPPED').forEach(row => {
      const previous = targetSeen.get(row.field.fieldId);
      if (previous) throw errorWithCode('MAPPING_TARGET_DUPLICATE', { fieldId: row.field.fieldId, indexes: [previous.index, row.index] });
      targetSeen.set(row.field.fieldId, row);
    });
    const identifier = fields.find(field => field.requirements && field.requirements.batchIdentifier);
    if (!identifier || !resolved.some(row => row.status === 'MAPPED' && row.field.fieldId === identifier.fieldId)) {
      throw errorWithCode('MAPPING_IDENTIFIER_MISSING', { fieldId: identifier && identifier.fieldId || '' });
    }
    return { entityType: type, mappingSet: selectedSet, resolved, identifierField: identifier };
  }

  function normalizedNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const source = text(value).replace(/,/g, '');
    if (!source) return null;
    const parsed = Number(source);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseWorkbook(arrayBuffer, options) {
    const xlsx = options && options.XLSX || root && root.XLSX;
    const metadata = options && options.metadata;
    const entityType = entity(options && options.entityType);
    if (!xlsx) throw errorWithCode('FOUNDATION_METADATA_XLSX_UNAVAILABLE');
    if (!metadata || metadata.readOnly) throw errorWithCode('FOUNDATION_METADATA_READ_ONLY');
    const workbook = xlsx.read(new Uint8Array(arrayBuffer), { type: 'array', cellDates: false });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) throw errorWithCode('MAPPING_WORKSHEET_MISSING');
    const rawRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, blankrows: false });
    const displayRows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: false });
    const candidates = [];
    for (let index = 0; index < Math.min(30, displayRows.length); index += 1) {
      const headers = (displayRows[index] || []).map(value => String(value ?? '').trim());
      const nonEmpty = headers.filter(Boolean).length;
      if (!nonEmpty) continue;
      try {
        const resolution = resolveHeaders(metadata, {
          entityType, sourceSystem: options && options.sourceSystem,
          mappingSetId: options && options.mappingSetId, headers
        });
        candidates.push({ index, headers, nonEmpty, resolution, score: resolution.resolved.filter(column => column.status === 'MAPPED').length });
      } catch (error) {
        candidates.push({ index, headers, nonEmpty, error, score: -1 });
      }
    }
    const selected = candidates.filter(candidate => candidate.resolution)
      .sort((left, right) => right.score - left.score || left.index - right.index)[0];
    if (!selected) {
      const blocked = candidates.filter(candidate => candidate.error)
        .sort((left, right) => right.nonEmpty - left.nonEmpty || left.index - right.index)[0];
      throw blocked && blocked.error || errorWithCode('MAPPING_IDENTIFIER_MISSING');
    }
    const headers = selected.headers;
    const rows = [];
    for (let rowIndex = selected.index + 1; rowIndex < rawRows.length; rowIndex += 1) {
      const rawRow = rawRows[rowIndex] || [];
      const displayRow = displayRows[rowIndex] || [];
      if (!headers.some((header, columnIndex) => header && text(displayRow[columnIndex] ?? rawRow[columnIndex]))) continue;
      const row = { __rowNumber: rowIndex + 1, __display: {} };
      headers.forEach((header, columnIndex) => {
        if (!header) return;
        row[header] = rawRow[columnIndex] === undefined ? '' : rawRow[columnIndex];
        row.__display[header] = displayRow[columnIndex];
      });
      rows.push(row);
      if (rows.length > 100000) throw errorWithCode('MAPPING_ROW_LIMIT_EXCEEDED');
    }
    if (!rows.length) throw errorWithCode('MAPPING_ROWS_EMPTY');
    return { headers: headers.filter(Boolean), rows, headerRowNumber: selected.index + 1, sheetName: workbook.SheetNames[0] };
  }

  function normalizeEnum(field, value) {
    const source = text(value).normalize('NFKC').toLocaleLowerCase('ko-KR');
    if (field.fieldId === 'product.tax_type') {
      if (['0', '과세', 'tax', 'taxable'].includes(source)) return '0';
      if (['1', '면세', '비과세', 'taxfree', 'tax-free'].includes(source)) return '1';
    }
    if (field.fieldId === 'product.status') {
      if (['1', '사용', '판매', '정상', 'active', 'true'].includes(source)) return '1';
      if (['0', '중지', '사용중지', '판매중지', '미사용', 'stopped', 'false'].includes(source)) return '0';
    }
    if (field.fieldId === 'customer.status') {
      const upper = text(value).toUpperCase();
      if (['ACTIVE', 'INACTIVE'].includes(upper)) return upper;
      return undefined;
    }
    const exact = (field.enumValues || []).find(item => String(item).toLocaleLowerCase('ko-KR') === source);
    return exact === undefined ? undefined : exact;
  }

  function normalizeValue(field, value) {
    if (value === '' || value == null) return { empty: true, value: '' };
    if (field.dataType === 'TEXT') return { value: String(value).trim() };
    if (field.dataType === 'NUMBER') {
      const parsed = normalizedNumber(value);
      if (parsed == null || parsed < 0 && ['product.safety_stock', 'product.base_price', 'product.outsourcing_cost', 'product.labor_cost', 'product.expense', 'customer.credit_limit_amount'].includes(field.fieldId)) return { invalid: true };
      return { value: parsed };
    }
    if (field.dataType === 'INTEGER') {
      const parsed = normalizedNumber(value);
      const invalidRange = field.fieldId === 'customer.payment_day' ? parsed < 1 || parsed > 31 : parsed < 0;
      if (parsed == null || !Number.isInteger(parsed) || invalidRange) return { invalid: true };
      return { value: parsed };
    }
    if (field.dataType === 'TIME') {
      if (typeof value === 'number' && value >= 0 && value < 1) {
        const totalMinutes = Math.round(value * 24 * 60) % (24 * 60);
        return { value: `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}` };
      }
      const match = text(value).match(/^(\d{1,2}):(\d{2})$/);
      if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return { invalid: true };
      return { value: `${String(Number(match[1])).padStart(2, '0')}:${match[2]}` };
    }
    if (field.dataType === 'ENUM') {
      const normalized = normalizeEnum(field, value);
      return normalized === undefined ? { invalid: true } : { value: normalized };
    }
    return { invalid: true };
  }

  function mapWorkbook(metadata, options) {
    const resolution = resolveHeaders(metadata, options);
    const rows = Array.isArray(options && options.rows) ? options.rows : [];
    const existing = options && options.existingByIdentifier || {};
    const issues = [];
    const mappedRows = rows.map((rawRow, rowIndex) => {
      const result = { __display: {}, __foundationOriginalRow: clone(rawRow), __foundationMappingIssues: [] };
      let identifierValue = '';
      resolution.resolved.forEach(column => {
        if (column.status !== 'MAPPED') {
          if (column.status !== 'EMPTY') result.__foundationMappingIssues.push({
            rowIndex, columnIndex: column.index, originalHeader: column.originalHeader,
            rawValue: rawRow && Object.prototype.hasOwnProperty.call(rawRow, column.originalHeader) ? rawRow[column.originalHeader] : '',
            reasonCode: column.reasonCode || 'MAPPING_UNMAPPED'
          });
          return;
        }
        const rawValue = rawRow && Object.prototype.hasOwnProperty.call(rawRow, column.originalHeader) ? rawRow[column.originalHeader] : '';
        const normalized = normalizeValue(column.field, rawValue);
        if (normalized.invalid) {
          const required = column.field.requirements && (column.field.requirements.createRequired || column.field.requirements.batchIdentifier);
          result.__foundationMappingIssues.push({ rowIndex, columnIndex: column.index, originalHeader: column.originalHeader, rawValue, fieldId: column.field.fieldId, reasonCode: 'MAPPING_VALUE_INVALID', rowFailed: required });
          return;
        }
        if (normalized.empty) {
          if (column.field.requirements && column.field.requirements.createRequired) {
            result.__foundationMappingIssues.push({ rowIndex, columnIndex: column.index, originalHeader: column.originalHeader, fieldId: column.field.fieldId, reasonCode: 'MAPPING_VALUE_INVALID', rowFailed: true });
          }
          return;
        }
        result[column.field.storageKey] = normalized.value;
        result.__display[column.field.storageKey] = rawRow && rawRow.__display && rawRow.__display[column.originalHeader] !== undefined
          ? rawRow.__display[column.originalHeader] : rawValue;
        if (column.field.fieldId === resolution.identifierField.fieldId) identifierValue = text(normalized.value);
      });
      if (!identifierValue) result.__foundationMappingIssues.push({ rowIndex, fieldId: resolution.identifierField.fieldId, reasonCode: 'MAPPING_ROW_IDENTIFIER_VALUE_MISSING', rowFailed: true });
      if (result.__foundationMappingIssues.some(issue => issue.rowFailed)) {
        delete result[resolution.identifierField.storageKey];
        delete result.__display[resolution.identifierField.storageKey];
        (resolution.identifierField.writeMirrorKeys || []).forEach(key => { delete result[key]; delete result.__display[key]; });
        identifierValue = '';
      }
      if (resolution.entityType === 'PRODUCT' && identifierValue && !Object.prototype.hasOwnProperty.call(existing, identifierValue)) {
        const identifier = resolution.identifierField;
        (identifier.writeMirrorKeys || []).forEach(key => { result[key] = result[identifier.storageKey]; result.__display[key] = result.__display[identifier.storageKey]; });
      }
      if (resolution.entityType === 'CUSTOMER' && identifierValue) {
        (resolution.identifierField.writeMirrorKeys || []).forEach(key => { result[key] = result[resolution.identifierField.storageKey]; });
      }
      issues.push(...result.__foundationMappingIssues);
      return result;
    });
    return {
      entityType: resolution.entityType,
      mappingSet: resolution.mappingSet,
      columns: resolution.resolved,
      headers: Array.from(new Set(resolution.resolved.filter(row => row.status === 'MAPPED').flatMap(row => [row.field.storageKey, ...(row.field.writeMirrorKeys || [])]))),
      rows: mappedRows,
      issues,
      summary: {
        mapped: resolution.resolved.filter(row => row.status === 'MAPPED').length,
        ignored: resolution.resolved.filter(row => row.status === 'IGNORED').length,
        disabled: resolution.resolved.filter(row => row.status === 'DISABLED').length,
        unmapped: resolution.resolved.filter(row => row.status === 'UNMAPPED').length,
        rowFailures: new Set(issues.filter(issue => issue.rowFailed).map(issue => issue.rowIndex)).size,
        fieldExclusions: issues.filter(issue => !issue.rowFailed).length
      }
    };
  }

  function customerSyntheticHeader(fieldId) {
    return `__NEXUS_${text(fieldId).replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`;
  }

  function prepareCustomerLegacyUpsert(metadata, options) {
    const mapped = mapWorkbook(metadata, Object.assign({}, options, { entityType: 'CUSTOMER' }));
    const activeColumns = mapped.columns.filter(column => column.status === 'MAPPED');
    const headerByStorage = new Map(activeColumns.map(column => [column.field.storageKey, customerSyntheticHeader(column.field.fieldId)]));
    const headers = activeColumns.map(column => headerByStorage.get(column.field.storageKey));
    const rows = mapped.rows.map(row => {
      const converted = {};
      activeColumns.forEach(column => {
        const key = column.field.storageKey;
        if (Object.prototype.hasOwnProperty.call(row, key)) converted[headerByStorage.get(key)] = row[key];
      });
      converted.__foundationOriginalRow = row.__foundationOriginalRow;
      converted.__foundationMappingIssues = row.__foundationMappingIssues;
      return converted;
    });
    return Object.assign({}, mapped, {
      headers,
      rows,
      legacyMappings: activeColumns.map(column => ({
        header: headerByStorage.get(column.field.storageKey),
        targetFieldKey: column.field.storageKey,
        targetType: column.field.dataType === 'NUMBER' || column.field.dataType === 'INTEGER' ? 'NUMBER' : 'TEXT'
      }))
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || errorWithCode('CUSTOMER_LEGACY_MIGRATION_READ_FAILED'));
    });
  }

  async function legacyRows(storeName) {
    const indexedDb = root && root.indexedDB;
    if (!indexedDb) return [];
    const database = await requestToPromise(indexedDb.open('oneapp-orderq-vnext'));
    try {
      if (!database.objectStoreNames.contains(storeName)) return [];
      const transaction = database.transaction(storeName, 'readonly');
      const rows = await requestToPromise(transaction.objectStore(storeName).getAll());
      await transactionDone(transaction);
      return rows;
    } finally {
      database.close();
    }
  }

  async function sha256(value) {
    const source = new TextEncoder().encode(JSON.stringify(value));
    const digest = await root.crypto.subtle.digest('SHA-256', source);
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function previewCustomerLegacyMigration(metadata) {
    if (metadata && metadata.migrationState && metadata.migrationState.customerLegacy && metadata.migrationState.customerLegacy.status === 'COMPLETED') {
      throw errorWithCode('CUSTOMER_LEGACY_MIGRATION_ALREADY_COMPLETED');
    }
    const [mappings, definitions] = await Promise.all([
      legacyRows('customerHeaderMappings'),
      legacyRows('customerUserFieldDefinitions')
    ]);
    const fields = (metadata.fields || []).filter(field => field.entityType === 'CUSTOMER');
    const byStorage = new Map();
    fields.forEach(field => {
      byStorage.set(field.storageKey, field.fieldId);
      (field.writeMirrorKeys || []).forEach(key => byStorage.set(key, field.fieldId));
    });
    byStorage.set('groupName', 'customer.group1.name');
    const unmigrated = [];
    const groups = new Map();
    const eligibleMappings = mappings.filter(row => !/^__NEXUS_/i.test(text(row.originalHeader)));
    eligibleMappings.forEach(row => {
      const targetFieldId = byStorage.get(text(row.targetFieldKey));
      if (!targetFieldId || !normalizeHeader(row.originalHeader)) {
        unmigrated.push({ type: 'MAPPING', source: clone(row), reasonCode: 'MAPPING_MIGRATION_RECORD_INVALID' });
        return;
      }
      const sourceSystem = text(row.sourceSystem || 'GENERIC').toUpperCase();
      const group = groups.get(sourceSystem) || { sourceSystem, name: `CUSTOMER-${sourceSystem}-LEGACY`, mappings: [] };
      group.mappings.push({ originalHeader: row.originalHeader, targetFieldId, enabled: row.enabled !== false });
      groups.set(sourceSystem, group);
    });
    const fieldChanges = [];
    definitions.forEach(row => {
      const fieldId = byStorage.get(text(row.fieldKey));
      if (!fieldId) {
        unmigrated.push({ type: 'FIELD', source: clone(row), reasonCode: 'FIELD_ID_NOT_FOUND' });
        return;
      }
      fieldChanges.push({
        changeId: `LEGACY-FIELD-${text(row.fieldKey)}`,
        op: 'PATCH_FIELD', entityType: 'CUSTOMER', fieldId,
        patch: {
          displayName: text(row.displayName), enabled: row.enabled === true && Boolean(text(row.displayName)),
          sortOrder: Number(row.displayOrder || 0) + (/userNumber/.test(row.fieldKey) ? 400 : 300),
          legacyAliases: Array.isArray(row.headerAliases) ? row.headerAliases.map(text).filter(Boolean) : []
        }
      });
    });
    const sourceCount = eligibleMappings.length + definitions.length;
    const successCount = groups.size ? Array.from(groups.values()).reduce((sum, group) => sum + group.mappings.length, 0) + fieldChanges.length : fieldChanges.length;
    const fingerprint = await sha256({ mappings, definitions });
    const migrationChange = {
      changeId: 'LEGACY-MIGRATION-COMPLETE', op: 'MIGRATE_CUSTOMER_LEGACY', entityType: 'CUSTOMER',
      record: { groups: Array.from(groups.values()), fingerprint, sourceCount, successCount, unmigratedCount: unmigrated.length }
    };
    return { mappings, definitions, groups: Array.from(groups.values()), fieldChanges, migrationChange, unmigrated, fingerprint, sourceCount, successCount };
  }

  function fieldById(metadata, fieldId) {
    return (metadata.fields || []).find(field => field.fieldId === fieldId) || null;
  }

  try {
    if (typeof root.BroadcastChannel === 'function') {
      const channel = new root.BroadcastChannel('oneapp.nexus.auth.v2');
      channel.addEventListener('message', event => { if (event.data && event.data.type === 'logout') clearAllCaches(); });
    }
  } catch (_) {}

  return Object.freeze({
    SCHEMA_VERSION, CACHE_PREFIX, normalizeHeader, load, save, clearAllCaches,
    rememberMappingSet, chooseMappingSet, resolveHeaders, parseWorkbook, normalizeValue, mapWorkbook,
    prepareCustomerLegacyUpsert, previewCustomerLegacyMigration, fieldById,
    _test: Object.freeze({ readCache, writeCache, currentScope, normalizeEnum, customerSyntheticHeader })
  });
});
