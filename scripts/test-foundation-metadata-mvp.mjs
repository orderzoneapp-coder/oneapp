#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const fixture = JSON.parse(read('scripts/fixtures/foundation-field-mapping-mvp-v11.json'));
let passed = 0;

async function test(name, run) {
  await run();
  passed += 1;
  process.stdout.write(`PASS foundation ${name}\n`);
}

function serverContext() {
  let uuid = 0;
  const context = {
    console, Date, JSON, Set, Map, Object, Array, String, Number, Boolean, Math, RegExp, Error,
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (_algorithm, value) => Array.from(crypto.createHash('sha256').update(value).digest()).map(byte => byte > 127 ? byte - 256 : byte),
      getUuid: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`
    },
    splitTextBySize: (value, size) => Array.from({ length: Math.ceil(value.length / size) || 1 }, (_, index) => value.slice(index * size, (index + 1) * size)),
    getOrCreateSheet: (spreadsheet, name) => spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name)
  };
  vm.createContext(context);
  vm.runInContext(read('foundation-metadata.gs'), context, { filename: 'foundation-metadata.gs' });
  return context;
}

function actor() {
  return { credentialId: 'FOUNDATION_WRITE', nexusRequest: { subjectUserId: 'USR-1', subjectLoginId: 'admin@example.test' } };
}

function payload(revision, changes, requestId = 'REQ-10000000-0000-4000-8000-000000000001') {
  return { schemaVersion: 'FOUNDATION_METADATA_V1', expectedRevision: revision, requestId, changes };
}

class FakeSheet {
  constructor(name) { this.name = name; this.rows = []; this.failWrites = false; }
  getLastRow() { return this.rows.length; }
  getRange(row, column, rowCount, columnCount) {
    return {
      getValues: () => Array.from({ length: rowCount }, (_, rowIndex) => Array.from({ length: columnCount }, (_, columnIndex) => this.rows[row - 1 + rowIndex]?.[column - 1 + columnIndex] ?? '')),
      setValues: values => {
        if (this.failWrites) throw new Error('INJECTED_SHEET_WRITE_FAILURE');
        values.forEach((sourceRow, rowIndex) => {
          const targetIndex = row - 1 + rowIndex;
          this.rows[targetIndex] ||= [];
          sourceRow.forEach((value, columnIndex) => { this.rows[targetIndex][column - 1 + columnIndex] = value; });
        });
      }
    };
  }
  appendRow(row) { this.rows.push(row.slice()); }
}

class FakeSpreadsheet {
  constructor() { this.sheets = new Map(); }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) { const sheet = new FakeSheet(name); this.sheets.set(name, sheet); return sheet; }
}

const server = serverContext();
const seed = JSON.parse(JSON.stringify(server.foundationMetadataCreateSeed('ONEAPP', '2026-08-27T00:00:00.000Z')));
const productFields = seed.fields.filter(field => field.entityType === 'PRODUCT');
const customerFields = seed.fields.filter(field => field.entityType === 'CUSTOMER');

await test('field seed and compatibility contract', () => {
  assert.equal(seed.schemaVersion, 'FOUNDATION_METADATA_V1');
  assert.equal(productFields.length, 22);
  assert.equal(customerFields.length, 49);
  assert.equal(customerFields.filter(field => !field.systemField).length, 20);
  const productCode = productFields.find(field => field.fieldId === 'product.code');
  assert.equal(productCode.storageKey, '코드');
  assert.deepEqual(Array.from(productCode.writeMirrorKeys), ['품목코드']);
  assert.equal(productCode.requirements.batchIdentifier, true);
  const customerCode = customerFields.find(field => field.fieldId === 'customer.code');
  assert.equal(customerCode.storageKey, 'customerCode');
  assert.deepEqual(Array.from(customerCode.writeMirrorKeys), ['erpCustomerCode']);
  assert.equal(customerFields.find(field => field.fieldId === 'customer.price_group.name').storageKey, 'priceGroup');
  assert.equal(customerFields.some(field => field.storageKey === 'priceGroupName'), false);
  assert.equal(productFields.find(field => field.fieldId === 'product.closing_time').dataType, 'TIME');
  const prior = JSON.parse(JSON.stringify(seed));
  prior.fields.find(field => field.fieldId === 'product.brand').displayName = '관리자 브랜드';
  prior.fields = prior.fields.filter(field => field.fieldId !== 'product.expense');
  const merged = server.foundationMetadataMergeMissingSystemFields(prior, '2026-08-27T00:30:00.000Z');
  assert.equal(merged.changed, true);
  assert.deepEqual(Array.from(merged.addedFieldIds), ['product.expense']);
  assert.equal(merged.snapshot.fields.find(field => field.fieldId === 'product.brand').displayName, '관리자 브랜드', 'seed rerun must not overwrite administrator state');
  assert.equal(server.foundationMetadataMergeMissingSystemFields(merged.snapshot, '2026-08-27T00:40:00.000Z').changed, false);
});

await test('server CAS, immutable fields, atomicity, audit and idempotency', () => {
  const original = JSON.stringify(seed);
  assert.throws(() => server.foundationMetadataApplyChanges(seed, payload(1, [
    { changeId: 'F1', op: 'PATCH_FIELD', entityType: 'PRODUCT', fieldId: 'product.brand', patch: { displayName: '브랜드명' } },
    { changeId: 'F2', op: 'PATCH_FIELD', entityType: 'PRODUCT', fieldId: 'product.code', patch: { enabled: false } }
  ]), actor(), '2026-08-27T01:00:00.000Z'), /REQUIRED_FIELD_DISABLE_DENIED/);
  assert.equal(JSON.stringify(seed), original, 'a failed multi-change request must mutate nothing');
  let conflict;
  try {
    server.foundationMetadataApplyChanges(seed, payload(0, [
      { changeId: 'F3', op: 'PATCH_FIELD', entityType: 'PRODUCT', fieldId: 'product.brand', patch: { displayName: '브랜드명' } }
    ]), actor(), '2026-08-27T01:00:00.000Z');
  } catch (error) { conflict = error; }
  assert.match(conflict.message, /METADATA_VERSION_CONFLICT/);
  assert.equal(conflict.latestRevision, 1);
  assert.throws(() => server.foundationMetadataApplyChanges(seed, payload(1, [
    { changeId: 'F4', op: 'PATCH_FIELD', entityType: 'PRODUCT', fieldId: 'product.brand', patch: { storageKey: 'brand' } }
  ]), actor(), '2026-08-27T01:00:00.000Z'), /FIELD_ID_IMMUTABLE/);
  const request = payload(1, [{ changeId: 'F5', op: 'PATCH_FIELD', entityType: 'PRODUCT', fieldId: 'product.brand', patch: { displayName: '브랜드명', sortOrder: 115 } }]);
  const applied = server.foundationMetadataApplyChanges(seed, request, actor(), '2026-08-27T01:00:00.000Z');
  assert.equal(applied.snapshot.metadataRevision, 2);
  assert.equal(applied.snapshot.audit.length, 1);
  assert.equal(applied.snapshot.audit[0].before.displayName, '브랜드');
  assert.equal(applied.snapshot.audit[0].after.displayName, '브랜드명');
  assert.equal(applied.snapshot.audit[0].subjectUserId, 'USR-1');
  const replay = server.foundationMetadataApplyChanges(applied.snapshot, request, actor(), '2026-08-27T01:10:00.000Z');
  assert.equal(replay.changed, false);
  assert.equal(replay.response.replayed, true);
  assert.equal(replay.snapshot.metadataRevision, 2);
  assert.throws(() => server.foundationMetadataApplyChanges(applied.snapshot, { ...request, changes: [{ ...request.changes[0], patch: { displayName: '다른 값' } }] }, actor()), /METADATA_REQUEST_REPLAY_MISMATCH/);
});

await test('mapping set uniqueness, normalized mapping uniqueness and migration once', () => {
  const setChanges = [
    { changeId: 'S1', op: 'UPSERT_MAPPING_SET', record: { entityType: 'PRODUCT', name: 'ERP A', sourceSystem: 'ERP', enabled: true, isDefault: true } },
    { changeId: 'S2', op: 'UPSERT_MAPPING_SET', record: { entityType: 'PRODUCT', name: 'ERP B', sourceSystem: 'ERP', enabled: true, isDefault: true } }
  ];
  assert.throws(() => server.foundationMetadataApplyChanges(seed, payload(1, setChanges, 'REQ-20000000-0000-4000-8000-000000000001'), actor()), /MAPPING_SET_DEFAULT_CONFLICT/);
  const oneSet = server.foundationMetadataApplyChanges(seed, payload(1, [setChanges[0]], 'REQ-20000000-0000-4000-8000-000000000002'), actor()).snapshot;
  const setId = oneSet.mappingSets[0].mappingSetId;
  assert.throws(() => server.foundationMetadataApplyChanges(oneSet, payload(2, [
    { changeId: 'M1', op: 'UPSERT_MAPPING', record: { mappingSetId: setId, entityType: 'PRODUCT', originalHeader: 'ERP 코드', action: 'MAP', targetFieldId: 'product.code', enabled: true } },
    { changeId: 'M2', op: 'UPSERT_MAPPING', record: { mappingSetId: setId, entityType: 'PRODUCT', originalHeader: 'ERP-코드', action: 'IGNORE', enabled: true } }
  ], 'REQ-20000000-0000-4000-8000-000000000003'), actor()), /MAPPING_HEADER_DUPLICATE/);
  const migrated = server.foundationMetadataApplyChanges(seed, payload(1, [{
    changeId: 'L1', op: 'MIGRATE_CUSTOMER_LEGACY', entityType: 'CUSTOMER',
    record: { groups: [{ sourceSystem: 'ERP', mappings: [{ originalHeader: '옛 거래처 코드', targetFieldId: 'customer.code' }] }], fingerprint: 'abc', sourceCount: 1, successCount: 1, unmigratedCount: 0 }
  }], 'REQ-20000000-0000-4000-8000-000000000004'), actor()).snapshot;
  assert.equal(migrated.migrationState.customerLegacy.status, 'COMPLETED');
  assert.throws(() => server.foundationMetadataApplyChanges(migrated, payload(2, [{ changeId: 'L2', op: 'MIGRATE_CUSTOMER_LEGACY', entityType: 'CUSTOMER', record: {} }], 'REQ-20000000-0000-4000-8000-000000000005'), actor()), /CUSTOMER_LEGACY_MIGRATION_ALREADY_COMPLETED/);
});

await test('snapshot write-before-head, verification, corruption fallback and write stop', () => {
  const spreadsheet = new FakeSpreadsheet();
  const first = JSON.parse(JSON.stringify(seed));
  const firstHead = server.foundationMetadataPersist(spreadsheet, first, null, '2026-08-27T01:00:00.000Z');
  const second = JSON.parse(JSON.stringify(seed));
  second.metadataRevision = 2;
  second.updatedAt = '2026-08-27T02:00:00.000Z';
  const secondHead = server.foundationMetadataPersist(spreadsheet, second, firstHead, second.updatedAt);
  assert.equal(spreadsheet.getSheetByName('FoundationMetadataHead_NEXUS').getLastRow(), 3);
  const loaded = server.foundationMetadataLoadCurrent(spreadsheet, 'ONEAPP');
  assert.equal(loaded.snapshot.metadataRevision, 2);
  const snapshotSheet = spreadsheet.getSheetByName('FoundationMetadataSnapshot_NEXUS');
  const corruptRow = snapshotSheet.rows.find(row => row[1] === secondHead.snapshotId);
  corruptRow[5] += 'CORRUPT';
  const recovered = server.foundationMetadataLoadCurrent(spreadsheet, 'ONEAPP');
  assert.equal(recovered.snapshot.metadataRevision, 1);
  assert.equal(recovered.recoveredFromCorruption, true);
  assert.throws(() => server.foundationMetadataWrite(spreadsheet, payload(1, [{ changeId: 'F6', op: 'PATCH_FIELD', entityType: 'PRODUCT', fieldId: 'product.brand', patch: { displayName: '차단' } }], 'REQ-30000000-0000-4000-8000-000000000001'), { allowedScope: { companyId: 'ONEAPP' }, ...actor() }), /FOUNDATION_METADATA_CORRUPT/);
  const headRowsBeforeFailure = spreadsheet.getSheetByName('FoundationMetadataHead_NEXUS').getLastRow();
  snapshotSheet.failWrites = true;
  assert.throws(() => server.foundationMetadataPersist(spreadsheet, second, firstHead, second.updatedAt), /INJECTED_SHEET_WRITE_FAILURE/);
  assert.equal(spreadsheet.getSheetByName('FoundationMetadataHead_NEXUS').getLastRow(), headRowsBeforeFailure, 'head must not advance before snapshot verification');
});

const require = createRequire(import.meta.url);
const nativeBroadcastChannel = globalThis.BroadcastChannel;
globalThis.BroadcastChannel = undefined;
const client = require(path.join(root, 'nexus/foundation/foundation-metadata.js'));
globalThis.BroadcastChannel = nativeBroadcastChannel;
const clientMetadata = JSON.parse(JSON.stringify(seed));
clientMetadata.mappingSets = [{ mappingSetId: 'MS-PRODUCT', entityType: 'PRODUCT', name: 'ERP 상품', sourceSystem: 'ERP', enabled: true, isDefault: true }];
clientMetadata.mappings = [
  { mappingId: 'HM-CODE', mappingSetId: 'MS-PRODUCT', entityType: 'PRODUCT', originalHeader: 'ERP 상품번호', normalizedHeader: client.normalizeHeader('ERP 상품번호'), action: 'MAP', targetFieldId: 'product.code', enabled: true, sortOrder: 10 },
  { mappingId: 'HM-IGNORE', mappingSetId: 'MS-PRODUCT', entityType: 'PRODUCT', originalHeader: '비고 열', normalizedHeader: client.normalizeHeader('비고 열'), action: 'IGNORE', targetFieldId: null, enabled: true, sortOrder: 20 },
  { mappingId: 'HM-DISABLED', mappingSetId: 'MS-PRODUCT', entityType: 'PRODUCT', originalHeader: '중지 열', normalizedHeader: client.normalizeHeader('중지 열'), action: 'MAP', targetFieldId: 'product.brand', enabled: false, sortOrder: 30 }
];

await test('header normalization, precedence and file blockers', () => {
  assert.equal(client.normalizeHeader('  ＡＢＣ_(테 스트)/01-가. '), 'abc테스트01가');
  const resolved = client.resolveHeaders(clientMetadata, { entityType: 'PRODUCT', sourceSystem: 'ERP', headers: fixture.product.headers });
  assert.equal(resolved.mappingSet.mappingSetId, 'MS-PRODUCT');
  assert.deepEqual(resolved.resolved.map(row => row.status), ['MAPPED', 'MAPPED', 'MAPPED', 'MAPPED', 'MAPPED', 'IGNORED', 'DISABLED', 'UNMAPPED']);
  assert.throws(() => client.resolveHeaders(clientMetadata, { entityType: 'PRODUCT', headers: ['코드', '코 드'] }), /MAPPING_SOURCE_HEADER_DUPLICATE/);
  assert.throws(() => client.resolveHeaders(clientMetadata, { entityType: 'PRODUCT', headers: ['코드', '상품코드'] }), /MAPPING_TARGET_DUPLICATE/);
  assert.throws(() => client.resolveHeaders(clientMetadata, { entityType: 'PRODUCT', headers: ['품목명'] }), /MAPPING_IDENTIFIER_MISSING/);
  const ambiguous = JSON.parse(JSON.stringify(clientMetadata));
  ambiguous.fields.find(field => field.fieldId === 'product.brand').legacyAliases.push('품명');
  assert.throws(() => client.resolveHeaders(ambiguous, { entityType: 'PRODUCT', headers: ['코드', '품명'] }), /MAPPING_ALIAS_AMBIGUOUS/);
  const sourceScoped = JSON.parse(JSON.stringify(clientMetadata));
  sourceScoped.mappingSets.push({ mappingSetId: 'MS-SHOP', entityType: 'PRODUCT', name: 'SHOP 상품', sourceSystem: 'SHOP', enabled: true, isDefault: true });
  assert.equal(client.chooseMappingSet(sourceScoped, 'PRODUCT', 'SHOP').mappingSetId, 'MS-SHOP');
});

await test('value normalization, row failure, field exclusion and product mirror', () => {
  assert.deepEqual(client.normalizeValue(productFields.find(field => field.fieldId === 'product.base_price'), '1,234.50'), { value: 1234.5 });
  assert.deepEqual(client.normalizeValue(productFields.find(field => field.fieldId === 'product.closing_time'), '9:05'), { value: '09:05' });
  assert.deepEqual(client.normalizeValue(productFields.find(field => field.fieldId === 'product.closing_time'), 0.5), { value: '12:00' });
  assert.equal(client.normalizeValue(productFields.find(field => field.fieldId === 'product.tax_type'), '비과세').value, '1');
  const mapped = client.mapWorkbook(clientMetadata, { entityType: 'PRODUCT', sourceSystem: 'ERP', headers: fixture.product.headers, rows: fixture.product.rows, existingByIdentifier: { 'P-EXIST': { 코드: 'P-EXIST' } } });
  assert.equal(mapped.rows[0].코드, 'P-NEW');
  assert.equal(mapped.rows[0].품목코드, 'P-NEW');
  assert.equal(mapped.rows[0].마감시간, '09:05');
  assert.equal(mapped.rows[1].코드, undefined);
  assert.ok(mapped.rows[1].__foundationMappingIssues.some(issue => issue.reasonCode === 'MAPPING_ROW_IDENTIFIER_VALUE_MISSING' && issue.rowFailed));
  assert.ok(mapped.rows[2].__foundationMappingIssues.some(issue => issue.reasonCode === 'MAPPING_VALUE_INVALID' && !issue.rowFailed));
  assert.equal(mapped.rows[2].품목코드, undefined, 'existing product reads must not trigger code mirror migration');
  assert.equal(mapped.summary.rowFailures, 1);
  assert.ok(mapped.summary.fieldExclusions >= 1);
});

await test('arbitrary mapped product header workbook parsing', () => {
  const displayMatrix = [
    ['ERP 상품 업로드'],
    fixture.product.headers,
    fixture.product.headers.map(header => fixture.product.rows[0][header] ?? '')
  ];
  const rawMatrix = JSON.parse(JSON.stringify(displayMatrix));
  const fakeXlsx = {
    read: () => ({ SheetNames: ['상품'], Sheets: { 상품: {} } }),
    utils: { sheet_to_json: (_sheet, options) => options.raw ? rawMatrix : displayMatrix }
  };
  const parsed = client.parseWorkbook(new ArrayBuffer(1), {
    XLSX: fakeXlsx, metadata: clientMetadata, entityType: 'PRODUCT', sourceSystem: 'ERP'
  });
  assert.equal(parsed.headerRowNumber, 2);
  assert.equal(parsed.headers[0], 'ERP 상품번호');
  assert.equal(parsed.rows[0]['ERP 상품번호'], 'P-NEW');
});

await test('customer compatibility adapter mirrors code and keeps priceGroup', () => {
  const metadata = JSON.parse(JSON.stringify(seed));
  metadata.mappingSets = [{ mappingSetId: 'MS-CUSTOMER', entityType: 'CUSTOMER', name: 'ERP 거래처', sourceSystem: 'ERP', enabled: true, isDefault: true }];
  metadata.mappings = [
    { mappingSetId: 'MS-CUSTOMER', entityType: 'CUSTOMER', originalHeader: 'ERP 거래처 코드', normalizedHeader: client.normalizeHeader('ERP 거래처 코드'), action: 'MAP', targetFieldId: 'customer.code', enabled: true },
    { mappingSetId: 'MS-CUSTOMER', entityType: 'CUSTOMER', originalHeader: '단가 그룹', normalizedHeader: client.normalizeHeader('단가 그룹'), action: 'MAP', targetFieldId: 'customer.price_group.name', enabled: true }
  ];
  const prepared = client.prepareCustomerLegacyUpsert(metadata, { entityType: 'CUSTOMER', sourceSystem: 'ERP', headers: fixture.customer.headers, rows: fixture.customer.rows });
  assert.equal(prepared.rows[0].__NEXUS_CUSTOMER_CODE, 'C-001');
  assert.equal(prepared.legacyMappings.find(mapping => mapping.targetFieldKey === 'customerCode').header, '__NEXUS_CUSTOMER_CODE');
  assert.ok(prepared.legacyMappings.some(mapping => mapping.targetFieldKey === 'priceGroup'));
  const directlyMapped = client.mapWorkbook(metadata, { entityType: 'CUSTOMER', sourceSystem: 'ERP', headers: fixture.customer.headers, rows: fixture.customer.rows });
  assert.equal(directlyMapped.rows[0].customerCode, 'C-001');
  assert.equal(directlyMapped.rows[0].erpCustomerCode, 'C-001');
  assert.equal(directlyMapped.rows[0].priceGroup, '도매A');
  assert.equal(Object.hasOwn(directlyMapped.rows[0], 'priceGroupName'), false);
});

function memoryStorage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key: index => Array.from(values.keys())[index] || null,
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key)),
    values
  };
}

await test('company cache isolation, read-only fallback and logout clearing', async () => {
  const localStorage = memoryStorage();
  const sessionStorage = memoryStorage();
  let channelListener = null;
  let mode = 'C1';
  const window = {
    localStorage, sessionStorage, Promise, console, JSON, Set, Map, Object, Array, String, Number, Boolean, Math, RegExp, Error,
    ONEAPP_AUTH: {
      ready: Promise.resolve(), session: { userId: 'USR-1' },
      gateway: async () => {
        if (mode === 'FAIL') throw new Error('NETWORK_DOWN');
        return { ...JSON.parse(JSON.stringify(seed)), companyId: mode, fields: [] };
      }
    },
    BroadcastChannel: class { addEventListener(_type, listener) { channelListener = listener; } }
  };
  window.window = window;
  const context = vm.createContext({ window, globalThis: window, module: undefined });
  vm.runInContext(read('nexus/foundation/foundation-metadata.js'), context, { filename: 'foundation-metadata.js' });
  const api = window.NEXUS_FOUNDATION;
  const c1 = await api.load('PRODUCT');
  assert.equal(c1.companyId, 'C1');
  mode = 'FAIL';
  const cached = await api.load('PRODUCT');
  assert.equal(cached.companyId, 'C1');
  assert.equal(cached.readOnly, true);
  mode = 'C2';
  await api.load('PRODUCT');
  assert.equal(localStorage.getItem(api.CACHE_PREFIX + 'C1'), null, 'successful scope switch must clear the previous company cache');
  mode = 'FAIL';
  const c2 = await api.load('PRODUCT');
  assert.equal(c2.companyId, 'C2');
  assert.equal(c2.readOnly, true);
  localStorage.setItem(api.CACHE_PREFIX + 'STALE', JSON.stringify({ schemaVersion: 'OLD', companyId: 'STALE' }));
  assert.equal(api._test.readCache('STALE'), null);
  assert.equal(localStorage.getItem(api.CACHE_PREFIX + 'STALE'), null, 'schema mismatch must purge stale cache');
  assert.doesNotMatch(JSON.stringify(Array.from(localStorage.values.values())), /credential|sessionToken|upstreamUrl|actorId/);
  channelListener({ data: { type: 'logout' } });
  assert.equal(localStorage.length, 0);
  assert.equal(sessionStorage.length, 0);
});

await test('IndexedDB customer legacy migration preview is explicit and non-destructive', async () => {
  const stores = {
    customerHeaderMappings: [
      { originalHeader: '옛 거래처 코드', targetFieldKey: 'customerCode', sourceSystem: 'ERP', enabled: true },
      { originalHeader: '__NEXUS_CUSTOMER_CODE', targetFieldKey: 'customerCode', sourceSystem: 'ERP', enabled: true },
      { originalHeader: '알 수 없는 열', targetFieldKey: 'missingField', sourceSystem: 'ERP', enabled: true }
    ],
    customerUserFieldDefinitions: [
      { fieldKey: 'userText01', fieldType: 'TEXT', displayName: '지역코드', enabled: true, displayOrder: 1, headerAliases: ['지역 코드'] }
    ]
  };
  let closeCount = 0;
  const database = {
    objectStoreNames: { contains: name => Object.hasOwn(stores, name) },
    transaction: storeName => {
      const transaction = { error: null };
      transaction.objectStore = () => ({ getAll: () => {
        const request = { result: JSON.parse(JSON.stringify(stores[storeName])) };
        queueMicrotask(() => { request.onsuccess?.(); setTimeout(() => transaction.oncomplete?.(), 0); });
        return request;
      } });
      return transaction;
    },
    close: () => { closeCount += 1; }
  };
  const indexedDB = { open: () => {
    const request = { result: database };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } };
  const window = { indexedDB, crypto: crypto.webcrypto, TextEncoder, Promise, console, JSON, Set, Map, Object, Array, String, Number, Boolean, Math, RegExp, Error };
  window.window = window;
  const context = vm.createContext({ window, globalThis: window, module: undefined, TextEncoder, setTimeout, queueMicrotask });
  vm.runInContext(read('nexus/foundation/foundation-metadata.js'), context, { filename: 'foundation-metadata.js' });
  const preview = await window.NEXUS_FOUNDATION.previewCustomerLegacyMigration(JSON.parse(JSON.stringify(seed)));
  assert.equal(preview.sourceCount, 3, 'adapter-created synthetic mappings must not be counted as legacy source');
  assert.equal(preview.successCount, 2);
  assert.equal(preview.unmigrated.length, 1);
  assert.equal(preview.groups[0].sourceSystem, 'ERP');
  assert.equal(preview.groups[0].mappings[0].targetFieldId, 'customer.code');
  assert.equal(preview.fieldChanges[0].fieldId, 'customer.custom.text01');
  assert.equal(preview.migrationChange.op, 'MIGRATE_CUSTOMER_LEGACY');
  assert.equal(stores.customerHeaderMappings.length, 3, 'preview must not delete or rewrite IndexedDB data');
  assert.equal(closeCount, 2);
});

await test('Gateway operation allowlist and recursive reserved-field rejection', () => {
  const context = vm.createContext({ console, Date, JSON, Set, Map, Object, Array, String, Number, Boolean, Math, RegExp, Error, Utilities: { getUuid: () => crypto.randomUUID() } });
  vm.runInContext(read('nexus/server/nexus-auth-gateway.gs'), context, { filename: 'nexus-auth-gateway.gs' });
  const registry = context.nexusAuthGatewayRegistry_();
  assert.deepEqual(Array.from(registry['foundation.metadata_read'].allowedApps), ['master', 'item-manager', 'customer-manager']);
  assert.deepEqual(Array.from(registry['foundation.metadata_write'].requiredUserPermissions), ['foundation.write']);
  assert.deepEqual(Array.from(registry['foundation.metadata_write'].allowedFields), ['schemaVersion', 'expectedRevision', 'changes']);
  assert.equal(registry['foundation.metadata_write'].upstreamAction, 'nexus_gateway_foundation_metadata_write');
  assert.equal(context.nexusAuthPublicError_(new Error('METADATA_VERSION_CONFLICT')), 'METADATA_VERSION_CONFLICT');
  assert.equal(context.nexusAuthPublicError_(new Error('MAPPING_HEADER_DUPLICATE')), 'MAPPING_HEADER_DUPLICATE');
  assert.throws(() => context.nexusAuthRequireOperationAccess_({ user: { role: 'VIEWER', permissionsJson: '[]' } }, registry['foundation.metadata_write']), /NEXUS_AUTH_VIEWER_READ_ONLY/);
  const valid = { schemaVersion: 'FOUNDATION_METADATA_V1', expectedRevision: 1, changes: [{ changeId: 'M1', op: 'UPSERT_MAPPING', record: { action: 'MAP', targetFieldId: 'product.code' } }] };
  assert.doesNotThrow(() => context.nexusAuthGatewayValidatePayload_(registry['foundation.metadata_write'], valid));
  for (const forbidden of ['requestId', 'actorId', 'credentialId', 'token', 'scope', 'companyId', 'recordRevision', 'updatedAt', 'upstreamUrl']) {
    const injected = JSON.parse(JSON.stringify(valid));
    injected.changes[0].record[forbidden] = 'ATTACK';
    assert.throws(() => context.nexusAuthGatewayValidatePayload_(registry['foundation.metadata_write'], injected), /NEXUS_GATEWAY_SCHEMA_DENIED/, forbidden);
  }
});

await test('routes, UI modes, server actions and allowed compatibility connections', () => {
  const master = `${read('Master.html')}\n${read('nexus/master/master-app.jsx')}`;
  const customerHtml = read('partner_db.html');
  const itemHtml = read('Item_manager.html');
  const code = read('code.gs');
  const customerService = read('orderq/customer-master.js');
  const customerAdapter = read('orderq/customer-code-upsert-ui.js');
  const metadataClient = read('nexus/foundation/foundation-metadata.js');
  const metadataUi = read('nexus/foundation/foundation-metadata-ui.js');
  assert.match(master, /\[\['products', '상품'\], \['customers', '거래처'\]\]/);
  assert.match(master, /\[\['list', '조회'\], \['edit', '등록·수정'\], \['mapping', '매핑·관리'\]\]/);
  assert.match(master, /url\.searchParams\.set\('view', normalized\.view\)/);
  assert.match(master, /url\.searchParams\.set\('mode', normalized\.mode\)/);
  assert.match(master, /rawMode === 'batch' \? 'edit'/);
  assert.match(master, /window\.history\.replaceState/);
  assert.match(master, /window\.addEventListener\('popstate'/);
  assert.match(master, /FoundationMetadataWorkspace/);
  assert.match(master, /NEXUS_FOUNDATION\.parseWorkbook/, 'product upload header detection must honor saved arbitrary mappings before the legacy analyzer');
  assert.match(customerHtml, /rawCustomerMasterMode === 'batch' \? 'edit'/);
  assert.match(itemHtml, /foundation-metadata\.js/);
  assert.match(code, /nexus_gateway_foundation_metadata_get/);
  assert.match(code, /nexus_gateway_foundation_metadata_write/);
  assert.match(code, /response\.latestRevision = Number\(error\.latestRevision\)/);
  assert.match(customerService, /'priceGroupCode', 'priceGroup'/);
  assert.doesNotMatch(customerService, /priceGroupName/);
  assert.match(customerAdapter, /prepareCustomerLegacyUpsert/);
  assert.match(metadataClient, /previewCustomerLegacyMigration/);
  assert.match(metadataUi, /data-field-aliases/, 'custom field aliases must be editable');
  assert.match(metadataUi, /data-edit-set/, 'mapping sets must support update as well as create and delete');
  assert.match(metadataUi, /data-edit-mapping/, 'header mappings must support update as well as create and delete');
  assert.match(master, /원본 헤더 \/ 원본값 \/ 이유/, 'product approval must expose mapping evidence');
  assert.match(customerAdapter, /필드 제외·행 실패 근거/, 'customer approval must expose mapping evidence');
});

console.log(`Foundation field/mapping MVP acceptance tests passed: ${passed}`);
