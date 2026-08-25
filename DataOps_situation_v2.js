(function (global) {
  'use strict';

  const SCHEMA_VERSION = 'DATAOPS_SITUATION_READ_V2';
  const CAPABILITY_VERSION = 'DATAOPS_SITUATION_V2';
  const EXPECTED_DEPLOYMENT = Object.freeze({ deploymentId: '', deploymentVersion: '', gitCommit: '' });
  const REQUIRED_CAPABILITY = Object.freeze({ schemaVersion: SCHEMA_VERSION, capabilityVersion: CAPABILITY_VERSION,
    readSessionTtlSeconds: 120, canonicalHash: 'SHA-256', publishMode: 'ATOMIC_POINTER_LAST' });
  const ROW_KEYS = Object.freeze(['snapshotId', 'rowId', 'rowRevision', 'productId', 'productMasterRevision', 'warehouseId',
    'warehouseMasterRevision', 'baseUnit', 'baseUnitRuleVersion', 'signedBaseQuantity', 'includedOrderQLedgerSequence', 'sourceRowDigest', 'status']);
  const MANIFEST_KEYS = Object.freeze(['schemaVersion', 'snapshotId', 'snapshotRevision', 'basisDate', 'publishedAt',
    'producerDeploymentId', 'producerDeploymentVersion', 'producerGitCommit', 'producerHandshakeDigest', 'rowCount',
    'activeRowCount', 'tombstoneCount', 'inventoryKeys', 'rowDigest', 'tombstoneDigest', 'pageManifestDigest', 'sourceDigest', 'status']);
  const PAGE_SIZE = 200;
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
    if (typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => { result[key] = canonical(value[key]); return result; }, {});
    throw new Error('DATAOPS_V2_ROW_INVALID');
  };
  const canonicalJson = value => JSON.stringify(canonical(value));
  const sha256Hex = async value => {
    if (!global.crypto?.subtle || typeof global.TextEncoder === 'undefined') throw new Error('DATAOPS_V2_CRYPTO_UNAVAILABLE');
    const bytes = new global.TextEncoder().encode(typeof value === 'string' ? value : canonicalJson(value));
    const digest = await global.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  const integer = (value, minimum = 0) => Number.isInteger(value) && value >= minimum;
  const digest = value => /^[a-f0-9]{64}$/.test(text(value));

  function validateSnapshotSchema(snapshot) {
    if (!exactKeys(snapshot, ['manifest', 'rows']) || !exactKeys(snapshot.manifest, MANIFEST_KEYS) || !Array.isArray(snapshot.rows)) throw new Error('DATAOPS_V2_SCHEMA_INVALID');
    const manifest = snapshot.manifest;
    if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.status !== 'PUBLISHED' || !text(manifest.snapshotId)
      || !integer(manifest.snapshotRevision, 1) || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.basisDate)
      || Number.isNaN(new Date(manifest.publishedAt).getTime()) || !text(manifest.producerDeploymentId)
      || !text(manifest.producerDeploymentVersion) || text(manifest.producerGitCommit).length < 7
      || !digest(manifest.producerHandshakeDigest) || !integer(manifest.rowCount) || !integer(manifest.activeRowCount)
      || !integer(manifest.tombstoneCount) || !Array.isArray(manifest.inventoryKeys)
      || new Set(manifest.inventoryKeys).size !== manifest.inventoryKeys.length
      || manifest.inventoryKeys.some(value => typeof value !== 'string' || value.length < 5)
      || ![manifest.rowDigest, manifest.tombstoneDigest, manifest.pageManifestDigest, manifest.sourceDigest].every(digest)) throw new Error('DATAOPS_V2_SCHEMA_INVALID');
    if (manifest.rowCount !== snapshot.rows.length || manifest.activeRowCount + manifest.tombstoneCount !== manifest.rowCount) throw new Error('DATAOPS_V2_SCHEMA_INVALID');
    snapshot.rows.forEach(row => {
      if (!exactKeys(row, ROW_KEYS) || row.snapshotId !== manifest.snapshotId || !text(row.rowId) || !integer(row.rowRevision, 1)
        || !text(row.productId) || !integer(row.productMasterRevision, 1) || !text(row.warehouseId)
        || !integer(row.warehouseMasterRevision, 1) || !text(row.baseUnit) || !text(row.baseUnitRuleVersion)
        || !Number.isFinite(row.signedBaseQuantity) || !integer(row.includedOrderQLedgerSequence)
        || !digest(row.sourceRowDigest) || !['ACTIVE', 'TOMBSTONED'].includes(row.status)) throw new Error('DATAOPS_V2_SCHEMA_INVALID');
    });
    return snapshot;
  }

  function evaluateCapability(ping = {}, expected = EXPECTED_DEPLOYMENT) {
    const mismatch = Object.entries(REQUIRED_CAPABILITY).find(([key, value]) => String(ping[key] ?? '') !== String(value));
    const evidenceReady = ['deploymentId', 'deploymentVersion', 'gitCommit'].every(key => text(expected[key]) && text(ping[key]) === text(expected[key]));
    const actionsReady = JSON.stringify(ping.actions || []) === JSON.stringify(['situation_dataops_begin', 'situation_dataops_page', 'situation_dataops_head']);
    return mismatch || !evidenceReady || !actionsReady ? { ready: false, code: 'DATAOPS_V2_CAPABILITY_REQUIRED', detail: mismatch?.[0] || (!actionsReady ? 'actions' : 'deploymentEvidence') }
      : { ready: true, code: '', deploymentId: text(ping.deploymentId), deploymentVersion: text(ping.deploymentVersion), gitCommit: text(ping.gitCommit) };
  }

  function setRuntimeCredential(value = {}) {
    const token = text(value.token); const actorId = text(value.actorId); const scope = canonical(value.scope || {});
    if (!token || !actorId || !text(scope.companyId)) throw new Error('DATAOPS_SITUATION_ACCESS_DENIED');
    runtimeCredential = Object.freeze({ token, actorId, deviceId: text(value.deviceId), environment: text(value.environment), scope });
    return true;
  }
  function clearRuntimeCredential() { runtimeCredential = null; }
  function hasRuntimeCredential() { return Boolean(runtimeCredential?.token && runtimeCredential?.actorId && text(runtimeCredential?.scope?.companyId)); }
  async function post(url, action, body = {}) {
    if (!hasRuntimeCredential()) throw new Error('DATAOPS_SITUATION_ACCESS_DENIED');
    const response = await global.fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, ...body, scope: runtimeCredential.scope, token: runtimeCredential.token, actorId: runtimeCredential.actorId,
        deviceId: runtimeCredential.deviceId, environment: runtimeCredential.environment }) });
    const json = await response.json();
    if (!response.ok || json?.status !== 'success') throw new Error(text(json?.message) || `DATAOPS_SITUATION_HTTP_${response.status}`);
    return json.data;
  }
  async function loadCapability(url) {
    try { return evaluateCapability(await post(url, 'situation_dataops_ping')); }
    catch (error) { return { ready: false, code: 'DATAOPS_V2_CAPABILITY_REQUIRED', detail: text(error?.message || error) }; }
  }
  async function begin(url) { return post(url, 'situation_dataops_begin'); }
  async function page(url, request) { return post(url, 'situation_dataops_page', request || {}); }
  async function head(url, request) { return post(url, 'situation_dataops_head', request || {}); }

  async function buildSnapshot(source = {}) {
    if (!Array.isArray(source.rows) || !source.rows.length || !source.authorityHead || !source.producer) throw new Error('DATAOPS_V2_SNAPSHOT_REQUIRED');
    const basisDate = text(source.basisDate || source.businessDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(basisDate)) throw new Error('DATAOPS_V2_SNAPSHOT_REQUIRED');
    const snapshotId = text(source.snapshotId); const snapshotRevision = Number(source.snapshotRevision);
    if (!snapshotId || !integer(snapshotRevision, 1)) throw new Error('DATAOPS_V2_SNAPSHOT_REQUIRED');
    const evidenceRows = []; const rows = [];
    for (const sourceRow of source.rows) {
      const input = canonical(sourceRow); const status = text(input.status || 'ACTIVE').toUpperCase();
      const rowId = text(input.rowId || `${input.productId}\u001f${input.warehouseId}\u001f${input.baseUnit}`);
      const evidence = { rowId, sourceEvidence: Array.isArray(input.sourceEvidence) ? [...input.sourceEvidence].sort((a, b) => text(a?.movementId).localeCompare(text(b?.movementId))) : [] };
      const digestSource = { rowRevision: input.rowRevision, productId: input.productId, productMasterRevision: input.productMasterRevision,
        warehouseId: input.warehouseId, warehouseMasterRevision: input.warehouseMasterRevision, baseUnit: input.baseUnit,
        baseUnitRuleVersion: input.baseUnitRuleVersion, signedBaseQuantity: input.signedBaseQuantity,
        includedOrderQLedgerSequence: input.includedOrderQLedgerSequence, status, sourceEvidence: evidence.sourceEvidence };
      rows.push(canonical({ snapshotId, rowId, rowRevision: input.rowRevision, productId: input.productId,
        productMasterRevision: input.productMasterRevision, warehouseId: input.warehouseId,
        warehouseMasterRevision: input.warehouseMasterRevision, baseUnit: input.baseUnit,
        baseUnitRuleVersion: input.baseUnitRuleVersion, signedBaseQuantity: input.signedBaseQuantity,
        includedOrderQLedgerSequence: input.includedOrderQLedgerSequence, sourceRowDigest: await sha256Hex(digestSource), status }));
      evidenceRows.push(evidence);
    }
    rows.sort((a, b) => a.rowId.localeCompare(b.rowId)); evidenceRows.sort((a, b) => a.rowId.localeCompare(b.rowId));
    const active = rows.filter(row => row.status === 'ACTIVE'); const tombstones = rows.filter(row => row.status === 'TOMBSTONED');
    const pages = [];
    for (let index = 0; index < rows.length; index += PAGE_SIZE) pages.push({ pageIndex: pages.length, rowCount: rows.slice(index, index + PAGE_SIZE).length,
      pageDigest: await sha256Hex(rows.slice(index, index + PAGE_SIZE)) });
    const inventoryKeys = [...new Set(rows.map(row => `${row.productId}\u001f${row.warehouseId}\u001f${row.baseUnit}`))].sort();
    const producer = source.producer;
    const sourceDigest = await sha256Hex({ authorityHead: source.authorityHead, evidenceRows, scope: source.scope || {} });
    const manifest = canonical({ schemaVersion: SCHEMA_VERSION, snapshotId, snapshotRevision, basisDate,
      publishedAt: text(source.publishedAt), producerDeploymentId: producer.deploymentId,
      producerDeploymentVersion: producer.deploymentVersion, producerGitCommit: producer.gitCommit,
      producerHandshakeDigest: producer.handshakeDigest, rowCount: rows.length, activeRowCount: active.length,
      tombstoneCount: tombstones.length, inventoryKeys, rowDigest: await sha256Hex(rows),
      tombstoneDigest: await sha256Hex(tombstones), pageManifestDigest: await sha256Hex(pages), sourceDigest, status: 'PUBLISHED' });
    const snapshot = validateSnapshotSchema({ manifest, rows });
    return { snapshot, producerEvidence: canonical({ authorityHead: source.authorityHead, rows: evidenceRows, pages, scope: source.scope || {} }) };
  }

  function buildOperationalSource({ operationalRows = [], officialState = {}, basisDate = '', snapshotId = '', snapshotRevision = 0,
    publishedAt = '', producer = {}, scope = {} } = {}) {
    if (!Array.isArray(operationalRows) || !Array.isArray(officialState.movements) || !officialState.authorityHead) throw new Error('DATAOPS_V2_OPERATIONAL_SOURCE_REQUIRED');
    const movementByKey = new Map();
    officialState.movements.forEach(movement => {
      const key = `${text(movement.productId)}\u001f${text(movement.warehouseId)}\u001f${text(movement.baseUnit)}`;
      if (!movementByKey.has(key)) movementByKey.set(key, []);
      movementByKey.get(key).push({ sourceEvidenceId: movement.sourceEvidenceId, movementId: movement.movementId,
        effectKey: movement.effectKey, movementRevision: movement.movementRevision });
    });
    return { rows: operationalRows.map(row => { const key = `${text(row.productId)}\u001f${text(row.warehouseId)}\u001f${text(row.baseUnit)}`;
      return { ...row, rowId: text(row.rowId || key), sourceEvidence: movementByKey.get(key) || [] }; }),
      authorityHead: officialState.authorityHead, basisDate, snapshotId, snapshotRevision, publishedAt, producer, scope };
  }
  async function publish(url, source) {
    if (!hasRuntimeCredential() || canonicalJson(source.scope || {}) !== canonicalJson(runtimeCredential.scope)) throw new Error('DATAOPS_SITUATION_SCOPE_NOT_ALLOWED');
    const gate = await loadCapability(url); if (!gate.ready) throw new Error('DATAOPS_V2_CAPABILITY_REQUIRED');
    const envelope = await buildSnapshot(source);
    return post(url, 'situation_dataops_publish', { ...envelope, scope: source.scope || {} });
  }
  async function publishOperationalState(url, input) { return publish(url, buildOperationalSource(input)); }
  async function rollback(url, { expectedCurrentRevision, reason } = {}) {
    const gate = await loadCapability(url); if (!gate.ready) throw new Error('DATAOPS_V2_CAPABILITY_REQUIRED');
    if (!Number.isInteger(Number(expectedCurrentRevision)) || Number(expectedCurrentRevision) < 1 || !text(reason)) throw new Error('DATAOPS_V2_ROLLBACK_PRECONDITION_FAILED');
    return post(url, 'situation_dataops_publish', { rollbackRequest: { expectedCurrentRevision: Number(expectedCurrentRevision), reason: text(reason) } });
  }
  function createOperatorConnection({ url = '', credential = {}, loadOperationalState } = {}) {
    if (!text(url) || typeof loadOperationalState !== 'function') throw new Error('DATAOPS_V2_OPERATOR_CONNECTION_REQUIRED');
    setRuntimeCredential(credential);
    return Object.freeze({
      publish: async context => publishOperationalState(url, await loadOperationalState(context || {})),
      rollback: request => rollback(url, request),
      capability: () => loadCapability(url)
    });
  }

  global.DATAOPS_SITUATION_V2_MODULE = Object.freeze({ SCHEMA_VERSION, CAPABILITY_VERSION, EXPECTED_DEPLOYMENT, REQUIRED_CAPABILITY,
    canonical, canonicalJson, sha256Hex, validateSnapshotSchema, evaluateCapability, setRuntimeCredential, clearRuntimeCredential,
    hasRuntimeCredential, loadCapability, begin, page, head, buildSnapshot, buildOperationalSource, publish, publishOperationalState,
    rollback, createOperatorConnection });
})(typeof window !== 'undefined' ? window : globalThis);
