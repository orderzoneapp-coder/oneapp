#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'nexus/foundation/foundation-backup.js'), 'utf8');
const storage = new Map();
const local = new Map();
let writeCount = 0;
let releaseFirstWrite;
let firstWriteStarted;
const firstWriteSignal = new Promise(resolve => { firstWriteStarted = resolve; });

const context = {
  console,
  crypto: crypto.webcrypto,
  TextEncoder,
  Promise,
  Date,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Math,
  Map,
  Set,
  Error,
  setTimeout: (callback, delay) => { const handle = setTimeout(callback, delay); handle.unref(); return handle; },
  clearTimeout,
  CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  navigator: { platform: 'test' },
  localStorage: {
    getItem: key => local.has(key) ? local.get(key) : null,
    setItem: (key, value) => local.set(key, String(value))
  },
  ONEAPP: {
    STORAGE: {
      getIDB: async key => storage.get(key),
      setIDB: async (key, value) => { storage.set(key, structuredClone(value)); return value; },
      withStorageLock: async (_name, callback) => callback(),
      commitMasterStateOrThrow: async () => ({ ok: true })
    }
  },
  ONEAPP_AUTH: {
    ready: Promise.resolve(),
    gateway: async (operationId, payload) => {
      if (operationId === 'foundation.device.register') return { status: 'ACTIVE' };
      if (operationId === 'foundation.device.status_read') return { isPrimary: true, primary: { primaryEpoch: 1 } };
      if (operationId === 'foundation.backup.product_write') {
        writeCount += 1;
        if (writeCount === 1) {
          firstWriteStarted();
          await new Promise(resolve => { releaseFirstWrite = resolve; });
        }
        return { status: 'ACKED', serverRevision: writeCount, ackedAt: `2026-08-28T00:00:0${writeCount}.000Z`, backupId: payload.backupId };
      }
      throw new Error(`UNEXPECTED_OPERATION:${operationId}`);
    }
  }
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: 'foundation-backup.js' });

const api = context.NEXUS_FOUNDATION_BACKUP;
const first = await api.prepareProductCommit({ P1: { 코드: 'P1', 품목명: '상품1' } }, null, {});
await api.saveProductState(first.state);
const productId = first.masterMap.P1.productId;
assert.match(productId, /^PROD-[a-f0-9]{32}$/);

const inFlight = api.backupProductNow();
await firstWriteSignal;
const sending = await api.productState();
assert.equal(sending.status, 'BACKUP_IN_PROGRESS');
const second = await api.prepareProductCommit({
  P1: { ...first.masterMap.P1, 품목명: '상품1 변경' },
  P2: { 코드: 'P2', 품목명: '상품2' }
}, sending, {});
await api.saveProductState(second.state);
assert.equal(second.masterMap.P1.productId, productId, 'deterministic productId must survive edits');
releaseFirstWrite();
await inFlight;

const rebased = await api.productState();
assert.equal(rebased.status, 'LOCAL_OK_BACKUP_PENDING');
assert.equal(rebased.baseServerRevision, 1);
assert.ok(rebased.pending, 'a newer local commit must survive an older in-flight ACK');
assert.equal(rebased.pending.baseServerRevision, 1, 'the descendant pending snapshot must rebase only after its direct ancestor ACK');
assert.equal(rebased.pending.ancestorBackupId, '');

await api.backupProductNow();
const completed = await api.productState();
assert.equal(completed.status, 'LOCAL_OK_BACKUP_OK');
assert.equal(completed.baseServerRevision, 2);
assert.equal(completed.pending, null);
assert.equal(writeCount, 2);

console.log('Foundation product client concurrent commit, lineage rebase and stable identity: PASS');
