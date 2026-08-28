import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const html = readFileSync(resolve(root, 'ItemMaster.html'), 'utf8');
const destructiveSeedPage = resolve(root, 'scripts', 'fixtures', 'itemmaster-isolated-seed.html');

assert.equal(
  existsSync(destructiveSeedPage),
  false,
  'destructive ItemMaster seed page must never be published with the application'
);

const required = [
  ['ItemMaster title', '<title>ONEAPP ItemMaster · 독립 상품관리</title>'],
  ['isolated database', "DB_NAME: 'oneapp-itemmaster-isolated-v1'"],
  ['product store', "MASTER_STORE: 'products'"],
  ['snapshot key', "SNAPSHOT: 'itemMasterSnapshot_v1'"],
  ['revision key', "REVISION: 'itemMasterRevision_v1'"],
  ['Excel parser', 'parseMasterAddUpdateWorkbook'],
  ['Excel analysis', 'analyzeUploadRows'],
  ['approved execution plan', 'buildExecutionPlan'],
  ['isolated save', 'saveMasterLocal(plan.nextMaster, addUpdateAnalysis.baseRevision)'],
  ['revision conflict protection', "error?.code === 'ITEMMASTER_REVISION_CONFLICT'"],
  ['Excel upload input', 'accept=".xlsx,.xls"'],
  ['standalone header', 'ITEMMASTER'],
  ['standalone label', '독립 상품관리'],
  ['initial Excel import builder', 'buildInitialMasterImport'],
  ['initial import confirmation', 'ItemMaster 최초 Excel 등록'],
  ['initial import save', 'saveMasterLocal(initialImportDraft.masterMap, initialImportDraft.baseRevision)'],
  ['single product editor', 'ProductEditorModal'],
  ['single product validation', 'validateSingleProductInput(form)'],
  ['single product save', 'handleSaveProduct'],
  ['single product edit action', 'setEditingProduct(row)']
];

for (const [label, value] of required) {
  assert.ok(html.includes(value), `${label} contract is missing`);
}

const forbidden = [
  ['operating database', /indexedDB\.open\(['"]MerchOpsDB/],
  ['operating snapshot key', /merchMaster_v870/],
  ['operating storage API', /ONEAPP\?*\.?STORAGE|ONEAPP\.STORAGE/],
  ['operating history API', /ONEAPP\?*\.?HISTORY|ONEAPP\.HISTORY/],
  ['operating localStorage', /\blocalStorage\s*\./],
  ['network request', /\bfetch\s*\(/],
  ['core engine', /coreEngine\.js/],
  ['common runtime', /nexus\/common\/nexus-ui\.js/],
  ['settings iframe', /IframeSettingsModal|settings\.html\?mode=iframe/],
  ['old app route', /Dashboard\.html|Item_manager\.html|Pipeline\.html|Parser\.html|partner_db\.html|partners\.html/],
  ['Pipeline feature', /\bPipeline\b/],
  ['BOM feature', /\bBOM\b/],
  ['catalog feature', /카탈로그|\bcatalog\b/i],
  ['cloud action', /handlePush|handlePull|pullMerchOpsCloudMaster|pushMerchOpsCloudMaster/],
  ['blocked initial import copy', /최초 등록은 1차 미구현|최초 등록 · 1차 미구현/],
  ['disabled empty Excel upload', /disabled=\{isProcessing \|\| Object\.keys\(masterProducts\)\.length === 0\}/]
];

for (const [label, pattern] of forbidden) {
  assert.equal(pattern.test(html), false, `${label} must not be present`);
}

assert.match(
  html,
  /db\.transaction\(\[STORAGE_KEYS\.MASTER_STORE, STORAGE_KEYS\.STATE_STORE\], 'readwrite'\)/,
  'products, snapshot and revision must share one write transaction'
);

console.log('PASS ItemMaster standalone source contracts');
