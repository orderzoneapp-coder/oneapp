import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const read = (path) => readFile(path, 'utf8');
const coreSource = await read('customer-master/core.js');
const core = await import(`data:text/javascript;base64,${Buffer.from(coreSource).toString('base64')}`);

assert.equal(core.APP_ID, 'customer-master');
assert.equal(core.DB_NAME, 'oneapp-customermaster-v1');
assert.equal(core.SNAPSHOT_SCHEMA_VERSION, 'ONEAPP_CUSTOMER_SNAPSHOT_V1');

const mapping = core.defaultHeaderMapping(['거래처코드', '거래처명', '여신한도', '참고열']);
assert.equal(mapping[0].targetFieldKey, 'sourceCustomerCode', 'ERP code must map to the ERP source link, not overwrite the NEXUS code');
assert.equal(core.defaultHeaderMapping(['거래처코드'], [{
  sourceSystem: 'ERP', normalizedHeader: core.normalizeHeader('거래처코드'), targetFieldKey: 'customerCode', enabled: true,
}], [], 'ERP')[0].targetFieldKey, 'sourceCustomerCode', 'legacy saved mappings must migrate to source-code links');
const records = core.analyzeImportRows([
  { 거래처코드: 'DUP', 거래처명: '중복1', 여신한도: '', 참고열: '' },
  { 거래처코드: 'DUP', 거래처명: '중복2', 여신한도: '', 참고열: '' },
  { 거래처코드: 'B-01', 거래처명: '', 여신한도: 0, 참고열: '원문' },
  { 거래처코드: 'C-01', 거래처명: '신규', 여신한도: '', 참고열: '' },
  { 거래처코드: '합계', 거래처명: '', 여신한도: '', 참고열: '' },
  { 거래처코드: '', 거래처명: '', 여신한도: '', 참고열: '' },
], mapping, [{ customerId: 'CU-B', customerCode: 'B-01', customerName: '기존명', creditLimitAmount: 10, revision: 4 }]);

assert.equal(records[0].resultType, 'FAILED', 'duplicate rows must fail independently');
assert.equal(records[0].reasonCode, 'DUPLICATE_SOURCE_CODE_IN_IMPORT');
assert.equal(records[1].resultType, 'FAILED');
assert.equal(records[2].resultType, 'READY_LINK');
assert.equal(records[2].values.creditLimitAmount, 0, 'numeric zero must be applied');
assert.equal('customerName' in records[2].values, false, 'blank cells must preserve existing values');
assert.deepEqual(records[2].unmatchedValues, { 참고열: '원문' }, 'unmapped source text must remain inspectable');
assert.equal(records[3].resultType, 'READY_CREATE');
assert.equal(records[4].resultType, 'SYSTEM_ROW_EXCLUDED');
assert.equal(records[5].resultType, 'EMPTY_ROW_EXCLUDED');

const detected = core.tabularRows([
  ['회사명 : 원앱'],
  ['담당자명', '거래처코드', '거래처명', '핸드폰번호'],
  ['홍길동', 'ERP-01', '원앱 거래처', '010-0000-0000'],
]);
assert.equal(detected.headerRowNumber, 2, 'a report title row must not be mistaken for the Excel header');
assert.deepEqual(detected.headers, ['담당자명', '거래처코드', '거래처명', '핸드폰번호']);
assert.deepEqual(detected.rowNumbers, [3]);

const shopMapping = core.defaultHeaderMapping(['아이디', '이름(거래처명)', '닉네임', '휴대폰번호'], [], [], 'SHOP');
assert.equal(shopMapping[0].targetFieldKey, 'sourceCustomerCode');
assert.equal(shopMapping[1].targetFieldKey, 'customerName');
assert.equal(shopMapping[2].targetFieldKey, 'sourceNickname');
const shopRecords = core.analyzeImportRows([
  { 아이디: 'member-1', '이름(거래처명)': '원앱 상사', 닉네임: '원앱', 휴대폰번호: '010-1234-5678' },
], shopMapping, [{ customerId: 'CU-NEXUS', customerCode: 'LEGACY', customerName: '원앱상사', mobile: '010-1234-5678', revision: 2 }], {
  sourceSystem: 'SHOP', sourceLinks: [], rowNumbers: [2],
});
assert.equal(shopRecords[0].resultType, 'READY_LINK', 'SHOP code must link to a strong NEXUS customer match');
assert.equal(shopRecords[0].existingCustomerId, 'CU-NEXUS');
assert.equal('customerName' in shopRecords[0].values, false, 'SHOP data must not overwrite populated ERP-owned customer fields');

const ranked = core.searchCustomerRows([
  { customerId: 'A', customerCode: '100', customerName: '다른 곳' },
  { customerId: 'B', customerCode: '200', customerName: '100' },
], [], [], '100');
assert.equal(ranked[0].customerId, 'A', 'exact customer code must outrank exact name');
assert.equal(core.missingCustomerFields({ customerName: '상호', address: '', mobile: '' }).length, 2);

const files = await readdir('customer-master');
const sources = (await Promise.all(files.filter((file) => /\.(?:html|js|css)$/.test(file)).map((file) => read(`customer-master/${file}`)))).join('\n');
assert.doesNotMatch(sources, /(?:src|href)=["']https?:\/\/|(?:import|from)\s*["']https?:\/\//i, 'the independent app must not load an external CDN or server');
assert.doesNotMatch(sources, /\bfetch\s*\(|XMLHttpRequest|WebSocket|google\.script/i, 'the local core must not require cloud transport');
assert.doesNotMatch(sources, /localStorage\.(?:setItem|getItem)|administrator/i, 'the app must not store secrets or invent a default administrator');
assert.match(sources, /LAST_VERIFIED_OFFLINE/);
assert.match(sources, /operationId/);
assert.match(sources, /baseRevision/);
assert.match(sources, /oneapp-orderq-vnext/);
assert.match(sources, /LEGACY_EXPECTED_VERSION\s*=\s*17/);

const html = await read('customer-master/index.html');
for (const label of ['거래처 목록', '정보 보완', 'Excel 등록·수정', '매핑사전', '변경이력', '데이터 이전·복원']) {
  assert.ok(html.includes(`>${label}<`), `required tab label: ${label}`);
}
for (const label of ['거래처 등록', '변경 저장', '등록·수정 실행', 'Snapshot 내보내기', 'v17 데이터 확인']) {
  assert.ok(html.includes(`>${label}<`), `required button label: ${label}`);
}

const dbSource = await read('customer-master/db.js');
for (const store of ['customers', 'customerAliases', 'customerEvents', 'customerSourceLinks', 'customerSourceLinkEvents', 'customerHeaderMappings', 'customerUserFieldDefinitions', 'importBatches', 'sourceRecords', 'migrationSnapshots', 'appMeta']) {
  assert.ok(dbSource.includes(`'${store}'`), `required owned store: ${store}`);
}

const manifest = JSON.parse(await read('app-manifest.json'));
const app = manifest.applications.find((entry) => entry.id === 'customer-master');
assert.equal(app.path, 'customer-master/index.html');
assert.equal(app.status, 'pilot');
assert.deepEqual(app.sharedContracts, ['customer-master']);
const contract = manifest.sharedDataContracts.find((entry) => entry.id === 'customer-master');
assert.equal(contract.owner, 'customer-master');
assert.equal(contract.localDatabase, 'oneapp-customermaster-v1');
assert.deepEqual(contract.consumers, [], 'consumer apps must be connected in separate verified work');

console.log('PASS independent CustomerMaster contracts and import rules');
