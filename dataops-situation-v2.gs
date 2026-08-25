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
const DATAOPS_SITUATION_V2_ROLE_READ = 'DATAOPS_SITUATION_READ';
const DATAOPS_SITUATION_V2_ROLE_PUBLISH = 'DATAOPS_SITUATION_PUBLISH';
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
  return { actorId, roleIds: roles.slice().sort(), tokenDigest: suppliedDigest };
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

function dataOpsSituationNormalizeRow(row, index) {
  const result = {
    rowRevision: Number(row && row.rowRevision || 0),
    productId: dataOpsSituationText(row && row.productId),
    productMasterRevision: Number(row && row.productMasterRevision || 0),
    warehouseId: dataOpsSituationText(row && row.warehouseId),
    warehouseMasterRevision: Number(row && row.warehouseMasterRevision || 0),
    baseUnit: dataOpsSituationText(row && row.baseUnit),
    baseUnitRuleVersion: dataOpsSituationText(row && row.baseUnitRuleVersion),
    signedBaseQuantity: dataOpsSituationStrictNumber(row && row.signedBaseQuantity),
    includedOrderQLedgerSequence: Number(row && row.includedOrderQLedgerSequence),
    businessDate: dataOpsSituationText(row && row.businessDate),
    sourceEvidence: (Array.isArray(row && row.sourceEvidence) ? row.sourceEvidence : []).map(item => ({
      sourceEvidenceId: dataOpsSituationText(item && item.sourceEvidenceId),
      movementId: dataOpsSituationText(item && item.movementId),
      effectKey: dataOpsSituationText(item && item.effectKey),
      movementRevision: Number(item && item.movementRevision || 0)
    })).sort((left, right) => left.movementId.localeCompare(right.movementId))
  };
  if (!result.productId || !result.productMasterRevision || !result.warehouseId || !result.warehouseMasterRevision
    || !result.baseUnit || !result.baseUnitRuleVersion || !result.rowRevision || !/^\d{4}-\d{2}-\d{2}$/.test(result.businessDate)
    || !Number.isInteger(result.includedOrderQLedgerSequence) || result.includedOrderQLedgerSequence < 0
    || result.sourceEvidence.some(item => !item.sourceEvidenceId || !item.movementId || !item.effectKey || !item.movementRevision)) {
    throw new Error(`DATAOPS_V2_ROW_INVALID:${index + 1}`);
  }
  const digestSource = { ...result };
  const rowDigest = dataOpsSituationDigest(digestSource);
  if (row.rowDigest && !dataOpsSituationConstantTime(row.rowDigest, rowDigest)) throw new Error(`DATAOPS_V2_ROW_DIGEST_MISMATCH:${index + 1}`);
  return { ...result, rowDigest, inventoryKey: `${result.productId}\u001f${result.warehouseId}\u001f${result.baseUnit}` };
}

function dataOpsSituationValidateRows(ss, snapshot) {
  const rowsSource = Array.isArray(snapshot && snapshot.rows) ? snapshot.rows : null;
  if (!rowsSource || !rowsSource.length || rowsSource.length > DATAOPS_SITUATION_V2_MAX_ROWS) throw new Error('DATAOPS_V2_SNAPSHOT_REQUIRED');
  const rows = rowsSource.map(dataOpsSituationNormalizeRow);
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
  const expectedHead = snapshot.authorityHead || {};
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
  return { rows, head };
}

function dataOpsSituationBuildSnapshot(ss, payload) {
  const source = payload && payload.snapshot;
  if (!source || source.schemaVersion !== DATAOPS_SITUATION_V2_SCHEMA) throw new Error('DATAOPS_V2_SNAPSHOT_REQUIRED');
  const validated = dataOpsSituationValidateRows(ss, source);
  const businessDate = dataOpsSituationText(source.businessDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw new Error('DATAOPS_V2_SNAPSHOT_REQUIRED');
  const rowDigest = dataOpsSituationDigest(validated.rows.map(row => row.rowDigest));
  const inventoryKeyDigest = dataOpsSituationDigest(validated.rows.map(row => row.inventoryKey));
  const perKeyCutoffDigest = dataOpsSituationDigest(validated.rows.map(row => [row.inventoryKey, row.includedOrderQLedgerSequence]));
  const sourceEvidenceDigest = dataOpsSituationDigest(validated.rows.map(row => [row.inventoryKey, row.sourceEvidence]));
  const snapshotId = dataOpsSituationText(source.snapshotId) || `DATAOPS-V2-${businessDate.replace(/-/g, '')}-${rowDigest.slice(0, 16)}`;
  const canonical = {
    schemaVersion: DATAOPS_SITUATION_V2_SCHEMA,
    snapshotId,
    businessDate,
    authorityHead: { cursor: validated.head.cursor, ledgerSequence: validated.head.ledgerSequence, masterDigest: validated.head.masterDigest,
      changeDigest: validated.head.changeDigest, movementDigest: validated.head.movementDigest },
    rows: validated.rows,
    tombstones: Array.isArray(source.tombstones) ? dataOpsSituationCanonical(source.tombstones) : [],
    manifest: {
      rowCount: validated.rows.length,
      rowDigest,
      inventoryKeyDigest,
      perKeyCutoffDigest,
      sourceEvidenceDigest
    }
  };
  const snapshotRevision = dataOpsSituationDigest(canonical);
  return { ...canonical, snapshotRevision, status: 'PUBLISHED', publishedAt: new Date().toISOString() };
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
  const metadata = { schemaVersion: DATAOPS_SITUATION_V2_SCHEMA, snapshotId: snapshot.snapshotId, snapshotRevision: snapshot.snapshotRevision,
    digest: sha256Hex(canonicalJson), chunkCount: chunks.length, charCount: canonicalJson.length, status: snapshot.status };
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
  if (snapshot.schemaVersion !== DATAOPS_SITUATION_V2_SCHEMA || snapshot.status !== 'PUBLISHED'
    || snapshot.snapshotId !== metadata.snapshotId || snapshot.snapshotRevision !== metadata.snapshotRevision) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
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
    if (row.status === 'OPEN' && new Date(row.expiresAt).getTime() <= nowMillis) dataOpsSituationSaveSession(ss, { ...row.payload, status: 'EXPIRED' });
  });
}

function dataOpsSituationAudit(ss, entry) {
  const sheet = dataOpsSituationEnsureLedgerSheet(ss, DATAOPS_SITUATION_V2_SHEETS.AUDIT,
    ['auditId', 'action', 'actorId', 'roleIds', 'scopeDigest', 'snapshotId', 'readSessionId', 'tokenAuditDigest', 'result', 'at', 'detailDigest']);
  sheet.appendRow([Utilities.getUuid(), entry.action, entry.actorId, JSON.stringify(entry.roleIds || []), entry.scopeDigest || '', entry.snapshotId || '',
    entry.readSessionId || '', entry.tokenAuditDigest || '', entry.result || 'SUCCESS', new Date().toISOString(), dataOpsSituationDigest(entry.detail || {})]);
}

function dataOpsSituationPublish(ss, payload, auth, properties) {
  dataOpsSituationRequireDeployment(properties);
  const snapshot = dataOpsSituationBuildSnapshot(ss, payload);
  const pointer = dataOpsSituationPointer(properties);
  if (pointer && pointer.snapshotId === snapshot.snapshotId) {
    if (pointer.snapshotRevision !== snapshot.snapshotRevision) throw new Error('DATAOPS_V2_PUBLISH_CONFLICT');
    return dataOpsSituationReadSlot(ss, pointer.slot === 'A' ? DATAOPS_SITUATION_V2_SHEETS.A : DATAOPS_SITUATION_V2_SHEETS.B).snapshot;
  }
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
  if (verified.snapshot.snapshotRevision !== snapshot.snapshotRevision) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  const scope = dataOpsSituationScope(payload);
  dataOpsSituationAudit(ss, { action: 'PUBLISH', actorId: auth.actorId, roleIds: auth.roleIds, scopeDigest: scope.digest,
    snapshotId: snapshot.snapshotId, detail: { snapshotRevision: snapshot.snapshotRevision, previousPointer: pointer || null } });
  const previousPointer = pointer ? { slot: pointer.slot, snapshotId: pointer.snapshotId, snapshotRevision: pointer.snapshotRevision,
    authorityHead: pointer.authorityHead || null, updatedAt: pointer.updatedAt || '' } : null;
  properties.setProperty(DATAOPS_SITUATION_V2_PROPERTIES.CURRENT_POINTER, JSON.stringify({ slot: nextSlot, snapshotId: snapshot.snapshotId,
    snapshotRevision: snapshot.snapshotRevision, authorityHead: snapshot.authorityHead, previous: previousPointer, updatedAt: new Date().toISOString() }));
  return verified.snapshot;
}

function dataOpsSituationCurrentSnapshot(ss, properties) {
  const pointer = dataOpsSituationPointer(properties);
  if (!pointer || (pointer.slot !== 'A' && pointer.slot !== 'B')) throw new Error('DATAOPS_V2_SNAPSHOT_NOT_PUBLISHED');
  const slotName = pointer.slot === 'A' ? DATAOPS_SITUATION_V2_SHEETS.A : DATAOPS_SITUATION_V2_SHEETS.B;
  const current = dataOpsSituationReadSlot(ss, slotName);
  if (current.snapshot.snapshotId !== pointer.snapshotId || current.snapshot.snapshotRevision !== pointer.snapshotRevision) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  return { pointer, snapshot: current.snapshot };
}

function dataOpsSituationSessionToken(session, properties) {
  const key = dataOpsSituationText(properties.getProperty(DATAOPS_SITUATION_V2_PROPERTIES.SIGNING_KEY));
  if (!key) throw new Error('DATAOPS_SITUATION_AUTH_NOT_CONFIGURED');
  const signature = Utilities.computeHmacSha256Signature(dataOpsSituationCanonicalJson({ ...session, tokenDigest: undefined }), key, Utilities.Charset.UTF_8);
  return signature.map(value => (value < 0 ? value + 256 : value).toString(16).padStart(2, '0')).join('');
}

function dataOpsSituationBegin(ss, payload, auth, properties) {
  const deployment = dataOpsSituationRequireDeployment(properties);
  const current = dataOpsSituationCurrentSnapshot(ss, properties);
  const scope = dataOpsSituationScope(payload);
  const rows = current.snapshot.rows || [];
  const pages = [];
  for (let index = 0; index < rows.length; index += DATAOPS_SITUATION_V2_PAGE_SIZE) {
    const pageRows = rows.slice(index, index + DATAOPS_SITUATION_V2_PAGE_SIZE);
    pages.push({ pageIndex: pages.length, rowCount: pageRows.length, pageDigest: dataOpsSituationDigest(pageRows) });
  }
  const issuedAtMillis = Date.now();
  const session = {
    readSessionId: Utilities.getUuid(), authority: 'DATAOPS', tokenVersion: 'V1', ...deployment,
    actorId: auth.actorId, roleIds: auth.roleIds, scopeDigest: scope.digest,
    issuedAt: new Date(issuedAtMillis).toISOString(), expiresAt: new Date(issuedAtMillis + DATAOPS_SITUATION_V2_TTL_SECONDS * 1000).toISOString(),
    headRevision: current.snapshot.snapshotRevision, entityManifest: current.snapshot.manifest,
    pageManifest: pages, tombstoneManifest: { count: (current.snapshot.tombstones || []).length, digest: dataOpsSituationDigest(current.snapshot.tombstones || []) },
    snapshotId: current.snapshot.snapshotId, snapshotRevision: current.snapshot.snapshotRevision, slot: current.pointer.slot, status: 'OPEN'
  };
  session.tokenDigest = dataOpsSituationSessionToken(session, properties);
  dataOpsSituationSaveSession(ss, session);
  dataOpsSituationAudit(ss, { action: 'BEGIN', actorId: auth.actorId, roleIds: auth.roleIds, scopeDigest: scope.digest,
    snapshotId: session.snapshotId, readSessionId: session.readSessionId, tokenAuditDigest: sha256Hex(session.tokenDigest), detail: { pageCount: pages.length } });
  return session;
}

function dataOpsSituationRequireSession(ss, payload, auth, properties) {
  const id = dataOpsSituationText(payload && payload.readSessionId);
  const token = dataOpsSituationText(payload && payload.tokenDigest);
  const stored = dataOpsSituationReadSessions(ss).rows.find(row => row.readSessionId === id);
  if (!stored || stored.status !== 'OPEN' || !dataOpsSituationConstantTime(stored.payload.tokenDigest, token)) throw new Error('SITUATION_READ_TOKEN_INVALID');
  const session = stored.payload;
  if (Date.now() >= new Date(session.expiresAt).getTime()) {
    dataOpsSituationSaveSession(ss, { ...session, status: 'EXPIRED' });
    throw new Error('SITUATION_READ_TOKEN_EXPIRED');
  }
  const deployment = dataOpsSituationRequireDeployment(properties);
  if (deployment.deploymentId !== session.deploymentId || deployment.deploymentVersion !== session.deploymentVersion
    || deployment.gitCommit !== session.gitCommit || deployment.capabilityVersion !== session.capabilityVersion) throw new Error('SITUATION_READ_DEPLOYMENT_CHANGED');
  if (auth.actorId !== session.actorId || JSON.stringify(auth.roleIds) !== JSON.stringify(session.roleIds)
    || dataOpsSituationScope(payload).digest !== session.scopeDigest) throw new Error('SITUATION_READ_SCOPE_MISMATCH');
  return session;
}

function dataOpsSituationPage(ss, payload, auth, properties) {
  const session = dataOpsSituationRequireSession(ss, payload, auth, properties);
  const pageIndex = Number(payload.pageIndex);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= session.pageManifest.length) throw new Error('SITUATION_READ_PAGE_OUT_OF_RANGE');
  const slotName = session.slot === 'A' ? DATAOPS_SITUATION_V2_SHEETS.A : DATAOPS_SITUATION_V2_SHEETS.B;
  const snapshot = dataOpsSituationReadSlot(ss, slotName).snapshot;
  if (snapshot.snapshotRevision !== session.snapshotRevision) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  const rows = snapshot.rows.slice(pageIndex * DATAOPS_SITUATION_V2_PAGE_SIZE, (pageIndex + 1) * DATAOPS_SITUATION_V2_PAGE_SIZE);
  const expected = session.pageManifest[pageIndex];
  if (rows.length !== expected.rowCount || dataOpsSituationDigest(rows) !== expected.pageDigest) throw new Error('DATAOPS_V2_MANIFEST_MISMATCH');
  dataOpsSituationAudit(ss, { action: 'PAGE', actorId: auth.actorId, roleIds: auth.roleIds, scopeDigest: session.scopeDigest,
    snapshotId: session.snapshotId, readSessionId: session.readSessionId, tokenAuditDigest: sha256Hex(session.tokenDigest), detail: { pageIndex, rowCount: rows.length } });
  return { readSessionId: session.readSessionId, pageIndex, rows, pageDigest: expected.pageDigest };
}

function dataOpsSituationHead(ss, payload, auth, properties) {
  const session = dataOpsSituationRequireSession(ss, payload, auth, properties);
  const current = dataOpsSituationCurrentSnapshot(ss, properties);
  const result = { readSessionId: session.readSessionId, frozenTokenDigest: session.tokenDigest,
    frozenManifestDigest: dataOpsSituationDigest({ entityManifest: session.entityManifest, pageManifest: session.pageManifest, tombstoneManifest: session.tombstoneManifest }),
    beginHeadRevision: session.headRevision, currentHeadRevision: current.snapshot.snapshotRevision,
    currentHeadDigest: dataOpsSituationDigest(current.snapshot.manifest) };
  dataOpsSituationAudit(ss, { action: 'HEAD', actorId: auth.actorId, roleIds: auth.roleIds, scopeDigest: session.scopeDigest,
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
  const auth = dataOpsSituationRequireAuth(payload, role, properties);
  if (action === 'situation_dataops_publish' && auth.roleIds.indexOf(DATAOPS_SITUATION_V2_ROLE_READ) < 0) {
    throw new Error('DATAOPS_SITUATION_ROLE_REQUIRED');
  }
  if (action === 'situation_dataops_ping') return dataOpsSituationPing(properties);
  if (action === 'situation_dataops_publish') return dataOpsSituationPublish(ss, payload, auth, properties);
  if (action === 'situation_dataops_begin') return dataOpsSituationBegin(ss, payload, auth, properties);
  if (action === 'situation_dataops_page') return dataOpsSituationPage(ss, payload, auth, properties);
  if (action === 'situation_dataops_head') return dataOpsSituationHead(ss, payload, auth, properties);
  throw new Error(`DATAOPS_SITUATION_ACTION_INVALID:${action}`);
}
