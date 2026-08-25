/**
 * DataOps Situation Read V2 authority.
 * This file is intentionally isolated from ONEAPP_DATAOPS_SNAPSHOT_V1.
 */
const DATAOPS_SITUATION_V2_SCHEMA = 'DATAOPS_SITUATION_READ_V2';
const DATAOPS_SITUATION_V2_CAPABILITY = 'DATAOPS_SITUATION_V2';
const DATAOPS_SITUATION_V2_TTL_SECONDS = 120;
const DATAOPS_SITUATION_V2_PAGE_SIZE = 200;
const DATAOPS_SITUATION_V2_MAX_ROWS = 100000;
const DATAOPS_SITUATION_V2_MAX_EVIDENCE = 500000;
const DATAOPS_SITUATION_V2_CHUNK_SIZE = 45000;
const DATAOPS_SITUATION_V2_MAX_ROW_BYTES = 65536;
const DATAOPS_SITUATION_V2_MAX_PAGE_BYTES = 524288;
const DATAOPS_SITUATION_V2_MAX_SNAPSHOT_BYTES = 16777216;
const DATAOPS_SITUATION_V2_ROLE_READ = 'DATAOPS_SITUATION_READ';
const DATAOPS_SITUATION_V2_ROLE_PUBLISH = 'DATAOPS_SITUATION_PUBLISH';
const DATAOPS_SITUATION_V2_ROW_KEYS = Object.freeze(['snapshotId', 'rowId', 'rowRevision', 'productId', 'productMasterRevision', 'warehouseId',
  'warehouseMasterRevision', 'baseUnit', 'baseUnitRuleVersion', 'signedBaseQuantity', 'includedOrderQLedgerSequence', 'sourceRowDigest', 'status']);
const DATAOPS_SITUATION_V2_MANIFEST_KEYS = Object.freeze(['schemaVersion', 'snapshotId', 'snapshotRevision', 'basisDate', 'publishedAt',
  'producerDeploymentId', 'producerDeploymentVersion', 'producerGitCommit', 'producerHandshakeDigest', 'rowCount', 'activeRowCount',
  'tombstoneCount', 'inventoryKeys', 'rowDigest', 'tombstoneDigest', 'pageManifestDigest', 'sourceDigest', 'status']);
const DATAOPS_SITUATION_V2_PROPERTIES = Object.freeze({
  AUTH_BINDINGS: 'ONEAPP_DATAOPS_SITUATION_AUTH_BINDINGS_JSON',
  SIGNING_KEY: 'ONEAPP_DATAOPS_SITUATION_TOKEN_SIGNING_KEY',
  DEPLOYMENT_ID: 'ONEAPP_DATAOPS_SITUATION_DEPLOYMENT_ID',
  DEPLOYMENT_VERSION: 'ONEAPP_DATAOPS_SITUATION_DEPLOYMENT_VERSION',
  GIT_COMMIT: 'ONEAPP_DATAOPS_SITUATION_GIT_COMMIT',
  CURRENT_POINTER: 'ONEAPP_DATAOPS_SITUATION_CURRENT_POINTER'
});
const DATAOPS_SITUATION_V2_SHEETS = Object.freeze({
  A: 'DataOpsSituationV2_A',
  B: 'DataOpsSituationV2_B',
  TEMP: 'DataOpsSituationV2_Temp',
  SESSIONS: 'DataOpsSituationV2_Sessions',
  AUDIT: 'DataOpsSituationV2_Audit'
});

function dataOpsSituationText(value) { return String(value === undefined || value === null ? '' : value).trim(); }

function dataOpsSituationCanonical(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.normalize ? value.normalize('NFC').replace(/\r\n?/g, '\n') : value.replace(/\r\n?/g, '\n');
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('DATAOPS_V2_ROW_INVALID');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(dataOpsSituationCanonical);
  if (typeof value === 'object') {
    const result = {};
    Object.keys(value).sort().forEach(key => { result[key] = dataOpsSituationCanonical(value[key]); });
    return result;
  }
  throw new Error('DATAOPS_V2_ROW_INVALID');
}

function dataOpsSituationCanonicalJson(value) { return JSON.stringify(dataOpsSituationCanonical(value)); }
function dataOpsSituationDigest(value) { return sha256Hex(dataOpsSituationCanonicalJson(value)); }
function dataOpsSituationUtf8Bytes(value) { return Utilities.newBlob(String(value || '')).getBytes().length; }

function dataOpsSituationConstantTime(left, right) {
  const a = dataOpsSituationText(left);
  const b = dataOpsSituationText(right);
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

function dataOpsSituationDeployment(properties) {
  return {
    deploymentId: dataOpsSituationText(properties.getProperty(DATAOPS_SITUATION_V2_PROPERTIES.DEPLOYMENT_ID)),
    deploymentVersion: dataOpsSituationText(properties.getProperty(DATAOPS_SITUATION_V2_PROPERTIES.DEPLOYMENT_VERSION)),
    gitCommit: dataOpsSituationText(properties.getProperty(DATAOPS_SITUATION_V2_PROPERTIES.GIT_COMMIT)),
    capabilityVersion: DATAOPS_SITUATION_V2_CAPABILITY
  };
}

function dataOpsSituationRequireDeployment(properties) {
  const result = dataOpsSituationDeployment(properties);
  if (!result.deploymentId || !result.deploymentVersion || !result.gitCommit) throw new Error('DATAOPS_V2_CAPABILITY_REQUIRED');
  return result;
}

function dataOpsSituationRequireAuth(payload, requiredRole, properties) {
  const rawToken = dataOpsSituationText(payload && payload.token);
  const actorId = dataOpsSituationText(payload && payload.actorId);
  if (!rawToken || !actorId) throw new Error('DATAOPS_SITUATION_ACCESS_DENIED');
  let bindings;
  try { bindings = JSON.parse(String(properties.getProperty(DATAOPS_SITUATION_V2_PROPERTIES.AUTH_BINDINGS) || '[]')); }
  catch (error) { throw new Error('DATAOPS_SITUATION_AUTH_NOT_CONFIGURED'); }
  if (!Array.isArray(bindings) || !bindings.length) throw new Error('DATAOPS_SITUATION_AUTH_NOT_CONFIGURED');
  const suppliedDigest = sha256Hex(rawToken);
  const binding = bindings.find(row => row && dataOpsSituationConstantTime(row.tokenDigest, suppliedDigest));
  const roles = Array.isArray(binding && binding.roleIds) ? binding.roleIds.map(dataOpsSituationText) : [];
  if (!binding || dataOpsSituationText(binding.status || 'ACTIVE').toUpperCase() !== 'ACTIVE'
    || dataOpsSituationText(binding.actorId) !== actorId) throw new Error('DATAOPS_SITUATION_ACCESS_DENIED');
  if (roles.indexOf(requiredRole) < 0) throw new Error('DATAOPS_SITUATION_ROLE_REQUIRED');
  const allowedScope = dataOpsSituationCanonical(binding.allowedScope || binding.scope || { companyId: 'ONEAPP' });
  const requestedScope = dataOpsSituationCanonical(payload && payload.scope || {});
  const allowedCompany = dataOpsSituationText(allowedScope.companyId);
  const requestedCompany = dataOpsSituationText(requestedScope.companyId);
  if (!allowedCompany || !requestedCompany || allowedCompany !== requestedCompany) throw new Error('DATAOPS_SITUATION_SCOPE_NOT_ALLOWED');
  Object.keys(requestedScope).forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(allowedScope, key)
      || dataOpsSituationCanonicalJson(requestedScope[key]) !== dataOpsSituationCanonicalJson(allowedScope[key])) throw new Error('DATAOPS_SITUATION_SCOPE_NOT_ALLOWED');
  });
  return { actorId, roleIds: roles.slice().sort(), tokenDigest: suppliedDigest, allowedScope,
    scopeDigest: dataOpsSituationDigest(allowedScope), deviceId: dataOpsSituationText(payload && payload.deviceId),
    environment: dataOpsSituationText(payload && payload.environment) };
}

function dataOpsSituationScope(payload) {
  const scope = dataOpsSituationCanonical(payload && payload.scope || {});
  return { value: scope, digest: dataOpsSituationDigest(scope) };
}

function dataOpsSituationMasterDescriptor(row) {
  return {
    entityType: dataOpsSituationText(row.entityType).toUpperCase(),
    entityId: dataOpsSituationText(row.entityId),
    revision: Number(row.revision || row.payload && row.payload.revision || 0),
    status: dataOpsSituationText(row.status || row.payload && row.payload.status || 'ACTIVE').toUpperCase(),
    baseUnit: dataOpsSituationText(row.payload && (row.payload.baseUnit || row.payload.unit)),
    baseUnitRuleVersion: dataOpsSituationText(row.payload && (row.payload.baseUnitRuleVersion || row.payload.unitRuleVersion))
  };
}

function dataOpsSituationAuthorityHead(ss, referencedProductIds, referencedWarehouseIds) {
  const entities = orderQM9ReadAllEntities(ss);
  const cursor = orderQM9MetaNumber(ss, 'syncSequence');
  const ledgerSequence = orderQM9MetaNumber(ss, 'ledgerSequence');
  const products = entities.filter(row => row.entityType === 'PRODUCT' && referencedProductIds.has(dataOpsSituationText(row.entityId)));
  const warehouses = entities.filter(row => row.entityType === 'WAREHOUSE' && referencedWarehouseIds.has(dataOpsSituationText(row.entityId)));
  const masters = products.concat(warehouses).map(dataOpsSituationMasterDescriptor)
    .sort((left, right) => `${left.entityType}\u001f${left.entityId}`.localeCompare(`${right.entityType}\u001f${right.entityId}`));
  const changes = orderQM9ReadChanges(ss).rows.filter(row => Number(row.sequence || 0) <= cursor);
  const movementHead = entities.filter(row => row.entityType === 'INVENTORY_MOVEMENT' && Number(row.payload && row.payload.ledgerSequence || 0) <= ledgerSequence)
    .map(row => ({ movementId: dataOpsSituationText(row.entityId), revision: Number(row.revision || 0), payload: row.payload || {} }))
    .sort((left, right) => left.movementId.localeCompare(right.movementId));
  return {
    cursor,
    ledgerSequence,
    masterDigest: dataOpsSituationDigest(masters),
    changeDigest: orderQM9ChangeDigest(changes),
    movementDigest: dataOpsSituationDigest(movementHead),
    masters,
    entities
  };
}

function dataOpsSituationStrictNumber(value) {
  if (value === '' || value === null || value === undefined) throw new Error('DATAOPS_V2_ROW_INVALID');
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('DATAOPS_V2_ROW_INVALID');
  return Object.is(number, -0) ? 0 : number;
}

function dataOpsSituationExactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.slice().sort());
}

function dataOpsSituationNormalizeRow(row, index, manifest, evidenceByRow) {
  const result = {
    snapshotId: dataOpsSituationText(row && row.snapshotId),
    rowId: dataOpsSituationText(row && row.rowId),
    rowRevision: Number(row && row.rowRevision || 0),
    productId: dataOpsSituationText(row && row.productId),
    productMasterRevision: Number(row && row.productMasterRevision || 0),
    warehouseId: dataOpsSituationText(row && row.warehouseId),
    warehouseMasterRevision: Number(row && row.warehouseMasterRevision || 0),
    baseUnit: dataOpsSituationText(row && row.baseUnit),
    baseUnitRuleVersion: dataOpsSituationText(row && row.baseUnitRuleVersion),
    signedBaseQuantity: dataOpsSituationStrictNumber(row && row.signedBaseQuantity),
    includedOrderQLedgerSequence: Number(row && row.includedOrderQLedgerSequence),
    status: dataOpsSituationText(row && row.status).toUpperCase(),
    sourceRowDigest: dataOpsSituationText(row && row.sourceRowDigest),
    sourceEvidence: (Array.isArray(evidenceByRow.get(dataOpsSituationText(row && row.rowId))) ? evidenceByRow.get(dataOpsSituationText(row && row.rowId)) : []).map(item => ({
      sourceEvidenceId: dataOpsSituationText(item && item.sourceEvidenceId),
      movementId: dataOpsSituationText(item && item.movementId),
      effectKey: dataOpsSituationText(item && item.effectKey),
      movementRevision: Number(item && item.movementRevision || 0)
    })).sort((left, right) => left.movementId.localeCompare(right.movementId))
  };
  if (!dataOpsSituationExactKeys(row, DATAOPS_SITUATION_V2_ROW_KEYS) || result.snapshotId !== manifest.snapshotId || !result.rowId
    || !result.productId || !result.productMasterRevision || !result.warehouseId || !result.warehouseMasterRevision
    || !result.baseUnit || !result.baseUnitRuleVersion || !result.rowRevision || ['ACTIVE', 'TOMBSTONED'].indexOf(result.status) < 0
    || !Number.isInteger(result.includedOrderQLedgerSequence) || result.includedOrderQLedgerSequence < 0
    || result.sourceEvidence.some(item => !item.sourceEvidenceId || !item.movementId || !item.effectKey || !item.movementRevision)) {
    throw new Error(`DATAOPS_V2_ROW_INVALID:${index + 1}`);
  }
  const digestSource = { rowRevision: result.rowRevision, productId: result.productId, productMasterRevision: result.productMasterRevision,
    warehouseId: result.warehouseId, warehouseMasterRevision: result.warehouseMasterRevision, baseUnit: result.baseUnit,
    baseUnitRuleVersion: result.baseUnitRuleVersion, signedBaseQuantity: result.signedBaseQuantity,
    includedOrderQLedgerSequence: result.includedOrderQLedgerSequence, status: result.status, sourceEvidence: result.sourceEvidence };
  const sourceRowDigest = dataOpsSituationDigest(digestSource);
  if (!dataOpsSituationConstantTime(result.sourceRowDigest, sourceRowDigest)) throw new Error(`DATAOPS_V2_ROW_DIGEST_MISMATCH:${index + 1}`);
  return { ...result, inventoryKey: `${result.productId}\u001f${result.warehouseId}\u001f${result.baseUnit}` };
}

function dataOpsSituationValidateSnapshotSchema(snapshot) {
  if (!dataOpsSituationExactKeys(snapshot, ['manifest', 'rows']) || !dataOpsSituationExactKeys(snapshot.manifest, DATAOPS_SITUATION_V2_MANIFEST_KEYS)
    || !Array.isArray(snapshot.rows)) throw new Error('DATAOPS_V2_SCHEMA_INVALID');
  const manifest = snapshot.manifest;
  if (manifest.schemaVersion !== DATAOPS_SITUATION_V2_SCHEMA || manifest.status !== 'PUBLISHED' || !dataOpsSituationText(manifest.snapshotId)
    || !Number.isInteger(manifest.snapshotRevision) || manifest.snapshotRevision < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(manifest.basisDate)
    || Number.isNaN(new Date(manifest.publishedAt).getTime()) || !dataOpsSituationText(manifest.producerDeploymentId)
    || !dataOpsSituationText(manifest.producerDeploymentVersion) || dataOpsSituationText(manifest.producerGitCommit).length < 7
    || !/^[a-f0-9]{64}$/.test(manifest.producerHandshakeDigest) || !Array.isArray(manifest.inventoryKeys)
    || new Set(manifest.inventoryKeys).size !== manifest.inventoryKeys.length
    || manifest.inventoryKeys.some(value => typeof value !== 'string' || value.length < 5)
    || !Number.isInteger(manifest.rowCount) || !Number.isInteger(manifest.activeRowCount) || !Number.isInteger(manifest.tombstoneCount)
    || manifest.rowCount < 0 || manifest.activeRowCount < 0 || manifest.tombstoneCount < 0
    || manifest.rowCount !== snapshot.rows.length || manifest.activeRowCount + manifest.tombstoneCount !== manifest.rowCount
    || [manifest.rowDigest, manifest.tombstoneDigest, manifest.pageManifestDigest, manifest.sourceDigest].some(value => !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error('DATAOPS_V2_SCHEMA_INVALID');
  }
  snapshot.rows.forEach(row => {
    if (!dataOpsSituationExactKeys(row, DATAOPS_SITUATION_V2_ROW_KEYS) || row.snapshotId !== manifest.snapshotId
      || !dataOpsSituationText(row.rowId) || !Number.isInteger(row.rowRevision) || row.rowRevision < 1
      || !dataOpsSituationText(row.productId) || !Number.isInteger(row.productMasterRevision) || row.productMasterRevision < 1
      || !dataOpsSituationText(row.warehouseId) || !Number.isInteger(row.warehouseMasterRevision) || row.warehouseMasterRevision < 1
      || !dataOpsSituationText(row.baseUnit) || !dataOpsSituationText(row.baseUnitRuleVersion) || !Number.isFinite(row.signedBaseQuantity)
      || !Number.isInteger(row.includedOrderQLedgerSequence) || row.includedOrderQLedgerSequence < 0
      || !/^[a-f0-9]{64}$/.test(row.sourceRowDigest) || ['ACTIVE', 'TOMBSTONED'].indexOf(row.status) < 0) throw new Error('DATAOPS_V2_SCHEMA_INVALID');
  });
  return snapshot;
}

function dataOpsSituationValidateRows(ss, snapshot, producerEvidence, serverScope) {
  const rowsSource = Array.isArray(snapshot && snapshot.rows) ? snapshot.rows : null;
  if (!rowsSource || !rowsSource.length || rowsSource.length > DATAOPS_SITUATION_V2_MAX_ROWS) throw new Error('DATAOPS_V2_SNAPSHOT_REQUIRED');
  const evidenceRows = Array.isArray(producerEvidence && producerEvidence.rows) ? producerEvidence.rows : [];
  const evidenceByRow = new Map();
  evidenceRows.forEach(item => {
    const rowId = dataOpsSituationText(item && item.rowId);
    if (!rowId || evidenceByRow.has(rowId)) throw new Error('DATAOPS_V2_EVIDENCE_MISMATCH');
    evidenceByRow.set(rowId, Array.isArray(item.sourceEvidence) ? item.sourceEvidence : []);
  });
  if (evidenceByRow.size !== rowsSource.length) throw new Error('DATAOPS_V2_EVIDENCE_MISMATCH');
  const rows = rowsSource.map((row, index) => dataOpsSituationNormalizeRow(row, index, snapshot.manifest, evidenceByRow));
  rowsSource.forEach((row, index) => {
    if (dataOpsSituationUtf8Bytes(dataOpsSituationCanonicalJson(row)) > DATAOPS_SITUATION_V2_MAX_ROW_BYTES) throw new Error(`DATAOPS_V2_ROW_LIMIT:${index + 1}`);
  });
  if (dataOpsSituationUtf8Bytes(dataOpsSituationCanonicalJson(snapshot)) > DATAOPS_SITUATION_V2_MAX_SNAPSHOT_BYTES) throw new Error('DATAOPS_V2_SNAPSHOT_LIMIT');
  const inventoryKeys = new Set();
  let evidenceCount = 0;
  rows.forEach(row => {
    if (inventoryKeys.has(row.inventoryKey)) throw new Error(`DATAOPS_V2_ROW_INVALID:${row.inventoryKey}`);
    inventoryKeys.add(row.inventoryKey);
    evidenceCount += row.sourceEvidence.length;
  });
  if (evidenceCount > DATAOPS_SITUATION_V2_MAX_EVIDENCE) throw new Error('DATAOPS_V2_ROW_INVALID');
  const productIds = new Set(rows.map(row => row.productId));
  const warehouseIds = new Set(rows.map(row => row.warehouseId));
  const head = dataOpsSituationAuthorityHead(ss, productIds, warehouseIds);
  const expectedHead = producerEvidence && producerEvidence.authorityHead || {};
  if (Number(expectedHead.cursor) !== head.cursor || Number(expectedHead.ledgerSequence) !== head.ledgerSequence
    || !dataOpsSituationConstantTime(expectedHead.masterDigest, head.masterDigest)
    || !dataOpsSituationConstantTime(expectedHead.changeDigest, head.changeDigest)
    || !dataOpsSituationConstantTime(expectedHead.movementDigest, head.movementDigest)) throw new Error('DATAOPS_V2_AUTHORITY_HEAD_MISMATCH');
  const masters = new Map(head.masters.map(row => [`${row.entityType}\u001f${row.entityId}`, row]));
  const movements = head.entities.filter(row => row.entityType === 'INVENTORY_MOVEMENT').map(row => ({
    movementId: dataOpsSituationText(row.entityId),
    revision: Number(row.revision || row.payload && row.payload.revision || 0),
    productId: dataOpsSituationText(row.payload && row.payload.productId),
    warehouseId: dataOpsSituationText(row.payload && row.payload.warehouseId),
    baseUnit: dataOpsSituationText(row.payload && row.payload.baseUnit),
    signedBaseQuantity: Number(row.payload && row.payload.signedBaseQuantity),
    ledgerSequence: Number(row.payload && row.payload.ledgerSequence || 0),
    effectKey: dataOpsSituationText(row.payload && row.payload.effectKey)
  })).filter(row => row.movementId && Number.isFinite(row.signedBaseQuantity) && row.ledgerSequence > 0);
  const movementById = new Map(movements.map(row => [row.movementId, row]));
  const movementsByInventoryKey = new Map();
  movements.forEach(movement => {
    const key = `${movement.productId}\u001f${movement.warehouseId}\u001f${movement.baseUnit}`;
    if (!movementsByInventoryKey.has(key)) movementsByInventoryKey.set(key, []);
    movementsByInventoryKey.get(key).push(movement);
  });
  rows.forEach(row => {
    const product = masters.get(`PRODUCT\u001f${row.productId}`);
    const warehouse = masters.get(`WAREHOUSE\u001f${row.warehouseId}`);
    if (!product || !warehouse || product.status !== 'ACTIVE' || warehouse.status !== 'ACTIVE'
      || product.revision !== row.productMasterRevision || warehouse.revision !== row.warehouseMasterRevision
      || !product.baseUnit || product.baseUnit !== row.baseUnit
      || !product.baseUnitRuleVersion || product.baseUnitRuleVersion !== row.baseUnitRuleVersion) {
      throw new Error(`DATAOPS_V2_MASTER_REVISION_MISMATCH:${row.inventoryKey}`);
    }
    if (row.includedOrderQLedgerSequence > head.ledgerSequence) throw new Error(`SITUATION_DATAOPS_FUTURE_WATERMARK:${row.inventoryKey}`);
    const exactKey = `${row.productId}\u001f${row.warehouseId}\u001f${row.baseUnit}`;
    const unitlessKey = `${row.productId}\u001f${row.warehouseId}\u001f`;
    const authoritative = (movementsByInventoryKey.get(exactKey) || []).concat(movementsByInventoryKey.get(unitlessKey) || [])
      .filter(item => item.ledgerSequence <= row.includedOrderQLedgerSequence)
      .sort((left, right) => left.ledgerSequence - right.ledgerSequence || left.movementId.localeCompare(right.movementId));
    const suppliedIds = row.sourceEvidence.map(item => item.movementId);
    const authoritativeIds = authoritative.map(item => item.movementId).sort();
    if (JSON.stringify(suppliedIds) !== JSON.stringify(authoritativeIds)) throw new Error(`DATAOPS_V2_CUTOFF_REQUIRED:${row.inventoryKey}`);
    row.sourceEvidence.forEach(item => {
      const movement = movementById.get(item.movementId);
      const expectedEvidenceId = dataOpsSituationDigest({ movementId: item.movementId, effectKey: item.effectKey, movementRevision: item.movementRevision });
      if (!movement || movement.effectKey !== item.effectKey || movement.revision !== item.movementRevision
        || !dataOpsSituationConstantTime(item.sourceEvidenceId, expectedEvidenceId)) {
        throw new Error(`DATAOPS_V2_EVIDENCE_MISMATCH:${row.inventoryKey}`);
      }
    });
    const independentCutoff = authoritative.reduce((maximum, item) => Math.max(maximum, item.ledgerSequence), 0);
    if (row.includedOrderQLedgerSequence !== independentCutoff) throw new Error(`DATAOPS_V2_CUTOFF_REQUIRED:${row.inventoryKey}`);
  });
  const pages = [];
  for (let index = 0; index < rowsSource.length; index += DATAOPS_SITUATION_V2_PAGE_SIZE) {
    const pageRows = rowsSource.slice(index, index + DATAOPS_SITUATION_V2_PAGE_SIZE);
    if (dataOpsSituationUtf8Bytes(dataOpsSituationCanonicalJson(pageRows)) > DATAOPS_SITUATION_V2_MAX_PAGE_BYTES) throw new Error('DATAOPS_V2_PAGE_LIMIT');
    pages.push({ pageIndex: pages.length, rowCount: pageRows.length, pageDigest: dataOpsSituationDigest(pageRows) });
  }
  if (dataOpsSituationCanonicalJson(pages) !== dataOpsSituationCanonicalJson(producerEvidence.pages || [])) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  const active = rowsSource.filter(row => row.status === 'ACTIVE');
  const tombstones = rowsSource.filter(row => row.status === 'TOMBSTONED');
  const inventoryKeyList = Array.from(inventoryKeys).sort();
  const expectedManifest = snapshot.manifest;
  if (expectedManifest.rowCount !== rowsSource.length || expectedManifest.activeRowCount !== active.length
    || expectedManifest.tombstoneCount !== tombstones.length
    || dataOpsSituationCanonicalJson(expectedManifest.inventoryKeys) !== dataOpsSituationCanonicalJson(inventoryKeyList)
    || !dataOpsSituationConstantTime(expectedManifest.rowDigest, dataOpsSituationDigest(rowsSource))
    || !dataOpsSituationConstantTime(expectedManifest.tombstoneDigest, dataOpsSituationDigest(tombstones))
    || !dataOpsSituationConstantTime(expectedManifest.pageManifestDigest, dataOpsSituationDigest(pages))
    || !dataOpsSituationConstantTime(expectedManifest.sourceDigest, dataOpsSituationDigest({ authorityHead: expectedHead, evidenceRows,
      scope: serverScope }))) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  return { rows, head, pages };
}

function dataOpsSituationBuildSnapshot(ss, payload, properties) {
  const source = dataOpsSituationValidateSnapshotSchema(payload && payload.snapshot);
  const deployment = dataOpsSituationRequireDeployment(properties || PropertiesService.getScriptProperties());
  const expectedHandshake = dataOpsSituationDigest({ schemaVersion: DATAOPS_SITUATION_V2_SCHEMA,
    capabilityVersion: DATAOPS_SITUATION_V2_CAPABILITY, deploymentId: deployment.deploymentId,
    deploymentVersion: deployment.deploymentVersion, gitCommit: deployment.gitCommit });
  if (source.manifest.producerDeploymentId !== deployment.deploymentId
    || source.manifest.producerDeploymentVersion !== deployment.deploymentVersion
    || source.manifest.producerGitCommit !== deployment.gitCommit
    || !dataOpsSituationConstantTime(source.manifest.producerHandshakeDigest, expectedHandshake)) throw new Error('DATAOPS_V2_PRODUCER_HANDSHAKE_MISMATCH');
  const serverScope = dataOpsSituationCanonical(payload && payload._serverScope || {});
  dataOpsSituationValidateRows(ss, source, payload && payload.producerEvidence, serverScope);
  return dataOpsSituationCanonical(source);
}

function dataOpsSituationPrepareOperationalSource(ss, request, auth, properties) {
  const basisDate = dataOpsSituationText(request && request.basisDate);
  const operationId = dataOpsSituationText(request && request.operationId);
  const occurredAt = dataOpsSituationText(request && request.occurredAt);
  const inputRows = Array.isArray(request && request.rows) ? request.rows : null;
  if (!inputRows || !inputRows.length || inputRows.length > DATAOPS_SITUATION_V2_MAX_ROWS
    || !/^\d{4}-\d{2}-\d{2}$/.test(basisDate) || !operationId || Number.isNaN(new Date(occurredAt).getTime())) {
    throw new Error('DATAOPS_V2_OPERATIONAL_SOURCE_REQUIRED');
  }
  const grouped = new Map();
  inputRows.forEach((row, index) => {
    if (!dataOpsSituationExactKeys(row, ['productCode', 'warehouseCode', 'signedBaseQuantity', 'status'])) {
      throw new Error(`DATAOPS_V2_OPERATIONAL_ROW_INVALID:${index + 1}`);
    }
    const productCode = dataOpsSituationText(row.productCode);
    const warehouseCode = dataOpsSituationText(row.warehouseCode);
    const quantity = dataOpsSituationStrictNumber(row.signedBaseQuantity);
    const status = dataOpsSituationText(row.status || 'ACTIVE').toUpperCase();
    if (!productCode || !warehouseCode || ['ACTIVE', 'TOMBSTONED'].indexOf(status) < 0) throw new Error(`DATAOPS_V2_OPERATIONAL_ROW_INVALID:${index + 1}`);
    const key = `${productCode}\u001f${warehouseCode}`;
    const current = grouped.get(key) || { productCode, warehouseCode, signedBaseQuantity: 0, status };
    if (current.status !== status) throw new Error(`DATAOPS_V2_OPERATIONAL_ROW_STATUS_CONFLICT:${key}`);
    current.signedBaseQuantity += quantity;
    grouped.set(key, current);
  });
  const entities = orderQM9ReadAllEntities(ss);
  const exactMaster = (entityType, code) => {
    const matches = entities.filter(row => row.entityType === entityType && dataOpsSituationText(row.status || row.payload && row.payload.status || 'ACTIVE').toUpperCase() === 'ACTIVE'
      && [row.entityId, row.payload && row.payload.entityCode, row.payload && row.payload.productCode,
        row.payload && row.payload.warehouseCode, row.payload && row.payload.code].some(value => dataOpsSituationText(value) === code));
    if (matches.length !== 1) throw new Error(`DATAOPS_V2_OPERATIONAL_MASTER_REQUIRED:${entityType}:${code}`);
    return matches[0];
  };
  const resolved = Array.from(grouped.values()).map(row => {
    const product = exactMaster('PRODUCT', row.productCode);
    const warehouse = exactMaster('WAREHOUSE', row.warehouseCode);
    const descriptor = dataOpsSituationMasterDescriptor(product);
    if (!descriptor.revision || !descriptor.baseUnit || !descriptor.baseUnitRuleVersion
      || !Number(product.revision || product.payload && product.payload.revision || 0)
      || !Number(warehouse.revision || warehouse.payload && warehouse.payload.revision || 0)) {
      throw new Error(`DATAOPS_V2_OPERATIONAL_MASTER_REQUIRED:${row.productCode}:${row.warehouseCode}`);
    }
    return { ...row, productId: dataOpsSituationText(product.entityId), productMasterRevision: descriptor.revision,
      warehouseId: dataOpsSituationText(warehouse.entityId), warehouseMasterRevision: Number(warehouse.revision || warehouse.payload.revision),
      baseUnit: descriptor.baseUnit, baseUnitRuleVersion: descriptor.baseUnitRuleVersion };
  });
  const productIds = new Set(resolved.map(row => row.productId));
  const warehouseIds = new Set(resolved.map(row => row.warehouseId));
  const head = dataOpsSituationAuthorityHead(ss, productIds, warehouseIds);
  const movements = head.entities.filter(row => row.entityType === 'INVENTORY_MOVEMENT').map(row => ({
    movementId: dataOpsSituationText(row.entityId), movementRevision: Number(row.revision || row.payload && row.payload.revision || 0),
    productId: dataOpsSituationText(row.payload && row.payload.productId), warehouseId: dataOpsSituationText(row.payload && row.payload.warehouseId),
    baseUnit: dataOpsSituationText(row.payload && row.payload.baseUnit), ledgerSequence: Number(row.payload && row.payload.ledgerSequence || 0),
    effectKey: dataOpsSituationText(row.payload && row.payload.effectKey)
  })).filter(row => row.movementId && row.movementRevision && row.ledgerSequence > 0 && row.effectKey);
  const pointer = dataOpsSituationPointer(properties);
  const snapshotRevision = pointer ? Number(pointer.snapshotRevision) + 1 : 1;
  const snapshotId = `DATAOPS-V2-${operationId}`;
  const sourceRows = resolved.map(row => {
    const sourceEvidence = movements.filter(item => item.productId === row.productId && item.warehouseId === row.warehouseId
      && (!item.baseUnit || item.baseUnit === row.baseUnit)).sort((left, right) => left.ledgerSequence - right.ledgerSequence || left.movementId.localeCompare(right.movementId))
      .map(item => ({ sourceEvidenceId: dataOpsSituationDigest({ movementId: item.movementId, effectKey: item.effectKey,
        movementRevision: item.movementRevision }), movementId: item.movementId, effectKey: item.effectKey, movementRevision: item.movementRevision }));
    const cutoff = movements.filter(item => item.productId === row.productId && item.warehouseId === row.warehouseId
      && (!item.baseUnit || item.baseUnit === row.baseUnit)).reduce((maximum, item) => Math.max(maximum, item.ledgerSequence), 0);
    return { rowRevision: snapshotRevision, productId: row.productId, productMasterRevision: row.productMasterRevision,
      warehouseId: row.warehouseId, warehouseMasterRevision: row.warehouseMasterRevision, baseUnit: row.baseUnit,
      baseUnitRuleVersion: row.baseUnitRuleVersion, signedBaseQuantity: row.signedBaseQuantity,
      includedOrderQLedgerSequence: cutoff, status: row.status, sourceEvidence };
  });
  const deployment = dataOpsSituationRequireDeployment(properties);
  const producer = { deploymentId: deployment.deploymentId, deploymentVersion: deployment.deploymentVersion, gitCommit: deployment.gitCommit,
    handshakeDigest: dataOpsSituationDigest({ schemaVersion: DATAOPS_SITUATION_V2_SCHEMA, capabilityVersion: DATAOPS_SITUATION_V2_CAPABILITY,
      deploymentId: deployment.deploymentId, deploymentVersion: deployment.deploymentVersion, gitCommit: deployment.gitCommit }) };
  const source = { snapshotId, snapshotRevision, basisDate, publishedAt: occurredAt, producer, scope: auth.allowedScope,
    authorityHead: { cursor: head.cursor, ledgerSequence: head.ledgerSequence, masterDigest: head.masterDigest,
      changeDigest: head.changeDigest, movementDigest: head.movementDigest }, rows: sourceRows };
  const evidenceRows = sourceRows.map(row => ({ rowId: `${row.productId}\u001f${row.warehouseId}\u001f${row.baseUnit}`,
    sourceEvidence: row.sourceEvidence })).sort((left, right) => left.rowId.localeCompare(right.rowId));
  const rows = sourceRows.map(row => {
    const rowId = `${row.productId}\u001f${row.warehouseId}\u001f${row.baseUnit}`;
    const sourceRowDigest = dataOpsSituationDigest({ rowRevision: row.rowRevision, productId: row.productId,
      productMasterRevision: row.productMasterRevision, warehouseId: row.warehouseId, warehouseMasterRevision: row.warehouseMasterRevision,
      baseUnit: row.baseUnit, baseUnitRuleVersion: row.baseUnitRuleVersion, signedBaseQuantity: row.signedBaseQuantity,
      includedOrderQLedgerSequence: row.includedOrderQLedgerSequence, status: row.status, sourceEvidence: row.sourceEvidence });
    return { snapshotId, rowId, rowRevision: row.rowRevision, productId: row.productId, productMasterRevision: row.productMasterRevision,
      warehouseId: row.warehouseId, warehouseMasterRevision: row.warehouseMasterRevision, baseUnit: row.baseUnit,
      baseUnitRuleVersion: row.baseUnitRuleVersion, signedBaseQuantity: row.signedBaseQuantity,
      includedOrderQLedgerSequence: row.includedOrderQLedgerSequence, sourceRowDigest, status: row.status };
  }).sort((left, right) => left.rowId.localeCompare(right.rowId));
  const pages = [];
  for (let index = 0; index < rows.length; index += DATAOPS_SITUATION_V2_PAGE_SIZE) {
    const pageRows = rows.slice(index, index + DATAOPS_SITUATION_V2_PAGE_SIZE);
    pages.push({ pageIndex: pages.length, rowCount: pageRows.length, pageDigest: dataOpsSituationDigest(pageRows) });
  }
  const tombstones = rows.filter(row => row.status === 'TOMBSTONED');
  const inventoryKeys = rows.map(row => `${row.productId}\u001f${row.warehouseId}\u001f${row.baseUnit}`).sort();
  const producerEvidence = { authorityHead: source.authorityHead, rows: evidenceRows, pages, scope: auth.allowedScope };
  const snapshot = { manifest: { schemaVersion: DATAOPS_SITUATION_V2_SCHEMA, snapshotId, snapshotRevision, basisDate,
    publishedAt: occurredAt, producerDeploymentId: producer.deploymentId, producerDeploymentVersion: producer.deploymentVersion,
    producerGitCommit: producer.gitCommit, producerHandshakeDigest: producer.handshakeDigest, rowCount: rows.length,
    activeRowCount: rows.filter(row => row.status === 'ACTIVE').length, tombstoneCount: tombstones.length, inventoryKeys,
    rowDigest: dataOpsSituationDigest(rows), tombstoneDigest: dataOpsSituationDigest(tombstones), pageManifestDigest: dataOpsSituationDigest(pages),
    sourceDigest: dataOpsSituationDigest({ authorityHead: source.authorityHead, evidenceRows, scope: auth.allowedScope }), status: 'PUBLISHED' }, rows };
  dataOpsSituationBuildSnapshot(ss, { snapshot, producerEvidence, _serverScope: auth.allowedScope }, properties);
  return { snapshot, producerEvidence, scope: auth.allowedScope };
}

function dataOpsSituationChunks(text) {
  const rows = [];
  for (let index = 0; index < text.length; index += DATAOPS_SITUATION_V2_CHUNK_SIZE) rows.push(text.slice(index, index + DATAOPS_SITUATION_V2_CHUNK_SIZE));
  return rows.length ? rows : [''];
}

function dataOpsSituationWriteSlot(ss, sheetName, snapshot) {
  const sheet = getOrCreateSheet(ss, sheetName);
  const canonicalJson = dataOpsSituationCanonicalJson(snapshot);
  const chunks = dataOpsSituationChunks(canonicalJson);
  const metadata = { schemaVersion: DATAOPS_SITUATION_V2_SCHEMA, snapshotId: snapshot.manifest.snapshotId, snapshotRevision: snapshot.manifest.snapshotRevision,
    digest: sha256Hex(canonicalJson), chunkCount: chunks.length, charCount: canonicalJson.length, status: snapshot.manifest.status };
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 2).setValues([[DATAOPS_SITUATION_V2_SCHEMA, JSON.stringify(metadata)]]);
  sheet.getRange(2, 1, chunks.length, 2).setValues(chunks.map((chunk, index) => [index + 1, chunk]));
  return metadata;
}

function dataOpsSituationReadSlot(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2 || dataOpsSituationText(sheet.getRange(1, 1).getValue()) !== DATAOPS_SITUATION_V2_SCHEMA) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  let metadata;
  try { metadata = JSON.parse(String(sheet.getRange(1, 2).getValue() || '{}')); } catch (error) { throw new Error('DATAOPS_V2_MANIFEST_MISMATCH'); }
  const chunkCount = Number(metadata.chunkCount || 0);
  if (!Number.isInteger(chunkCount) || chunkCount < 1) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  const rows = sheet.getRange(2, 1, chunkCount, 2).getValues().sort((a, b) => Number(a[0]) - Number(b[0]));
  const canonicalJson = rows.map(row => String(row[1] || '')).join('');
  if (canonicalJson.length !== Number(metadata.charCount) || !dataOpsSituationConstantTime(sha256Hex(canonicalJson), metadata.digest)) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  let snapshot;
  try { snapshot = JSON.parse(canonicalJson); } catch (error) { throw new Error('DATAOPS_V2_MANIFEST_MISMATCH'); }
  dataOpsSituationValidateSnapshotSchema(snapshot);
  if (snapshot.manifest.snapshotId !== metadata.snapshotId || snapshot.manifest.snapshotRevision !== metadata.snapshotRevision) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  return { metadata, snapshot };
}

function dataOpsSituationPointer(properties) {
  try { return JSON.parse(String(properties.getProperty(DATAOPS_SITUATION_V2_PROPERTIES.CURRENT_POINTER) || 'null')); } catch (error) { return null; }
}

function dataOpsSituationEnsureLedgerSheet(ss, sheetName, headers) {
  const sheet = getOrCreateSheet(ss, sheetName);
  if (sheet.getLastRow() < 1) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sheet;
}

function dataOpsSituationReadSessions(ss) {
  const sheet = dataOpsSituationEnsureLedgerSheet(ss, DATAOPS_SITUATION_V2_SHEETS.SESSIONS, ['readSessionId', 'status', 'expiresAt', 'payloadJson']);
  if (sheet.getLastRow() < 2) return { sheet, rows: [] };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues().map((values, index) => {
    let payload = {}; try { payload = JSON.parse(String(values[3] || '{}')); } catch (error) {}
    return { rowNumber: index + 2, readSessionId: dataOpsSituationText(values[0]), status: dataOpsSituationText(values[1]), expiresAt: dataOpsSituationText(values[2]), payload };
  });
  return { sheet, rows };
}

function dataOpsSituationSaveSession(ss, session) {
  const data = dataOpsSituationReadSessions(ss);
  const existing = data.rows.find(row => row.readSessionId === session.readSessionId);
  const values = [[session.readSessionId, session.status, session.expiresAt, JSON.stringify(session)]];
  if (existing) data.sheet.getRange(existing.rowNumber, 1, 1, 4).setValues(values); else data.sheet.appendRow(values[0]);
  return session;
}

function dataOpsSituationExpireSessions(ss, nowMillis) {
  const data = dataOpsSituationReadSessions(ss);
  data.rows.forEach(row => {
    if (row.status === 'OPEN' && new Date(row.expiresAt).getTime() <= nowMillis) {
      dataOpsSituationSaveSession(ss, { ...row.payload, status: 'EXPIRED' });
      dataOpsSituationAudit(ss, { action: 'SESSION_EXPIRED', actorId: row.payload.actorId, roleIds: row.payload.roleIds,
        scopeDigest: row.payload.scopeDigest, snapshotId: row.payload.snapshotId, readSessionId: row.payload.readSessionId,
        tokenAuditDigest: sha256Hex(row.payload.tokenDigest || ''), result: 'EXPIRED', deviceId: row.payload.deviceId,
        environment: row.payload.environment, detail: { expiresAt: row.payload.expiresAt } });
    }
  });
}

function dataOpsSituationAudit(ss, entry) {
  const sheet = dataOpsSituationEnsureLedgerSheet(ss, DATAOPS_SITUATION_V2_SHEETS.AUDIT,
    ['auditId', 'action', 'actorId', 'roleIds', 'scopeDigest', 'snapshotId', 'readSessionId', 'tokenAuditDigest', 'result', 'at', 'detailDigest', 'deviceId', 'environment']);
  sheet.appendRow([Utilities.getUuid(), entry.action, entry.actorId, JSON.stringify(entry.roleIds || []), entry.scopeDigest || '', entry.snapshotId || '',
    entry.readSessionId || '', entry.tokenAuditDigest || '', entry.result || 'SUCCESS', new Date().toISOString(), dataOpsSituationDigest(entry.detail || {}),
    entry.deviceId || '', entry.environment || '']);
}

function dataOpsSituationPublish(ss, payload, auth, properties) {
  dataOpsSituationRequireDeployment(properties);
  const snapshot = dataOpsSituationBuildSnapshot(ss, { ...payload, _serverScope: auth.allowedScope }, properties);
  const pointer = dataOpsSituationPointer(properties);
  if (pointer && pointer.snapshotId === snapshot.manifest.snapshotId) {
    if (pointer.snapshotRevision !== snapshot.manifest.snapshotRevision) throw new Error('DATAOPS_V2_PUBLISH_CONFLICT');
    return dataOpsSituationReadSlot(ss, pointer.slot === 'A' ? DATAOPS_SITUATION_V2_SHEETS.A : DATAOPS_SITUATION_V2_SHEETS.B).snapshot;
  }
  if ((!pointer && snapshot.manifest.snapshotRevision !== 1)
    || (pointer && snapshot.manifest.snapshotRevision !== pointer.snapshotRevision + 1)) throw new Error('DATAOPS_V2_PUBLISH_REVISION_CONFLICT');
  const now = Date.now();
  dataOpsSituationExpireSessions(ss, now);
  const sessions = dataOpsSituationReadSessions(ss).rows.filter(row => row.status === 'OPEN' && new Date(row.expiresAt).getTime() > now);
  const nextSlot = pointer && pointer.slot === 'A' ? 'B' : 'A';
  if (sessions.some(row => row.payload.slot === nextSlot)) throw new Error('DATAOPS_V2_SLOT_PINNED');
  dataOpsSituationWriteSlot(ss, DATAOPS_SITUATION_V2_SHEETS.TEMP, snapshot);
  const temp = dataOpsSituationReadSlot(ss, DATAOPS_SITUATION_V2_SHEETS.TEMP);
  const slotName = nextSlot === 'A' ? DATAOPS_SITUATION_V2_SHEETS.A : DATAOPS_SITUATION_V2_SHEETS.B;
  dataOpsSituationWriteSlot(ss, slotName, temp.snapshot);
  const verified = dataOpsSituationReadSlot(ss, slotName);
  if (verified.snapshot.manifest.snapshotRevision !== snapshot.manifest.snapshotRevision) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  dataOpsSituationAudit(ss, { action: 'PUBLISH', actorId: auth.actorId, roleIds: auth.roleIds, scopeDigest: auth.scopeDigest,
    deviceId: auth.deviceId, environment: auth.environment, snapshotId: snapshot.manifest.snapshotId,
    detail: { snapshotRevision: snapshot.manifest.snapshotRevision, previousPointer: pointer || null } });
  const previousPointer = pointer ? { slot: pointer.slot, snapshotId: pointer.snapshotId, snapshotRevision: pointer.snapshotRevision,
    sourceDigest: pointer.sourceDigest || '', updatedAt: pointer.updatedAt || '' } : null;
  properties.setProperty(DATAOPS_SITUATION_V2_PROPERTIES.CURRENT_POINTER, JSON.stringify({ slot: nextSlot, snapshotId: snapshot.manifest.snapshotId,
    snapshotRevision: snapshot.manifest.snapshotRevision, sourceDigest: snapshot.manifest.sourceDigest, previous: previousPointer, updatedAt: new Date().toISOString() }));
  return verified.snapshot;
}

function dataOpsSituationCurrentSnapshot(ss, properties) {
  const pointer = dataOpsSituationPointer(properties);
  if (!pointer || (pointer.slot !== 'A' && pointer.slot !== 'B')) throw new Error('DATAOPS_V2_SNAPSHOT_NOT_PUBLISHED');
  const slotName = pointer.slot === 'A' ? DATAOPS_SITUATION_V2_SHEETS.A : DATAOPS_SITUATION_V2_SHEETS.B;
  const current = dataOpsSituationReadSlot(ss, slotName);
  if (current.snapshot.manifest.snapshotId !== pointer.snapshotId || current.snapshot.manifest.snapshotRevision !== pointer.snapshotRevision) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  return { pointer, snapshot: current.snapshot };
}

/** Protected operator helper. Intentionally not exposed from dataOpsSituationHandleAction. */
function dataOpsSituationRollbackInternal(ss, request, auth, properties) {
  if (!auth || auth.roleIds.indexOf(DATAOPS_SITUATION_V2_ROLE_READ) < 0 || auth.roleIds.indexOf(DATAOPS_SITUATION_V2_ROLE_PUBLISH) < 0) {
    throw new Error('DATAOPS_SITUATION_ROLE_REQUIRED');
  }
  const pointer = dataOpsSituationPointer(properties);
  const expectedRevision = Number(request && request.expectedCurrentRevision);
  const reason = dataOpsSituationText(request && request.reason);
  if (!pointer || pointer.snapshotRevision !== expectedRevision || !reason || !pointer.previous
    || (pointer.previous.slot !== 'A' && pointer.previous.slot !== 'B')) throw new Error('DATAOPS_V2_ROLLBACK_PRECONDITION_FAILED');
  const previousSlot = pointer.previous.slot === 'A' ? DATAOPS_SITUATION_V2_SHEETS.A : DATAOPS_SITUATION_V2_SHEETS.B;
  const previous = dataOpsSituationReadSlot(ss, previousSlot).snapshot;
  if (previous.manifest.snapshotId !== pointer.previous.snapshotId || previous.manifest.snapshotRevision !== pointer.previous.snapshotRevision) {
    throw new Error('DATAOPS_V2_ROLLBACK_READBACK_FAILED');
  }
  const nextPointer = { slot: pointer.previous.slot, snapshotId: previous.manifest.snapshotId,
    snapshotRevision: previous.manifest.snapshotRevision, sourceDigest: previous.manifest.sourceDigest,
    previous: { slot: pointer.slot, snapshotId: pointer.snapshotId, snapshotRevision: pointer.snapshotRevision,
      sourceDigest: pointer.sourceDigest || '', updatedAt: pointer.updatedAt || '' }, updatedAt: new Date().toISOString() };
  dataOpsSituationAudit(ss, { action: 'ROLLBACK', actorId: auth.actorId, roleIds: auth.roleIds, scopeDigest: auth.scopeDigest,
    deviceId: auth.deviceId, environment: auth.environment, snapshotId: previous.manifest.snapshotId,
    detail: { reason, expectedCurrentRevision: expectedRevision, previousSlot: pointer.previous.slot } });
  properties.setProperty(DATAOPS_SITUATION_V2_PROPERTIES.CURRENT_POINTER, JSON.stringify(nextPointer));
  return { snapshotId: previous.manifest.snapshotId, snapshotRevision: previous.manifest.snapshotRevision, slot: pointer.previous.slot };
}

function dataOpsSituationSessionToken(session, properties) {
  const key = dataOpsSituationText(properties.getProperty(DATAOPS_SITUATION_V2_PROPERTIES.SIGNING_KEY));
  if (!key) throw new Error('DATAOPS_SITUATION_AUTH_NOT_CONFIGURED');
  const payload = { ...session };
  delete payload.tokenDigest;
  const signature = Utilities.computeHmacSha256Signature(dataOpsSituationCanonicalJson(payload), key, Utilities.Charset.UTF_8);
  return signature.map(value => (value < 0 ? value + 256 : value).toString(16).padStart(2, '0')).join('');
}

function dataOpsSituationBegin(ss, payload, auth, properties) {
  const deployment = dataOpsSituationRequireDeployment(properties);
  const current = dataOpsSituationCurrentSnapshot(ss, properties);
  const scope = { value: auth.allowedScope, digest: auth.scopeDigest };
  const rows = current.snapshot.rows || [];
  const pages = [];
  for (let index = 0; index < rows.length; index += DATAOPS_SITUATION_V2_PAGE_SIZE) {
    const pageRows = rows.slice(index, index + DATAOPS_SITUATION_V2_PAGE_SIZE);
    pages.push({ pageIndex: pages.length, rowCount: pageRows.length, pageDigest: dataOpsSituationDigest(pageRows) });
  }
  const issuedAtMillis = Date.now();
  const inventoryKeyDigest = dataOpsSituationDigest([...(current.snapshot.manifest.inventoryKeys || [])].sort());
  const perKeyCutoffDigest = dataOpsSituationDigest(rows.map(row => ({ inventoryKey: `${row.productId}\u001f${row.warehouseId}\u001f${row.baseUnit}`,
    includedOrderQLedgerSequence: Number(row.includedOrderQLedgerSequence), status: dataOpsSituationText(row.status).toUpperCase() }))
    .sort((left,right) => left.inventoryKey.localeCompare(right.inventoryKey)));
  const headDigest = dataOpsSituationDigest(current.snapshot.manifest);
  const session = {
    readSessionId: Utilities.getUuid(), authority: 'DATAOPS', tokenVersion: 'V1', ...deployment,
    actorId: auth.actorId, roleIds: auth.roleIds, scopeDigest: scope.digest, deviceId: auth.deviceId, environment: auth.environment,
    issuedAt: new Date(issuedAtMillis).toISOString(), expiresAt: new Date(issuedAtMillis + DATAOPS_SITUATION_V2_TTL_SECONDS * 1000).toISOString(),
    headRevision: current.snapshot.manifest.snapshotRevision, headDigest, inventoryKeyDigest, perKeyCutoffDigest,
    entityManifest: current.snapshot.manifest,
    pageManifest: pages, tombstoneManifest: { count: current.snapshot.manifest.tombstoneCount, digest: current.snapshot.manifest.tombstoneDigest },
    snapshotId: current.snapshot.manifest.snapshotId, snapshotRevision: current.snapshot.manifest.snapshotRevision, slot: current.pointer.slot, status: 'OPEN'
  };
  session.tokenDigest = dataOpsSituationSessionToken(session, properties);
  dataOpsSituationSaveSession(ss, session);
  dataOpsSituationAudit(ss, { action: 'BEGIN', actorId: auth.actorId, roleIds: auth.roleIds, scopeDigest: scope.digest,
    deviceId: auth.deviceId, environment: auth.environment,
    snapshotId: session.snapshotId, readSessionId: session.readSessionId, tokenAuditDigest: sha256Hex(session.tokenDigest), detail: { pageCount: pages.length } });
  return session;
}

/** Internal bridge for ORDER Q O1. It never accepts client-provided D1 digests. */
function dataOpsSituationVerifyOrderQBridgeSession(ss, request, properties) {
  const readSessionId = dataOpsSituationText(request && request.dataOpsReadSessionId);
  const tokenDigest = dataOpsSituationText(request && request.dataOpsTokenDigest);
  const stored = dataOpsSituationReadSessions(ss).rows.find(row => row.readSessionId === readSessionId);
  if (!stored || stored.status !== 'OPEN') throw new Error('SITUATION_READ_TOKEN_INVALID');
  const session = stored.payload;
  const recalculated = dataOpsSituationSessionToken(session, properties);
  if (!dataOpsSituationConstantTime(session.tokenDigest,recalculated) || !dataOpsSituationConstantTime(session.tokenDigest,tokenDigest)) throw new Error('SITUATION_READ_TOKEN_INVALID');
  if (Date.now() >= new Date(session.expiresAt).getTime()) {
    dataOpsSituationSaveSession(ss,{...session,status:'EXPIRED'});
    throw new Error('SITUATION_READ_TOKEN_EXPIRED');
  }
  const deployment = dataOpsSituationRequireDeployment(properties);
  if (deployment.deploymentId !== session.deploymentId || deployment.deploymentVersion !== session.deploymentVersion
    || deployment.gitCommit !== session.gitCommit || deployment.capabilityVersion !== session.capabilityVersion) throw new Error('SITUATION_READ_DEPLOYMENT_CHANGED');
  const actorId=dataOpsSituationText(request&&request.actorId),scopeDigest=dataOpsSituationDigest({companyId:dataOpsSituationText(request&&request.scope&&request.scope.companyId)});
  if (actorId!==session.actorId || scopeDigest!==session.scopeDigest || (session.roleIds||[]).indexOf(DATAOPS_SITUATION_V2_ROLE_READ)<0) throw new Error('SITUATION_READ_SCOPE_MISMATCH');
  dataOpsSituationAudit(ss,{action:'ORDERQ_BRIDGE_VERIFY',actorId:session.actorId,roleIds:session.roleIds,scopeDigest:session.scopeDigest,
    deviceId:dataOpsSituationText(request&&request.device),environment:dataOpsSituationText(request&&request.environment),snapshotId:session.snapshotId,
    readSessionId:session.readSessionId,tokenAuditDigest:sha256Hex(session.tokenDigest),detail:{headRevision:session.headRevision,inventoryKeyDigest:session.inventoryKeyDigest,perKeyCutoffDigest:session.perKeyCutoffDigest}});
  return { readSessionId:session.readSessionId, tokenDigest:session.tokenDigest, actorId:session.actorId, scopeDigest:session.scopeDigest,
    expiresAt:session.expiresAt, deploymentId:session.deploymentId, deploymentVersion:session.deploymentVersion, gitCommit:session.gitCommit,
    capabilityVersion:session.capabilityVersion, headRevision:session.headRevision, headDigest:session.headDigest,
    inventoryKeyDigest:session.inventoryKeyDigest, perKeyCutoffDigest:session.perKeyCutoffDigest,
    inventoryKeys:[...(session.entityManifest.inventoryKeys||[])], rows:(dataOpsSituationReadSlot(ss,session.slot==='A'?DATAOPS_SITUATION_V2_SHEETS.A:DATAOPS_SITUATION_V2_SHEETS.B).snapshot.rows||[]) };
}

function dataOpsSituationRequireSession(ss, payload, auth, properties) {
  const id = dataOpsSituationText(payload && payload.readSessionId);
  const token = dataOpsSituationText(payload && payload.tokenDigest);
  const stored = dataOpsSituationReadSessions(ss).rows.find(row => row.readSessionId === id);
  if (!stored || stored.status !== 'OPEN') throw new Error('SITUATION_READ_TOKEN_INVALID');
  const session = stored.payload;
  const recalculated = dataOpsSituationSessionToken(session, properties);
  if (!dataOpsSituationConstantTime(session.tokenDigest, recalculated) || !dataOpsSituationConstantTime(session.tokenDigest, token)) throw new Error('SITUATION_READ_TOKEN_INVALID');
  if (Date.now() >= new Date(session.expiresAt).getTime()) {
    dataOpsSituationSaveSession(ss, { ...session, status: 'EXPIRED' });
    throw new Error('SITUATION_READ_TOKEN_EXPIRED');
  }
  const deployment = dataOpsSituationRequireDeployment(properties);
  if (deployment.deploymentId !== session.deploymentId || deployment.deploymentVersion !== session.deploymentVersion
    || deployment.gitCommit !== session.gitCommit || deployment.capabilityVersion !== session.capabilityVersion) throw new Error('SITUATION_READ_DEPLOYMENT_CHANGED');
  if (auth.actorId !== session.actorId || JSON.stringify(auth.roleIds) !== JSON.stringify(session.roleIds)
    || auth.scopeDigest !== session.scopeDigest) throw new Error('SITUATION_READ_SCOPE_MISMATCH');
  return session;
}

function dataOpsSituationPage(ss, payload, auth, properties) {
  const session = dataOpsSituationRequireSession(ss, payload, auth, properties);
  const pageIndex = Number(payload.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= session.pageManifest.length) throw new Error('SITUATION_READ_PAGE_OUT_OF_RANGE');
  const slotName = session.slot === 'A' ? DATAOPS_SITUATION_V2_SHEETS.A : DATAOPS_SITUATION_V2_SHEETS.B;
  const snapshot = dataOpsSituationReadSlot(ss, slotName).snapshot;
  if (snapshot.manifest.snapshotRevision !== session.snapshotRevision) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  const rows = snapshot.rows.slice(pageIndex * DATAOPS_SITUATION_V2_PAGE_SIZE, (pageIndex + 1) * DATAOPS_SITUATION_V2_PAGE_SIZE);
  const expected = session.pageManifest[pageIndex];
  if (rows.length !== expected.rowCount || dataOpsSituationDigest(rows) !== expected.pageDigest) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  dataOpsSituationAudit(ss, { action: 'PAGE', actorId: auth.actorId, roleIds: auth.roleIds, scopeDigest: session.scopeDigest,
    deviceId: auth.deviceId, environment: auth.environment,
    snapshotId: session.snapshotId, readSessionId: session.readSessionId, tokenAuditDigest: sha256Hex(session.tokenDigest), detail: { pageIndex, rowCount: rows.length } });
  return { readSessionId: session.readSessionId, pageIndex, rows, pageDigest: expected.pageDigest };
}

function dataOpsSituationHead(ss, payload, auth, properties) {
  const session = dataOpsSituationRequireSession(ss, payload, auth, properties);
  const current = dataOpsSituationCurrentSnapshot(ss, properties);
  const result = { readSessionId: session.readSessionId, frozenTokenDigest: session.tokenDigest,
    frozenManifestDigest: dataOpsSituationDigest({ entityManifest: session.entityManifest, pageManifest: session.pageManifest, tombstoneManifest: session.tombstoneManifest }),
    beginHeadRevision: session.headRevision, beginHeadDigest:session.headDigest, currentHeadRevision: current.snapshot.manifest.snapshotRevision,
    currentHeadDigest: dataOpsSituationDigest(current.snapshot.manifest) };
  dataOpsSituationAudit(ss, { action: 'HEAD', actorId: auth.actorId, roleIds: auth.roleIds, scopeDigest: session.scopeDigest,
    deviceId: auth.deviceId, environment: auth.environment,
    snapshotId: session.snapshotId, readSessionId: session.readSessionId, tokenAuditDigest: sha256Hex(session.tokenDigest), detail: result });
  dataOpsSituationSaveSession(ss, { ...session, status: 'CONSUMED', consumedAt: new Date().toISOString() });
  return result;
}

function dataOpsSituationPing(properties) {
  const deployment = dataOpsSituationRequireDeployment(properties);
  return {
    schemaVersion: DATAOPS_SITUATION_V2_SCHEMA,
    capabilityVersion: DATAOPS_SITUATION_V2_CAPABILITY,
    readSessionTtlSeconds: DATAOPS_SITUATION_V2_TTL_SECONDS,
    canonicalHash: 'SHA-256', publishMode: 'ATOMIC_POINTER_LAST', ...deployment,
    actions: ['situation_dataops_begin', 'situation_dataops_page', 'situation_dataops_head']
  };
}

function dataOpsSituationHandleAction(ss, action, payload) {
  const properties = PropertiesService.getScriptProperties();
  const role = action === 'situation_dataops_publish' ? DATAOPS_SITUATION_V2_ROLE_PUBLISH : DATAOPS_SITUATION_V2_ROLE_READ;
  let auth = null;
  try {
    auth = dataOpsSituationRequireAuth(payload, role, properties);
    if (action === 'situation_dataops_publish' && auth.roleIds.indexOf(DATAOPS_SITUATION_V2_ROLE_READ) < 0) throw new Error('DATAOPS_SITUATION_ROLE_REQUIRED');
    if (action === 'situation_dataops_ping') return dataOpsSituationPing(properties);
    if (action === 'situation_dataops_publish' && payload && payload.rollbackRequest) {
      return dataOpsSituationRollbackInternal(ss, payload.rollbackRequest, auth, properties);
    }
    if (action === 'situation_dataops_publish' && payload && payload.prepareOperationalRequest) {
      return dataOpsSituationPrepareOperationalSource(ss, payload.prepareOperationalRequest, auth, properties);
    }
    if (action === 'situation_dataops_publish') return dataOpsSituationPublish(ss, payload, auth, properties);
    if (action === 'situation_dataops_begin') return dataOpsSituationBegin(ss, payload, auth, properties);
    if (action === 'situation_dataops_page') return dataOpsSituationPage(ss, payload, auth, properties);
    if (action === 'situation_dataops_head') return dataOpsSituationHead(ss, payload, auth, properties);
    throw new Error(`DATAOPS_SITUATION_ACTION_INVALID:${action}`);
  } catch (error) {
    if (auth) dataOpsSituationAudit(ss, { action, actorId: auth.actorId, roleIds: auth.roleIds, scopeDigest: auth.scopeDigest,
      deviceId: auth.deviceId, environment: auth.environment, result: 'FAILURE', detail: { code: dataOpsSituationText(error && error.message) } });
    throw error;
  }
}
