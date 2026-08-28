(function (global) {
  'use strict';

  const API = global.NEXUS_FOUNDATION_BACKUP = global.NEXUS_FOUNDATION_BACKUP || {};
  const SCHEMA_VERSION = 'FOUNDATION_BACKUP_V1';
  const PRODUCT_STATE_KEY = 'oneapp.foundation.product-backup-state.v1';
  const DEVICE_KEY = 'oneapp.foundation.device-id.v1';
  const FLAGS_KEY = 'oneapp.foundation.bplus-flags.v1';
  const DEFAULT_FLAGS = Object.freeze({
    BPLUS_BACKUP_ENABLED: true,
    BPLUS_AUTO_PULL_DISABLED: true,
    BPLUS_PRIMARY_GUARD_MODE: 'ENFORCE',
    BPLUS_CUSTOMER_RECOVERY_COMPLETED: false,
    BPLUS_SHADOW_COMPARE_ENABLED: false
  });

  function text(value) { return String(value == null ? '' : value).trim(); }

  function canonical(value) {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (typeof value === 'object') {
      return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonical(value));
    if (!global.crypto?.subtle) throw new Error('BPLUS_WEB_CRYPTO_REQUIRED');
    const digest = await global.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function uuid(prefix) {
    const token = global.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    return `${prefix}-${token}`;
  }

  function getDeviceId() {
    let deviceId = text(global.localStorage?.getItem(DEVICE_KEY));
    if (!deviceId) {
      deviceId = uuid('DEV');
      global.localStorage?.setItem(DEVICE_KEY, deviceId);
    }
    return deviceId;
  }

  function readFlags() {
    let stored = {};
    try { stored = JSON.parse(global.localStorage?.getItem(FLAGS_KEY) || '{}') || {}; } catch (_) { stored = {}; }
    return Object.freeze(Object.assign({}, DEFAULT_FLAGS, stored, { BPLUS_AUTO_PULL_DISABLED: true }));
  }

  function writeFlags(patch) {
    const next = Object.assign({}, readFlags(), patch || {}, { BPLUS_AUTO_PULL_DISABLED: true });
    global.localStorage?.setItem(FLAGS_KEY, JSON.stringify(next));
    return Object.freeze(next);
  }

  async function gateway(operationId, payload) {
    await global.ONEAPP_AUTH?.ready;
    if (!global.ONEAPP_AUTH?.gateway) throw new Error('NEXUS_AUTH_SESSION_REQUIRED');
    return global.ONEAPP_AUTH.gateway(operationId, payload || {});
  }

  async function registerDevice(displayName) {
    return gateway('foundation.device.register', {
      schemaVersion: SCHEMA_VERSION,
      deviceId: getDeviceId(),
      displayName: text(displayName) || text(global.navigator?.platform) || 'NEXUS 장치'
    });
  }

  async function deviceStatus() {
    return gateway('foundation.device.status_read', { schemaVersion: SCHEMA_VERSION, deviceId: getDeviceId() });
  }

  async function promoteDevice(expectedPrimaryEpoch, reason) {
    return gateway('foundation.device.promote', {
      schemaVersion: SCHEMA_VERSION,
      deviceId: getDeviceId(),
      expectedPrimaryEpoch: Number(expectedPrimaryEpoch || 0),
      reason: text(reason) || '관리자 승인 Primary 승격'
    });
  }

  async function readHead(domainType) {
    return gateway('foundation.backup.head_read', { schemaVersion: SCHEMA_VERSION, domainType: text(domainType).toUpperCase() });
  }

  function productMapWithIds(masterMap) {
    const entries = Object.entries(masterMap || {}).sort((left, right) => String(left[0]).localeCompare(String(right[0]), 'ko'));
    return Promise.all(entries.map(async ([key, source]) => {
      const item = Object.assign({}, source || {});
      const code = text(item['코드'] || item['품목코드'] || key);
      if (!code) throw new Error('BPLUS_PRODUCT_CODE_REQUIRED');
      item['코드'] = code;
      item['품목코드'] = text(item['품목코드'] || code);
      item.productId = text(item.productId) || `PROD-${(await sha256(`PRODUCT:${code}`)).slice(0, 32)}`;
      return [code, item];
    })).then(rows => Object.fromEntries(rows));
  }

  async function prepareProductCommit(masterMap, previousState, context) {
    const normalizedMap = await productMapWithIds(masterMap);
    const products = Object.values(normalizedMap).sort((left, right) => text(left.productId).localeCompare(text(right.productId)));
    const snapshot = { products };
    const contentHash = await sha256(snapshot);
    const previous = previousState && typeof previousState === 'object' ? previousState : {};
    const commitContext = context && typeof context === 'object' ? context : {};
    const localRevision = Math.max(0, Number(previous.localRevision || 0)) + 1;
    const duplicatePending = previous.pending && previous.pending.contentHash === contentHash;
    const pending = duplicatePending ? previous.pending : {
      backupId: uuid('BKP-PRODUCT'),
      domainType: 'PRODUCT',
      backupKind: 'PRODUCT_SNAPSHOT',
      baseServerRevision: Math.max(0, Number(commitContext.baseServerRevision ?? previous.baseServerRevision ?? 0)),
      localRevision,
      deviceId: getDeviceId(),
      primaryEpoch: Math.max(0, Number(previous.primaryEpoch || 0)),
      recordCount: products.length,
      contentHash,
      snapshot,
      ancestorBackupId: text(previous.pending?.ancestorBackupId || previous.pending?.backupId),
      status: 'PENDING',
      createdAt: new Date().toISOString(),
      attempts: 0
    };
    return {
      masterMap: normalizedMap,
      state: Object.assign({}, previous, {
        schemaVersion: SCHEMA_VERSION,
        domainType: 'PRODUCT',
        deviceId: getDeviceId(),
        localRevision,
        contentHash,
        recordCount: products.length,
        status: 'LOCAL_OK_BACKUP_PENDING',
        pending,
        safetySnapshots: commitContext.safetySnapshot
          ? [commitContext.safetySnapshot, ...(previous.safetySnapshots || [])].slice(0, 3)
          : (previous.safetySnapshots || []),
        restoreAudits: commitContext.restoreAudit
          ? [commitContext.restoreAudit, ...(previous.restoreAudits || [])].slice(0, 20)
          : (previous.restoreAudits || []),
        updatedAt: new Date().toISOString()
      })
    };
  }

  async function productState() {
    return global.ONEAPP?.STORAGE?.getIDB ? (await global.ONEAPP.STORAGE.getIDB(PRODUCT_STATE_KEY)) || null : null;
  }

  async function saveProductState(state) {
    if (!global.ONEAPP?.STORAGE?.setIDB) throw new Error('BPLUS_PRODUCT_STORAGE_UNAVAILABLE');
    await global.ONEAPP.STORAGE.setIDB(PRODUCT_STATE_KEY, state);
    return state;
  }

  async function mutateProductState(mutator) {
    if (!global.ONEAPP?.STORAGE?.withStorageLock) {
      const current = await productState();
      const next = await mutator(current);
      return next === undefined ? current : saveProductState(next);
    }
    try {
      return await global.ONEAPP.STORAGE.withStorageLock('merch-master-state', async () => {
        const current = await productState();
        const next = await mutator(current);
        return next === undefined ? current : saveProductState(next);
      });
    } catch (error) {
      if (error?.code === 'MERCH_LOCK_RELEASE_FAILED' && error.taskResult !== undefined) return error.taskResult;
      throw error;
    }
  }

  function responseState(result) {
    if (result?.status === 'DIVERGED') return 'DIVERGED';
    if (result?.status === 'REVISION_AHEAD_INVALID') return 'REVISION_AHEAD_INVALID';
    if (result?.status === 'ACKED') return 'LOCAL_OK_BACKUP_OK';
    return 'BACKUP_FAILED';
  }

  let productInFlight = null;
  async function backupProductOnce() {
    let state = await productState();
    if (!state?.pending) return { status: state?.status || 'LOCAL_OK_BACKUP_OK', skipped: true };
    if (!readFlags().BPLUS_BACKUP_ENABLED) return { status: 'LOCAL_OK_BACKUP_PENDING', skipped: true, disabled: true };
    let registration;
    let device;
    try {
      registration = await registerDevice();
      device = await deviceStatus();
    } catch (error) {
      await mutateProductState(current => current && Object.assign({}, current, {
        status: 'BACKUP_FAILED', lastError: text(error?.message), lastAttemptAt: new Date().toISOString()
      }));
      throw error;
    }
    state = await productState();
    if (!state?.pending) return { status: state?.status || 'LOCAL_OK_BACKUP_OK', skipped: true };
    const primary = device?.primary || {};
    if (!device?.isPrimary) {
      await mutateProductState(current => current && Object.assign({}, current, {
        status: 'NON_PRIMARY', primaryEpoch: Number(primary.primaryEpoch || 0),
        lastError: 'PRIMARY_DEVICE_REQUIRED', lastAttemptAt: new Date().toISOString()
      }));
      return { status: 'NON_PRIMARY', registration, device };
    }
    const pending = Object.assign({}, state.pending, { primaryEpoch: Number(primary.primaryEpoch), deviceId: getDeviceId() });
    const sentBackupId = pending.backupId;
    const sending = await mutateProductState(current => {
      if (!current?.pending || current.pending.backupId !== sentBackupId) return undefined;
      return Object.assign({}, current, {
        status: 'BACKUP_IN_PROGRESS', primaryEpoch: pending.primaryEpoch, pending,
        lastAttemptAt: new Date().toISOString()
      });
    });
    if (sending?.pending?.backupId !== sentBackupId) return { status: 'SUPERSEDED', skipped: true };
    try {
      const result = await gateway('foundation.backup.product_write', Object.assign({ schemaVersion: SCHEMA_VERSION }, pending));
      const status = responseState(result);
      const next = await mutateProductState(current => {
        if (!current) return current;
        const samePending = current.pending?.backupId === sentBackupId;
        const descendedPending = current.pending?.ancestorBackupId === sentBackupId;
        if (!samePending && !descendedPending) return current;
        if (result?.status === 'ACKED') {
          const serverRevision = Number(result.serverRevision);
          const nextPending = samePending ? null : Object.assign({}, current.pending, {
            baseServerRevision: serverRevision,
            ancestorBackupId: '',
            status: 'PENDING',
            lastError: ''
          });
          return Object.assign({}, current, {
            status: nextPending ? 'LOCAL_OK_BACKUP_PENDING' : status,
            baseServerRevision: serverRevision,
            pending: nextPending,
            lastAckAt: result.ackedAt || new Date().toISOString(),
            lastError: ''
          });
        }
        return Object.assign({}, current, {
          status,
          pending: Object.assign({}, current.pending || pending, { status, lastError: result?.code || '' }),
          lastError: result?.code || result?.status || 'BACKUP_FAILED'
        });
      });
      global.dispatchEvent?.(new CustomEvent('ONEAPP_FOUNDATION_BACKUP_STATE', { detail: next }));
      if (result?.status === 'ACKED' && next?.pending) scheduleProductBackup();
      return result;
    } catch (error) {
      const next = await mutateProductState(current => current && Object.assign({}, current, {
        status: 'BACKUP_FAILED',
        pending: current.pending ? Object.assign({}, current.pending, {
          status: 'RETRY', attempts: Number(current.pending.attempts || 0) + 1, lastError: text(error?.message)
        }) : current.pending,
        lastError: text(error?.message)
      }));
      global.dispatchEvent?.(new CustomEvent('ONEAPP_FOUNDATION_BACKUP_STATE', { detail: next }));
      scheduleProductBackup();
      throw error;
    }
  }

  async function backupProductNow() {
    if (productInFlight) return productInFlight;
    productInFlight = backupProductOnce();
    try { return await productInFlight; }
    finally { productInFlight = null; }
  }

  let productTimer = null;
  let productFirstPendingAt = 0;
  function scheduleProductBackup() {
    if (!readFlags().BPLUS_BACKUP_ENABLED) return;
    const now = Date.now();
    if (!productFirstPendingAt) productFirstPendingAt = now;
    if (productTimer) clearTimeout(productTimer);
    const delay = Math.max(0, Math.min(30000, 300000 - (now - productFirstPendingAt)));
    productTimer = setTimeout(async () => {
      productTimer = null;
      productFirstPendingAt = 0;
      try { await backupProductNow(); } catch (error) { console.warn('[FoundationBackup] product backup retained for retry', error); }
    }, delay);
  }

  let productWorkerStarted = false;
  function startProductWorker() {
    if (productWorkerStarted) return { stop: stopProductWorker };
    productWorkerStarted = true;
    global.addEventListener?.('ONEAPP_FOUNDATION_PRODUCT_COMMITTED', scheduleProductBackup);
    productState().then(async state => {
      if (!state && global.ONEAPP?.STORAGE?.readMasterSnapshotState && global.ONEAPP?.STORAGE?.commitMasterStateOrThrow) {
        const current = await global.ONEAPP.STORAGE.readMasterSnapshotState();
        if ((current.items || []).length) {
          try {
            await global.ONEAPP.STORAGE.commitMasterStateOrThrow(current.masterMap, { expectedRevision: current.revision });
          } catch (error) {
            if (error?.code !== 'MERCH_MASTER_REVISION_CONFLICT') throw error;
          }
          state = await productState();
        }
      }
      if (state?.pending) scheduleProductBackup();
    }).catch(error => console.warn('[FoundationBackup] product state read failed', error));
    return { stop: stopProductWorker };
  }

  function stopProductWorker() {
    global.removeEventListener?.('ONEAPP_FOUNDATION_PRODUCT_COMMITTED', scheduleProductBackup);
    if (productTimer) clearTimeout(productTimer);
    productTimer = null;
    productFirstPendingAt = 0;
    productWorkerStarted = false;
  }

  async function listVersions(domainType, limit) {
    return gateway('foundation.backup.version_list', { schemaVersion: SCHEMA_VERSION, domainType: text(domainType).toUpperCase(), limit: Number(limit || 20) });
  }

  async function readVersion(domainType, serverRevision) {
    const result = await gateway('foundation.backup.version_read', { schemaVersion: SCHEMA_VERSION, domainType: text(domainType).toUpperCase(), serverRevision: Number(serverRevision) });
    const actual = await sha256(result.payload);
    if (actual !== result.contentHash) throw new Error('BACKUP_HASH_MISMATCH');
    return result;
  }

  function compareSnapshots(localRows, serverRows, idKey) {
    const local = new Map((localRows || []).map(row => [text(row?.[idKey]), row]));
    const server = new Map((serverRows || []).map(row => [text(row?.[idKey]), row]));
    let added = 0, changed = 0, removed = 0;
    server.forEach((row, id) => {
      if (!local.has(id)) added += 1;
      else if (canonical(local.get(id)) !== canonical(row)) changed += 1;
    });
    local.forEach((_row, id) => { if (!server.has(id)) removed += 1; });
    return { localCount: local.size, serverCount: server.size, added, changed, removed, destructive: server.size === 0 || (local.size > 0 && server.size < local.size * 0.8) };
  }

  async function writeRestoreAudit(input) {
    return gateway('foundation.backup.restore_audit_write', Object.assign({ schemaVersion: SCHEMA_VERSION }, input));
  }

  async function flushProductRestoreAudits() {
    const state = await productState();
    const pending = (state?.restoreAudits || []).filter(row => row?.status !== 'ACKED');
    for (const audit of pending) {
      try {
        await writeRestoreAudit(audit);
        await mutateProductState(current => current && Object.assign({}, current, {
          restoreAudits: (current.restoreAudits || []).map(row => row.restoreId === audit.restoreId
            ? Object.assign({}, row, { status: 'ACKED', ackedAt: new Date().toISOString(), lastError: '' })
            : row)
        }));
      } catch (error) {
        await mutateProductState(current => current && Object.assign({}, current, {
          restoreAudits: (current.restoreAudits || []).map(row => row.restoreId === audit.restoreId
            ? Object.assign({}, row, { status: 'PENDING', lastError: text(error?.message), attempts: Number(row.attempts || 0) + 1 })
            : row)
        }));
        break;
      }
    }
    return productState();
  }

  Object.assign(API, {
    SCHEMA_VERSION, PRODUCT_STATE_KEY, DEFAULT_FLAGS,
    canonical, sha256, uuid, getDeviceId, readFlags, writeFlags,
    gateway, registerDevice, deviceStatus, promoteDevice, readHead,
    prepareProductCommit, productState, saveProductState, mutateProductState, backupProductNow, startProductWorker,
    listVersions, readVersion, compareSnapshots, writeRestoreAudit, flushProductRestoreAudits
  });

  function autoStartProductWorker() {
    if (global.ONEAPP?.STORAGE?.commitMasterStateOrThrow) {
      startProductWorker();
      flushProductRestoreAudits().catch(error => console.warn('[FoundationBackup] restore audit retained for retry', error));
    }
  }
  if (global.document?.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', autoStartProductWorker, { once: true });
  } else {
    Promise.resolve().then(autoStartProductWorker);
  }
})(globalThis);
