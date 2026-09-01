#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  REFERENCE_DOMAINS,
  buildReferenceGeneration,
  normalizeReferenceDomainSnapshot
} from '../smartinput/reference-generation-repository.js';

const snapshots = {
  customer: { status: 'READY', revision: 3, rows: [{ customerId: 'C1', customerCode: '001', customerName: '거래처' }] },
  product: { status: 'READY', revision: 5, rows: [{ productId: 'P1', itemCode: '0001', itemName: '상품' }] },
  warehouse: { status: 'READY', revision: 2, rows: [{ warehouseId: 'W1', warehouseCode: '01', warehouseName: '1창고' }] },
  employee: { status: 'READY', revision: 1, rows: [{ loginId: 'admin', displayName: '관리자' }] },
  project: { status: 'EMPTY', revision: 0, rows: [] },
  fieldDefinition: { status: 'READY', revision: 'F2', rows: [{ fieldId: 'voucher.sale.line.quantity', displayLabel: '판매수량' }] }
};

const bundle = buildReferenceGeneration({
  companyId: 'ONEAPP',
  generationId: 'REFGEN-TEST-1',
  snapshots,
  startedAt: '2026-09-01T00:00:00.000Z'
});
assert.equal(bundle.generation.schemaVersion, 'ONEAPP_REFERENCE_GENERATION_V1');
assert.equal(bundle.generation.status, 'STAGED');
assert.deepEqual(Object.keys(bundle.generation.domains), REFERENCE_DOMAINS);
assert.equal(bundle.generation.domains.project.status, 'EMPTY');
assert.equal(bundle.entities.length, 5);
assert.equal(bundle.entities.every(row => row.companyId === 'ONEAPP' && row.generationId === 'REFGEN-TEST-1'), true);

assert.throws(() => buildReferenceGeneration({
  companyId: 'ONEAPP', generationId: 'REFGEN-MISSING', snapshots: { ...snapshots, project: undefined }
}), /SMARTINPUT_REFERENCE_DOMAIN_MISSING:project/);
assert.throws(() => normalizeReferenceDomainSnapshot('product', {
  status: 'READY', rows: [{ productId: 'P1' }, { productId: 'P1' }]
}, 'ONEAPP'), /SMARTINPUT_REFERENCE_ENTITY_DUPLICATED/);
assert.throws(() => normalizeReferenceDomainSnapshot('project', { status: 'EMPTY', rows: [{ projectId: 'X' }] }, 'ONEAPP'),
  /SMARTINPUT_REFERENCE_EMPTY_HAS_ROWS/);

const store = fs.readFileSync(new URL('../smartinput/smartinput-data-store.js', import.meta.url), 'utf8');
assert.match(store, /REFERENCE_GENERATIONS_V1/);
assert.match(store, /REFERENCE_ENTITIES_V1/);
assert.match(store, /db\.transaction\(\[\s*DATA_STORES\.REFERENCE_GENERATIONS_V1,[\s\S]*DATA_STORES\.REFERENCE_ENTITIES_V1,[\s\S]*DATA_STORES\.SETTINGS[\s\S]*'readwrite'\)/,
  '세대와 활성 포인터는 하나의 IndexedDB transaction에서 교체해야 한다.');

console.log('SmartInput six-domain immutable reference generation validation and atomic activation contract passed.');
