import { createHash, createHmac, randomUUID, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class MemoryRange {
  constructor(sheet, row, column, rowCount = 1, columnCount = 1) { Object.assign(this, { sheet, row, column, rowCount, columnCount }); }
  setValues(values) {
    for (let r = 0; r < this.rowCount; r += 1) for (let c = 0; c < this.columnCount; c += 1) this.sheet.set(this.row + r, this.column + c, values[r][c]);
    return this;
  }
  getValues() {
    return Array.from({ length: this.rowCount }, (_, r) => Array.from({ length: this.columnCount }, (_, c) => this.sheet.get(this.row + r, this.column + c)));
  }
  getValue() { return this.sheet.get(this.row, this.column); }
}
class MemorySheet {
  constructor(name) { this.name = name; this.rows = []; }
  set(row, column, value) { while (this.rows.length < row) this.rows.push([]); this.rows[row - 1][column - 1] = value; }
  get(row, column) { return this.rows[row - 1]?.[column - 1] ?? ''; }
  getRange(row, column, rowCount = 1, columnCount = 1) { return new MemoryRange(this, row, column, rowCount, columnCount); }
  getLastRow() { for (let index = this.rows.length - 1; index >= 0; index -= 1) if (this.rows[index].some(value => value !== '' && value !== undefined)) return index + 1; return 0; }
  clearContents() { this.rows = []; return this; }
  appendRow(values) { this.rows.push([...values]); return this; }
}
class MemorySpreadsheet {
  constructor() { this.sheets = new Map(); }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) { const sheet = new MemorySheet(name); this.sheets.set(name, sheet); return sheet; }
}

export function makeAuthority({ entities = [], cursor = 22, ledgerSequence = 7 } = {}) {
  const ss = new MemorySpreadsheet();
  const values = new Map();
  const properties = {
    getProperty: key => values.get(key) || '',
    setProperty: (key, value) => { values.set(key, String(value)); },
    deleteProperty: key => values.delete(key)
  };
  const sha256Hex = value => createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
  const context = {
    console, Map, Set, Date, JSON, Math, Number, String, Object, Array, RegExp, Error,
    PropertiesService: { getScriptProperties: () => properties },
    Utilities: {
      Charset: { UTF_8: 'UTF_8' },
      getUuid: randomUUID,
      computeHmacSha256Signature: (value, key) => [...createHmac('sha256', key).update(String(value), 'utf8').digest()].map(byte => byte > 127 ? byte - 256 : byte)
    },
    sha256Hex,
    getOrCreateSheet: (spreadsheet, name) => spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name),
    orderQM9ReadAllEntities: () => structuredClone(entities),
    orderQM9ReadChanges: () => ({ rows: entities.filter(row => row.entityType === 'INVENTORY_MOVEMENT').map((row, index) => ({
      sequence: index + 1, deviceId: 'TEST', commandId: `C${index + 1}`, entityType: row.entityType,
      entityId: row.entityId, revision: row.revision, payload: row.payload
    })) }),
    orderQM9ChangeDigest: rows => sha256Hex(JSON.stringify(rows)),
    orderQM9MetaNumber: (_spreadsheet, key) => key === 'syncSequence' ? cursor : key === 'ledgerSequence' ? ledgerSequence : 0
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../dataops-situation-v2.gs', import.meta.url), 'utf8'), context);
  return { context, ss, properties, values };
}

export function baseEntities(extra = []) {
  return [
    { entityType: 'PRODUCT', entityId: 'P1', revision: 3, status: 'ACTIVE', payload: { revision: 3, status: 'ACTIVE', baseUnit: 'EA', baseUnitRuleVersion: 'RULE-1' } },
    { entityType: 'PRODUCT', entityId: 'P2', revision: 4, status: 'ACTIVE', payload: { revision: 4, status: 'ACTIVE', baseUnit: 'EA', baseUnitRuleVersion: 'RULE-1' } },
    { entityType: 'WAREHOUSE', entityId: 'W1', revision: 2, status: 'ACTIVE', payload: { revision: 2, status: 'ACTIVE' } },
    { entityType: 'WAREHOUSE', entityId: 'W2', revision: 5, status: 'ACTIVE', payload: { revision: 5, status: 'ACTIVE' } },
    { entityType: 'INVENTORY_MOVEMENT', entityId: 'M1', revision: 3, status: 'CONFIRMED', payload: { productId: 'P1', warehouseId: 'W1', baseUnit: 'EA', signedBaseQuantity: -2, ledgerSequence: 3, effectKey: 'E1' } },
    { entityType: 'INVENTORY_MOVEMENT', entityId: 'M2', revision: 7, status: 'CONFIRMED', payload: { productId: 'P1', warehouseId: 'W1', baseUnit: 'EA', signedBaseQuantity: 4, ledgerSequence: 7, effectKey: 'E2' } },
    ...extra
  ];
}

export function configureAuthority(authority, roles = ['DATAOPS_SITUATION_READ', 'DATAOPS_SITUATION_PUBLISH']) {
  const token = 'runtime-secret-token';
  const digest = createHash('sha256').update(token).digest('hex');
  authority.values.set('ONEAPP_DATAOPS_SITUATION_AUTH_BINDINGS_JSON', JSON.stringify([{ tokenDigest: digest, actorId: 'ADMIN-1', roleIds: roles, status: 'ACTIVE' }]));
  authority.values.set('ONEAPP_DATAOPS_SITUATION_TOKEN_SIGNING_KEY', 'signing-key-not-for-storage');
  authority.values.set('ONEAPP_DATAOPS_SITUATION_DEPLOYMENT_ID', 'DEPLOY-V2');
  authority.values.set('ONEAPP_DATAOPS_SITUATION_DEPLOYMENT_VERSION', '1');
  authority.values.set('ONEAPP_DATAOPS_SITUATION_GIT_COMMIT', 'commit-v2');
  return { token, actorId: 'ADMIN-1', scope: { companyId: 'ONEAPP' } };
}

export function snapshotInput(context, overrides = {}) {
  const { row: rowOverrides = {}, ...snapshotOverrides } = overrides;
  const productIds = new Set(['P1']);
  const warehouseIds = new Set(['W1']);
  const head = context.dataOpsSituationAuthorityHead(null, productIds, warehouseIds);
  const row = {
    rowRevision: 1, productId: 'P1', productMasterRevision: 3,
    warehouseId: 'W1', warehouseMasterRevision: 2, baseUnit: 'EA', baseUnitRuleVersion: 'RULE-1',
    signedBaseQuantity: -5, includedOrderQLedgerSequence: 7, businessDate: '2026-08-25',
    sourceEvidence: [
      { sourceEvidenceId: context.dataOpsSituationDigest({ movementId: 'M1', effectKey: 'E1', movementRevision: 3 }), movementId: 'M1', effectKey: 'E1', movementRevision: 3 },
      { sourceEvidenceId: context.dataOpsSituationDigest({ movementId: 'M2', effectKey: 'E2', movementRevision: 7 }), movementId: 'M2', effectKey: 'E2', movementRevision: 7 }
    ]
  };
  return { schemaVersion: 'DATAOPS_SITUATION_READ_V2', businessDate: '2026-08-25', authorityHead: { cursor: head.cursor, ledgerSequence: head.ledgerSequence,
    masterDigest: head.masterDigest, changeDigest: head.changeDigest, movementDigest: head.movementDigest }, rows: [{ ...row, ...rowOverrides }], tombstones: [], ...snapshotOverrides };
}

export function loadBrowserModule() {
  const window = { crypto: webcrypto, TextEncoder, fetch: async () => { throw new Error('FETCH_NOT_CONFIGURED'); } };
  window.window = window;
  vm.createContext(window);
  vm.runInContext(readFileSync(new URL('../DataOps_situation_v2.js', import.meta.url), 'utf8'), window);
  return window;
}
