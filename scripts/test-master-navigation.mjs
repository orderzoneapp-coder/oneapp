#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const master = fs.readFileSync(path.join(root, 'Master.html'), 'utf8');
const customer = fs.readFileSync(path.join(root, 'partner_db.html'), 'utf8');

assert.match(master, /rawView === 'customers' \? 'customers' : 'products'/, 'invalid and missing view must default to products');
assert.match(master, /rawMode === 'batch' \? 'batch' : 'list'/, 'invalid and missing mode must default to list');
assert.match(master, /window\.history\.pushState/, 'tab changes must update the URL without reloading');
assert.match(master, /window\.addEventListener\('popstate'/, 'back and forward navigation must restore tab state');
assert.match(master, /\[\['products', '상품'\], \['customers', '거래처'\]\]/, 'primary product/customer tabs must exist');
assert.match(master, /\[\['list', '목록'\], \['batch', '일괄 관리'\]\]/, 'secondary list/batch tabs must exist');
assert.match(master, /role="tablist"/, 'tab lists must use tab semantics');
assert.match(master, /role="tab" aria-selected=/, 'tabs must expose selected state');
assert.match(master, /aria-current=.*'page'/, 'active tabs must expose aria-current');
assert.match(master, /focus-visible:ring-2/, 'tabs and actions must have visible keyboard focus');
assert.match(master, /상품 목록/, 'product list title must exist');
assert.match(master, /상품 일괄 등록·수정/, 'product batch title must exist');
assert.match(master, /신규 등록/, 'product list must expose new registration');
assert.match(master, /단건 수정/, 'product list must expose single-item editing');
assert.match(master, /customerMasterFrame/, 'customer workbench must stay mounted');
assert.match(master, /ONEAPP_MASTER_MODE/, 'customer mode changes must use in-place messaging');
assert.match(master, /partner_db\.html\?embedded=1&mode=/, 'customer iframe must receive the initial mode');

assert.match(customer, /initialCustomerMasterMode/, 'customer page must read mode from its URL');
assert.match(customer, /Master\.html\?view=customers&mode=/, 'legacy customer entry must redirect to the compatible Master route');
assert.match(customer, /data-master-mode="list"/, 'customer list visibility must be mode-scoped');
assert.match(customer, /data-master-mode="batch"/, 'customer batch visibility must be mode-scoped');
assert.match(customer, /거래처 목록/, 'customer list title must exist');
assert.match(customer, /거래처 일괄 등록·수정/, 'customer batch title must exist');
assert.match(customer, /cm-batch-only[^>]*id="openErpImportButton"/, 'ERP Excel action must be batch-only');
assert.match(customer, /cm-batch-only[^>]*id="openShopImportButton"/, 'shop Excel action must be batch-only');
assert.match(customer, /cm-list-only[^>]*id="newCustomerButton"/, 'single customer registration must be list-only');
assert.match(customer, /ONEAPP_MASTER_MODE/, 'customer iframe must accept in-place mode changes');
assert.doesNotMatch(customer, /ENTITY REGISTRY/, 'legacy decorative registry title must be removed');

console.log('Master two-level navigation tests passed.');
