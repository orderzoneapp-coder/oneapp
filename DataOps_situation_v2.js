(function (global) {
  'use strict';

  const SCHEMA_VERSION = 'DATAOPS_SITUATION_READ_V2';
  const CAPABILITY_VERSION = 'DATAOPS_SITUATION_V2';
  const EXPECTED_DEPLOYMENT = Object.freeze({ deploymentId: '', deploymentVersion: '', gitCommit: '' });
  const REQUIRED_CAPABILITY = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    capabilityVersion: CAPABILITY_VERSION,
    readSessionTtlSeconds: 120,
    canonicalHash: 'SHA-256',
    publishMode: 'ATOMIC_POINTER_LAST'
  });
  let runtimeCredential = null;

  const text = value => String(value ?? '').trim();
  const canonical = value => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.normalize('NFC').replace(/\r\n?/g, '\n');
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('DATAOPS_V2_ROW_INVALID');
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === 'object') {
      return Object.keys(value).sort().reduce((result, key) => { result[key] = canonical(value[key]); return result; }, {});
    }
    throw new Error('DATAOPS_V2_ROW_INVALID');
  };
  const canonicalJson = value => JSON.stringify(canonical(value));
  const sha256Hex = async value => {
    if (!global.crypto?.subtle || typeof global.TextEncoder === 'undefined') throw new Error('DATAOPS_V2_CRYPTO_UNAVAILABLE');
    const bytes = new global.TextEncoder().encode(typeof value === 'string' ? value : canonicalJson(value));
    const digest = await global.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  };

  function evaluateCapability(ping = {}, expected = EXPECTED_DEPLOYMENT) {
    const mismatch = Object.entries(REQUIRED_CAPABILITY).find(([key, value]) => String(ping[key] ?? '') !== String(value));
    const evidenceReady = ['deploymentId', 'deploymentVersion', 'gitCommit'].every(key => text(expected[key]) && text(ping[key]) === text(expected[key]));
    const actionsReady = JSON.stringify(ping.actions || []) === JSON.stringify(['situation_dataops_begin', 'situation_dataops_page', 'situation_dataops_head']);
    return mismatch || !evidenceReady || !actionsReady
      ? { ready: false, code: 'DATAOPS_V2_CAPABILITY_REQUIRED', detail: mismatch?.[0] || (!actionsReady ? 'actions' : 'deploymentEvidence') }
      : { ready: true, code: '', deploymentId: text(ping.deploymentId), deploymentVersion: text(ping.deploymentVersion), gitCommit: text(ping.gitCommit) };
  }

  function setRuntimeCredential(value = {}) {
    const token = text(value.token);
    const actorId = text(value.actorId);
    if (!token || !actorId) throw new Error('DATAOPS_SITUATION_ACCESS_DENIED');
    runtimeCredential = Object.freeze({ token, actorId });
    return true;
  }
  function clearRuntimeCredential() { runtimeCredential = null; }
  function hasRuntimeCredential() { return Boolean(runtimeCredential?.token && runtimeCredential?.actorId); }

  async function post(url, action, body = {}) {
    if (!hasRuntimeCredential()) throw new Error('DATAOPS_SITUATION_ACCESS_DENIED');
    const response = await global.fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...body, token: runtimeCredential.token, actorId: runtimeCredential.actorId })
    });
    const json = await response.json();
    if (!response.ok || json?.status !== 'success') throw new Error(text(json?.message) || `DATAOPS_SITUATION_HTTP_${response.status}`);
    return json.data;
  }

  async function loadCapability(url) {
    try { return evaluateCapability(await post(url, 'situation_dataops_ping')); }
    catch (error) { return { ready: false, code: 'DATAOPS_V2_CAPABILITY_REQUIRED', detail: text(error?.message || error) }; }
  }

  async function buildSnapshot(source = {}) {
    if (!Array.isArray(source.rows) || !source.rows.length || !source.authorityHead) throw new Error('DATAOPS_V2_SNAPSHOT_REQUIRED');
    const rows = [];
    for (const row of source.rows) {
      const next = canonical({
        rowRevision: row.rowRevision,
        productId: row.productId,
        productMasterRevision: row.productMasterRevision,
        warehouseId: row.warehouseId,
        warehouseMasterRevision: row.warehouseMasterRevision,
        baseUnit: row.baseUnit,
        baseUnitRuleVersion: row.baseUnitRuleVersion,
        signedBaseQuantity: row.signedBaseQuantity,
        includedOrderQLedgerSequence: row.includedOrderQLedgerSequence,
        businessDate: row.businessDate || source.businessDate,
        sourceEvidence: Array.isArray(row.sourceEvidence)
          ? [...row.sourceEvidence].sort((left, right) => text(left?.movementId).localeCompare(text(right?.movementId)))
          : []
      });
      rows.push({ ...next, rowDigest: await sha256Hex(next) });
    }
    return canonical({
      schemaVersion: SCHEMA_VERSION,
      snapshotId: source.snapshotId || '',
      businessDate: source.businessDate,
      authorityHead: source.authorityHead,
      rows,
      tombstones: source.tombstones || []
    });
  }

  async function publish(url, source) {
    const gate = await loadCapability(url);
    if (!gate.ready) throw new Error('DATAOPS_V2_CAPABILITY_REQUIRED');
    return post(url, 'situation_dataops_publish', { snapshot: await buildSnapshot(source), scope: source.scope || {} });
  }

  global.DATAOPS_SITUATION_V2_MODULE = Object.freeze({
    SCHEMA_VERSION, CAPABILITY_VERSION, EXPECTED_DEPLOYMENT, REQUIRED_CAPABILITY,
    canonical, canonicalJson, sha256Hex, evaluateCapability,
    setRuntimeCredential, clearRuntimeCredential, hasRuntimeCredential,
    loadCapability, buildSnapshot, publish
  });
})(typeof window !== 'undefined' ? window : globalThis);
