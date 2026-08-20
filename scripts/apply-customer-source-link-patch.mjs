import { readFile, writeFile } from 'node:fs/promises';

async function patch(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`patch did not change ${path}`);
  await writeFile(path, after);
}

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0) throw new Error(`missing patch anchor: ${label}`);
  if (source.indexOf(search, first + search.length) >= 0) throw new Error(`ambiguous patch anchor: ${label}`);
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

await patch('orderq-cloud.gs', source => {
  let next = replaceOnce(source, "const ORDERQ_SHEET_SCHEMA_VERSION = '4';", "const ORDERQ_SHEET_SCHEMA_VERSION = '5';", 'cloud schema');
  next = replaceOnce(next,
    "  CUSTOMER_ALIAS: 'CUSTOMER_ALIAS_MAPPING',\n  PRODUCT_MAPPING: 'PRODUCT_MAPPING',",
    "  CUSTOMER_ALIAS: 'CUSTOMER_ALIAS_MAPPING',\n  CUSTOMER_SOURCE_LINK: 'CUSTOMER_SOURCE_LINK',\n  CUSTOMER_SOURCE_LINK_EVENT: 'CUSTOMER_SOURCE_LINK_EVENT',\n  PRODUCT_MAPPING: 'PRODUCT_MAPPING',",
    'cloud sheets');
  next = replaceOnce(next,
    "  CUSTOMER_ALIAS: ['mappingId', 'customerId', 'normalizedText', 'sourceType', 'updatedAt', 'payloadJson'],\n  PRODUCT_MAPPING:",
    "  CUSTOMER_ALIAS: ['mappingId', 'customerId', 'normalizedText', 'sourceType', 'updatedAt', 'payloadJson'],\n  CUSTOMER_SOURCE_LINK: ['linkId', 'customerId', 'sourceSystem', 'sourceCustomerCode', 'sourceLinkKey', 'linkStatus', 'updatedAt', 'payloadJson'],\n  CUSTOMER_SOURCE_LINK_EVENT: ['eventId', 'linkId', 'eventType', 'beforeCustomerId', 'afterCustomerId', 'occurredAt', 'payloadJson'],\n  PRODUCT_MAPPING:",
    'cloud headers');
  next = replaceOnce(next,
    "    CUSTOMER_ALIAS: { key: 'CUSTOMER_ALIAS', id: 'mappingId', row: p => [p.mappingId, p.customerId || '', p.normalizedText || '', p.sourceType || '', p.updatedAt || '', JSON.stringify(p)] },\n    PRODUCT_MAPPING:",
    "    CUSTOMER_ALIAS: { key: 'CUSTOMER_ALIAS', id: 'mappingId', row: p => [p.mappingId, p.customerId || '', p.normalizedText || '', p.sourceType || '', p.updatedAt || '', JSON.stringify(p)] },\n    CUSTOMER_SOURCE_LINK: { key: 'CUSTOMER_SOURCE_LINK', id: 'linkId', row: p => [p.linkId, p.customerId || '', p.sourceSystem || '', p.sourceCustomerCode || '', p.sourceLinkKey || '', p.linkStatus || '', p.updatedAt || '', JSON.stringify(p)] },\n    CUSTOMER_SOURCE_LINK_EVENT: { key: 'CUSTOMER_SOURCE_LINK_EVENT', id: 'eventId', row: p => [p.eventId, p.linkId || '', p.eventType || '', p.beforeCustomerId || '', p.afterCustomerId || '', p.occurredAt || '', JSON.stringify(p)] },\n    PRODUCT_MAPPING:",
    'cloud simple spec');
  next = replaceOnce(next,
    "  const sheet = orderQEnsureSheet(ss, spec.key);\n  if (String(change.entityType || '') === 'ORDER_EVENT'",
    "  const sheet = orderQEnsureSheet(ss, spec.key);\n  if (String(change.entityType || '') === 'CUSTOMER_SOURCE_LINK') {\n    const sourceLinkKey = String(payload.sourceLinkKey || '');\n    if (!sourceLinkKey) throw new Error('ORDERQ_CUSTOMER_SOURCE_LINK_KEY_REQUIRED');\n    if (sheet.getLastRow() >= 2) {\n      const found = sheet.getRange(2, 5, sheet.getLastRow() - 1, 1).createTextFinder(sourceLinkKey).matchEntireCell(true).findNext();\n      if (found && String(sheet.getRange(found.getRow(), 1).getValue() || '') !== id) {\n        throw new Error(`ORDERQ_CUSTOMER_SOURCE_LINK_KEY_CONFLICT:${sourceLinkKey}`);\n      }\n    }\n  }\n  if (String(change.entityType || '') === 'ORDER_EVENT'",
    'cloud source key guard');
  return next;
});

await patch('orderq/orderq-db.js', source => replaceOnce(source,
  "\n  if (oldVersion < 8) {",
  "\n  if (oldVersion < 10) metaStore.put({ key: 'schemaVersion', value: 10, updatedAt: nowIso() });\n\n  if (oldVersion < 8) {",
  'db final v10 meta'));

await patch('orderq/customer-source-import.js', source => {
  let next = replaceOnce(source,
    "} from './customer-master.js?v=0.14.0';\n\nexport const CUSTOMER_SOURCE_SYSTEM",
    "} from './customer-master.js?v=0.14.0';\nimport { pullRemote } from './orderq-sync-engine.js?v=0.14.0';\n\nexport const CUSTOMER_SOURCE_SYSTEM",
    'source import pull dependency');
  next = replaceOnce(next,
    "  const [customers, aliases, links] = await Promise.all([\n    getAll(STORE.CUSTOMERS),",
    "  try { await pullRemote(); } catch (error) { console.warn('Customer source pre-import pull failed', error); }\n  const [customers, aliases, links] = await Promise.all([\n    getAll(STORE.CUSTOMERS),",
    'source import freshness');
  next = replaceOnce(next,
    "  const timestamp = nowIso();\n  const importBatchId = newId('CIB');\n  const records = [];\n\n  for (let index = 0; index < rows.length; index += 1) {\n    const source = mapCustomerSourceRow(rows[index], system);",
    "  const timestamp = nowIso();\n  const importBatchId = newId('CIB');\n  const records = [];\n  const mappedSources = rows.map(row => mapCustomerSourceRow(row, system));\n  const sourceLinkKeyCounts = mappedSources.reduce((map, source) => {\n    if (source.sourceLinkKey) map.set(source.sourceLinkKey, (map.get(source.sourceLinkKey) || 0) + 1);\n    return map;\n  }, new Map());\n\n  for (let index = 0; index < rows.length; index += 1) {\n    const source = mappedSources[index];",
    'source import premap');
  next = replaceOnce(next,
    "    if (!source.sourceCustomerCode) validationError = system === CUSTOMER_SOURCE_SYSTEM.SHOP ? '쇼핑몰 회원 아이디가 없습니다.' : 'ERP 거래처코드가 없습니다.';\n    else if (!source.sourceCustomerName) validationError = '거래처명이 없습니다.';",
    "    if (!source.sourceCustomerCode) validationError = system === CUSTOMER_SOURCE_SYSTEM.SHOP ? '쇼핑몰 회원 아이디가 없습니다.' : 'ERP 거래처코드가 없습니다.';\n    else if (!source.sourceCustomerName) validationError = '거래처명이 없습니다.';\n    else if ((sourceLinkKeyCounts.get(source.sourceLinkKey) || 0) > 1) validationError = '같은 출처 거래처코드가 파일에 중복되어 있습니다. 중복 행은 하나만 남기고 나머지는 제외해 주세요.';",
    'source duplicate validation');
  next = replaceOnce(next,
    "export function canApplyCustomerSourceImport(records) {\n  return records.every(record => {",
    "export function canApplyCustomerSourceImport(records) {\n  const activeKeys = records.filter(record => ![CUSTOMER_IMPORT_STATUS.EXCLUDED, CUSTOMER_IMPORT_STATUS.APPLIED].includes(effectiveStatus(record))).map(record => record.sourceLinkKey).filter(Boolean);\n  if (new Set(activeKeys).size !== activeKeys.length) return false;\n  return records.every(record => {",
    'source duplicate apply guard');
  return next;
});

await patch('scripts/test-orderq-customer-master.mjs', source => {
  let next = replaceOnce(source,
    "import { ORDERQ_DB_VERSION, V9_STORE_DEFINITIONS } from '../orderq/orderq-v9-contracts.js';",
    "import { V9_STORE_DEFINITIONS } from '../orderq/orderq-v9-contracts.js';\nimport { ORDERQ_DB_VERSION, V10_STORE_DEFINITIONS } from '../orderq/orderq-v10-contracts.js';",
    'customer test contract import');
  next = replaceOnce(next, '  db, service, picker, ui, html, css, intakeEngine, intakeWorkbench,', '  db, service, sourceImport, picker, ui, html, css, intakeEngine, intakeWorkbench,', 'customer test destructure');
  next = replaceOnce(next, "  read('orderq/customer-master.js'),\n  read('orderq/customer-picker.js'),", "  read('orderq/customer-master.js'),\n  read('orderq/customer-source-import.js'),\n  read('orderq/customer-picker.js'),", 'customer test source import read');
  next = replaceOnce(next, 'assert.equal(ORDERQ_DB_VERSION, 9);', 'assert.equal(ORDERQ_DB_VERSION, 10);', 'customer test db version');
  next = replaceOnce(next,
    "assert.deepEqual(V9_STORE_DEFINITIONS.map(store => store.name), ['customerEvents']);",
    "assert.deepEqual(V9_STORE_DEFINITIONS.map(store => store.name), ['customerEvents']);\nassert.deepEqual(V10_STORE_DEFINITIONS.map(store => store.name), ['customerSourceLinks', 'customerSourceLinkEvents']);\nassert.match(db, /oldVersion < 10/);\nassert.match(db, /bySourceLinkKey/);",
    'customer test v10 stores');
  next = replaceOnce(next, "assert.match(service, /orderq-db\\.js\\?v=0\\.12\\.1/, 'Customer Master must load the fixed DB upgrade module URL');", "assert.match(service, /orderq-db\\.js\\?v=0\\.14\\.0/, 'Customer Master must load the v10 DB module URL');", 'customer test db query');
  next = next.replace(/canApplyCustomerImport/g, 'canApplyCustomerSourceImport');
  next = next.replace(/getLatestCustomerImportWork/g, 'getLatestCustomerSourceImportWork');
  next = next.replace(/customerExcelFile/g, 'erpCustomerExcelFile');
  next = next.replace(/customer-master-ui\\\.js\\\?v=0\\\.13\\\.0/g, 'customer-master-ui\\.js\\?v=0\\.14\\.0');
  next = next.replace(/customer-master\\\.css\\\?v=0\\\.13\\\.0/g, 'customer-master\\.css\\?v=0\\.14\\.0');
  next = next.replace(/customer-master\\\.js\\\?v=0\\\.13\\\.0/g, 'customer-master\\.js\\?v=0\\.14\\.0');
  next = replaceOnce(next,
    "assert.match(ui, /elements\\.file\\.addEventListener\\('change', handleExcelSelection\\)/, 'Excel selection must have one explicit processing path');",
    "assert.match(ui, /openErpImportButton[\\s\\S]*openFilePicker\\(elements\\.erpFile\\)/, 'ERP upload must open the file picker directly');\nassert.match(ui, /openShopImportButton[\\s\\S]*openFilePicker\\(elements\\.shopFile\\)/, 'SHOP upload must open the file picker directly');",
    'customer test direct file picker');
  next = replaceOnce(next,
    "assert.match(ui, /elements\\.file\\.value = ''/, 'Excel input must reset so the same file can be selected again');",
    "assert.match(ui, /input\\.value = ''/, 'Excel input must reset so the same file can be selected again');",
    'customer test reset');
  next = replaceOnce(next,
    "assert.match(ui, /headerRow[\\s\\S]*거래처명 열을 찾을 수 없습니다/, 'Excel import must locate and validate the customer header row');",
    "assert.match(ui, /findHeaderRow[\\s\\S]*아이디와 이름\\(거래처명\\) 열을 찾을 수 없습니다/, 'Source import must validate ERP and SHOP headers');",
    'customer test header');
  next += "\nassert.match(html, /id=\"shopCustomerExcelFile\"/);\nassert.match(sourceImport, /sourceLinkKey = sourceSystem \+ \"::\" \+ sourceCustomerCode|return `\\$\\{system\\}::\\$\\{rawCode\\}`/);\nassert.match(sourceImport, /BUSINESS_NUMBER_EXACT/);\nassert.match(sourceImport, /NAME_SIMILAR/);\nassert.match(sourceImport, /same|같은 출처 거래처코드/);\nassert.match(sourceImport, /CUSTOMER_SOURCE_LINK_EVENT/);\nassert.match(sourceImport, /sourceSnapshot/);\nassert.match(sourceImport, /pullRemote\\(\\)/);\n";
  return next;
});

await patch('scripts/test-orderq-vnext-cloud-contract.mjs', source => {
  let next = replaceOnce(source,
    "  'ORDER', 'ORDER_ITEM', 'ORDER_EVENT', 'CUSTOMER_MASTER', 'CUSTOMER_ALIAS_MAPPING',\n  'PRODUCT_MAPPING'",
    "  'ORDER', 'ORDER_ITEM', 'ORDER_EVENT', 'CUSTOMER_MASTER', 'CUSTOMER_ALIAS_MAPPING',\n  'CUSTOMER_SOURCE_LINK', 'CUSTOMER_SOURCE_LINK_EVENT', 'PRODUCT_MAPPING'",
    'cloud test source sheets');
  next += "\nassert.match(cloudGs, /CUSTOMER_SOURCE_LINK: \\{ key: 'CUSTOMER_SOURCE_LINK'/);\nassert.match(cloudGs, /ORDERQ_CUSTOMER_SOURCE_LINK_KEY_CONFLICT/);\n";
  return next;
});

console.log('customer source-link patch applied');
