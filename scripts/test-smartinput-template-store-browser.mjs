#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = process.cwd();
const mime = new Map([
  ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8']
]);

const server = http.createServer((request, response) => {
  if (request.url === '/__template_store_test__') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>SmartInput template store test</title>');
    return;
  }
  const relative = decodeURIComponent(String(request.url || '/').split('?')[0]).replace(/^\/+/, '');
  const absolute = path.resolve(root, relative);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!absolute.startsWith(rootPrefix) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'content-type': mime.get(path.extname(absolute)) || 'application/octet-stream' });
  fs.createReadStream(absolute).pipe(response);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browserCandidates = [
  process.env.ONEAPP_TEST_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);
const executablePath = browserCandidates.find(candidate => fs.existsSync(candidate));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

try {
  const page = await browser.newPage();
  await page.goto(`${origin}/__template_store_test__`);
  const result = await page.evaluate(async () => {
    const deleteDb = name => new Promise(resolve => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
    const open = (name, version, upgrade) => new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      request.onupgradeneeded = () => upgrade?.(request.result, request.transaction);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const txDone = transaction => new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
    const getAll = (db, storeName) => new Promise((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await deleteDb('oneapp-smartinput');
    const legacy = await open('oneapp-smartinput', 3, db => {
      const settings = db.createObjectStore('settings', { keyPath: 'key' });
      settings.put({ key: 'app', value: { preserved: true }, updatedAt: 'legacy-settings' });
      db.createObjectStore('customerLinkGroups', { keyPath: 'linkGroupId' });
      db.createObjectStore('temporaryCustomers', { keyPath: 'customerId' });
      db.createObjectStore('customerAliasMappings', { keyPath: 'aliasMappingId' });
      const estimates = db.createObjectStore('estimates', { keyPath: 'estimateId' });
      estimates.put({ estimateId: 'legacy-estimate', catalogName: '기존 견적', revision: 7 });
      const images = db.createObjectStore('sourceImages', { keyPath: 'documentId' });
      images.put({ documentId: 'legacy-image', mode: 'order', dataUrl: 'data:image/png;base64,AA==' });
    });
    legacy.close();
    const store = await import('/smartinput/smartinput-data-store.js?store-browser-test=1');
    const core = await import('/smartinput/input-template-core.js?store-browser-test=1');
    const upgraded = await store.openSmartInputDatabase();
    const storeNames = [...upgraded.objectStoreNames];
    const settingsBefore = JSON.stringify(await getAll(upgraded, 'settings'));
    const estimatesBefore = JSON.stringify(await getAll(upgraded, 'estimates'));
    const imagesBefore = JSON.stringify(await getAll(upgraded, 'sourceImages'));
    const indexNames = [...upgraded.transaction('inputTemplates').objectStore('inputTemplates').indexNames];
    upgraded.close();

    const mappings = [
      { sourceHeader: '품목코드', normalizedSourceHeader: '품목코드', sourceAliases: [], targetFieldKey: 'itemCode', valueType: 'TEXT', requiredRole: 'ITEM_IDENTITY' },
      { sourceHeader: '품목명', normalizedSourceHeader: '품목명', sourceAliases: [], targetFieldKey: 'itemName', valueType: 'TEXT', requiredRole: 'ITEM_IDENTITY' },
      { sourceHeader: '수량', normalizedSourceHeader: '수량', sourceAliases: [], targetFieldKey: 'quantity', valueType: 'NUMBER' }
    ];
    const columns = mappings.map((mapping, order) => ({ fieldKey: mapping.targetFieldKey, displayLabel: mapping.sourceHeader, order, visible: true }));
    const created = {};
    for (const mode of ['order', 'purchase', 'sale', 'estimate']) {
      const output = await store.createInputTemplate({ mode, name: `${mode} 저장 양식`, mappings, columns }, {
        sessionMode: core.TEMPLATE_SESSION_MODES.CREATE
      });
      created[mode] = output.record;
    }
    let duplicateCode = '';
    try {
      await store.createInputTemplate({ mode: 'order', name: ' ORDER 저장 양식 ', mappings, columns }, {
        sessionMode: core.TEMPLATE_SESSION_MODES.CREATE
      });
    } catch (error) { duplicateCode = error.code; }
    const orderBefore = JSON.stringify(await store.getInputTemplate(created.order.templateId));
    let putCount = 0;
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { putCount += 1; return originalPut.apply(this, args); };
    let lockedCode = '';
    try {
      await store.updateInputTemplateStructure(created.order.templateId, 1, {
        columns: columns.map(column => ({ ...column, displayLabel: `변경 ${column.displayLabel}` }))
      }, { sessionMode: core.TEMPLATE_SESSION_MODES.FILL });
    } catch (error) { lockedCode = error.code; }
    const lockedPutCount = putCount;
    const idbSame = await store.updateInputTemplateStructure(created.order.templateId, 1, created.order, {
      sessionMode: core.TEMPLATE_SESSION_MODES.CREATE
    });
    const noOpPutCount = putCount - lockedPutCount;
    IDBObjectStore.prototype.put = originalPut;
    const orderAfter = JSON.stringify(await store.getInputTemplate(created.order.templateId));
    const updated = await store.updateInputTemplateStructure(created.order.templateId, 1, {
      columns: columns.map(column => column.fieldKey === 'itemName' ? { ...column, displayLabel: '상품 표시명' } : column)
    }, { sessionMode: core.TEMPLATE_SESSION_MODES.CREATE });
    const same = await store.updateInputTemplateStructure(created.order.templateId, 2, updated.record, {
      sessionMode: core.TEMPLATE_SESSION_MODES.CREATE
    });
    let conflictCode = '';
    try {
      await store.updateInputTemplateStructure(created.order.templateId, 1, updated.record, {
        sessionMode: core.TEMPLATE_SESSION_MODES.CREATE
      });
    } catch (error) { conflictCode = error.code; }

    const verify = await store.openSmartInputDatabase();
    const settingsAfter = JSON.stringify(await getAll(verify, 'settings'));
    const estimatesAfter = JSON.stringify(await getAll(verify, 'estimates'));
    const imagesAfter = JSON.stringify(await getAll(verify, 'sourceImages'));
    verify.close();
    return {
      version: store.SMARTINPUT_DB_VERSION, storeNames, indexNames,
      legacyBytesEqual: settingsBefore === settingsAfter && estimatesBefore === estimatesAfter && imagesBefore === imagesAfter,
      createdModes: Object.keys(created), duplicateCode, lockedCode,
      lockedPutCount, noOpPutCount, idbSameChanged: idbSame.changed,
      recordBytesEqual: orderBefore === orderAfter,
      updatedRevision: updated.record.revision,
      sameChanged: same.changed,
      sameRevision: same.record.revision,
      conflictCode
    };
  });

  assert.equal(result.version, 4);
  assert.ok(result.storeNames.includes('inputTemplates'));
  assert.deepEqual(result.indexNames.sort(), ['byMode', 'byNormalizedName', 'byStatus', 'byUpdatedAt'].sort());
  assert.equal(result.legacyBytesEqual, true, 'DB v3 records must remain byte-equivalent after the v4 upgrade');
  assert.deepEqual(result.createdModes, ['order', 'purchase', 'sale', 'estimate']);
  assert.equal(result.duplicateCode, 'TEMPLATE_NAME_DUPLICATE');
  assert.equal(result.lockedCode, 'TEMPLATE_STRUCTURE_LOCKED');
  assert.equal(result.lockedPutCount, 0, 'existing-template structure write attempts must issue zero object-store puts');
  assert.equal(result.idbSameChanged, false);
  assert.equal(result.noOpPutCount, 0, 'unchanged structure hashes must issue zero object-store puts');
  assert.equal(result.recordBytesEqual, true, 'existing-template import/lock path must preserve the record bytes');
  assert.equal(result.updatedRevision, 2);
  assert.equal(result.sameChanged, false);
  assert.equal(result.sameRevision, 2);
  assert.equal(result.conflictCode, 'TEMPLATE_REVISION_CONFLICT');

  const fallbackPage = await browser.newPage();
  await fallbackPage.goto(`${origin}/__template_store_test__`);
  const fallback = await fallbackPage.evaluate(async () => {
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: null });
    localStorage.clear();
    const store = await import('/smartinput/smartinput-data-store.js?store-fallback-test=1');
    const core = await import('/smartinput/input-template-core.js?store-fallback-test=1');
    const mappings = [
      { sourceHeader: '품목코드', targetFieldKey: 'itemCode', valueType: 'TEXT', requiredRole: 'ITEM_IDENTITY' },
      { sourceHeader: '품목명', targetFieldKey: 'itemName', valueType: 'TEXT', requiredRole: 'ITEM_IDENTITY' }
    ];
    const columns = mappings.map((mapping, order) => ({ fieldKey: mapping.targetFieldKey, displayLabel: mapping.sourceHeader, order, visible: true }));
    const created = await store.createInputTemplate({ mode: 'estimate', name: 'fallback', mappings, columns }, {
      sessionMode: core.TEMPLATE_SESSION_MODES.CREATE
    });
    const before = JSON.stringify(await store.getInputTemplate(created.record.templateId));
    let code = '';
    try {
      await store.updateInputTemplateStructure(created.record.templateId, 1, { columns: [] }, {
        sessionMode: core.TEMPLATE_SESSION_MODES.FILL
      });
    } catch (error) { code = error.code; }
    const after = JSON.stringify(await store.getInputTemplate(created.record.templateId));
    let setItemCount = 0;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (...args) { setItemCount += 1; return originalSetItem.apply(this, args); };
    const same = await store.updateInputTemplateStructure(created.record.templateId, 1, created.record, {
      sessionMode: core.TEMPLATE_SESSION_MODES.CREATE
    });
    Storage.prototype.setItem = originalSetItem;
    return {
      count: (await store.listInputTemplates('estimate')).length,
      code,
      equal: before === after,
      sameChanged: same.changed,
      noOpWrites: setItemCount
    };
  });
  assert.deepEqual(fallback, {
    count: 1,
    code: 'TEMPLATE_STRUCTURE_LOCKED',
    equal: true,
    sameChanged: false,
    noOpWrites: 0
  });
  console.log('SmartInput DB v3→v4 template store and fallback tests passed.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
