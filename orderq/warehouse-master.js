import {
  STORE,
  getAll,
  openOrderQDb,
  normalizeText,
  nowIso,
  requestToPromise,
  transactionDone
} from './orderq-db.js?v=0.7.1';

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function normalizeWarehouseCode(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  if (!text) return '';
  if (/^\d+$/.test(text)) return text.padStart(2, '0');
  return text.replace(/\s+/g, '').toUpperCase();
}

export function warehouseCodeFromLabel(value) {
  const text = String(value ?? '').normalize('NFKC').trim();
  const match = text.match(/^0*(\d+)(?:\s*[^\d].*)?$/);
  return match ? normalizeWarehouseCode(match[1]) : '';
}

export function warehouseIdentity(input = {}) {
  const legacyText = String(input.warehouse ?? '').trim();
  const requestedName = String(input.warehouseName ?? legacyText).trim();
  const requestedCode = String(input.warehouseCode ?? '').trim();
  const inferredCode = requestedCode || warehouseCodeFromLabel(requestedName);
  const warehouseCode = normalizeWarehouseCode(inferredCode);
  const warehouseName = requestedName || warehouseCode;
  const normalizedName = normalizeText(warehouseName);
  const requestedId = String(input.warehouseId ?? '').trim();
  const safeCode = warehouseCode.replace(/[^0-9A-Z_-]/g, '-');
  const warehouseId = requestedId || (safeCode ? `WH-${safeCode}` : (normalizedName ? `WH-${stableHash(normalizedName)}` : ''));
  return { warehouseId, warehouseCode, warehouseName, normalizedName };
}

export function warehouseDisplayName(input = {}) {
  return String(input.warehouseName || input.warehouse || input.warehouseCode || '').trim();
}

export function matchWarehouseInput(input, warehouses = [], aliases = []) {
  const identity = warehouseIdentity(typeof input === 'object' ? input : { warehouse: input });
  if (!identity.warehouseId && !identity.warehouseCode && !identity.normalizedName) return null;
  const byId = identity.warehouseId && warehouses.find(row => row.warehouseId === identity.warehouseId);
  if (byId) return byId;
  const byCode = identity.warehouseCode && warehouses.find(row => normalizeWarehouseCode(row.warehouseCode) === identity.warehouseCode);
  if (byCode) return byCode;
  const alias = identity.normalizedName && aliases.find(row => row.normalizedText === identity.normalizedName);
  if (alias) {
    const byAlias = warehouses.find(row => row.warehouseId === alias.warehouseId);
    if (byAlias) return byAlias;
  }
  return identity.normalizedName
    ? warehouses.find(row => row.normalizedName === identity.normalizedName) || null
    : null;
}

export async function loadWarehouseCatalog() {
  await migrateLegacyOrderWarehouses();
  const [warehouses, aliases] = await Promise.all([
    getAll(STORE.WAREHOUSES),
    getAll(STORE.WAREHOUSE_ALIASES)
  ]);
  warehouses.sort((left, right) =>
    String(left.warehouseCode || '').localeCompare(String(right.warehouseCode || ''), 'ko', { numeric: true })
    || String(left.warehouseName || '').localeCompare(String(right.warehouseName || ''), 'ko')
  );
  return { warehouses, aliases };
}

export async function migrateLegacyOrderWarehouses() {
  const db = await openOrderQDb();
  const tx = db.transaction([
    STORE.META,
    STORE.ORDERS,
    STORE.WAREHOUSES,
    STORE.WAREHOUSE_ALIASES
  ], 'readwrite');
  const metaStore = tx.objectStore(STORE.META);
  const migrationKey = 'warehouseLegacyMigrationV5';
  const completed = await requestToPromise(metaStore.get(migrationKey));
  if (completed?.value === true) {
    await transactionDone(tx);
    return;
  }
  const orderStore = tx.objectStore(STORE.ORDERS);
  const orders = await requestToPromise(orderStore.getAll());
  for (const order of orders) {
    if (!warehouseDisplayName(order) && !order.warehouseId) continue;
    const warehouse = await resolveWarehouseInTransaction(tx, order, { sourceType: 'ORDER_LEGACY_MIGRATION', sourceId: order.orderId });
    if (warehouse) orderStore.put({ ...order, ...warehouseSnapshot(order, warehouse) });
  }
  metaStore.put({ key: migrationKey, value: true, updatedAt: nowIso() });
  await transactionDone(tx);
}

function aliasShape(warehouseId, rawText, sourceType, sourceId, timestamp) {
  const normalizedText = normalizeText(rawText);
  return {
    mappingId: `WHA-${stableHash(`${warehouseId}|${normalizedText}`)}`,
    warehouseId,
    rawText: String(rawText || '').trim(),
    normalizedText,
    sourceType,
    sourceId,
    confirmed: true,
    useCount: 1,
    lastUsedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export async function resolveWarehouseInTransaction(tx, input = {}, options = {}) {
  const identity = warehouseIdentity(input);
  if (!identity.warehouseId && !identity.warehouseCode && !identity.normalizedName) return null;

  const sourceType = String(options.sourceType || input.sourceType || 'LOCAL').trim();
  const sourceId = String(options.sourceId || input.sourceId || '').trim();
  const warehouseStore = tx.objectStore(STORE.WAREHOUSES);
  const aliasStore = tx.objectStore(STORE.WAREHOUSE_ALIASES);
  let warehouse = identity.warehouseId
    ? await requestToPromise(warehouseStore.get(identity.warehouseId))
    : null;
  if (!warehouse && identity.warehouseCode) {
    warehouse = await requestToPromise(warehouseStore.index('byCode').get(identity.warehouseCode));
  }
  if (!warehouse && identity.normalizedName) {
    const alias = await requestToPromise(aliasStore.index('byNormalizedText').get(identity.normalizedName));
    if (alias) warehouse = await requestToPromise(warehouseStore.get(alias.warehouseId));
  }
  if (!warehouse && identity.normalizedName) {
    warehouse = await requestToPromise(warehouseStore.index('byNormalizedName').get(identity.normalizedName));
  }

  const timestamp = nowIso();
  if (!warehouse) {
    warehouse = {
      ...identity,
      warehouseType: 'STOCK',
      status: 'ACTIVE',
      sourceType,
      sourceId,
      createdAt: timestamp,
      updatedAt: timestamp
    };
  } else {
    const currentName = String(warehouse.warehouseName || '').trim();
    const currentCode = normalizeWarehouseCode(warehouse.warehouseCode);
    const shouldImproveName = identity.warehouseName
      && (!currentName || normalizeText(currentName) === normalizeText(currentCode));
    warehouse = {
      ...warehouse,
      warehouseCode: currentCode || identity.warehouseCode,
      warehouseName: shouldImproveName ? identity.warehouseName : (currentName || identity.warehouseName),
      normalizedName: normalizeText(shouldImproveName ? identity.warehouseName : (currentName || identity.warehouseName)),
      status: warehouse.status || 'ACTIVE',
      updatedAt: timestamp
    };
  }
  warehouseStore.put(warehouse);

  const aliasTexts = [...new Set([
    identity.warehouseName,
    identity.warehouseCode,
    String(input.warehouse || '').trim()
  ].filter(Boolean))];
  for (const rawText of aliasTexts) {
    const alias = aliasShape(warehouse.warehouseId, rawText, sourceType, sourceId, timestamp);
    const existing = await requestToPromise(aliasStore.get(alias.mappingId));
    aliasStore.put(existing
      ? { ...existing, rawText: alias.rawText, useCount: Number(existing.useCount || 0) + 1, lastUsedAt: timestamp, updatedAt: timestamp }
      : alias);
  }
  return warehouse;
}

export function warehouseSnapshot(input = {}, warehouse = null) {
  const resolved = warehouse || warehouseIdentity(input);
  const legacy = warehouseDisplayName(resolved) || warehouseDisplayName(input);
  return {
    warehouseId: String(resolved?.warehouseId || input.warehouseId || '').trim(),
    warehouseCode: normalizeWarehouseCode(resolved?.warehouseCode || input.warehouseCode || ''),
    warehouseName: String(resolved?.warehouseName || input.warehouseName || legacy).trim(),
    warehouse: legacy
  };
}
