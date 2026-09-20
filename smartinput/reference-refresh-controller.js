import { loadWarehouseCatalog } from './legacy-integration-adapter.js?v=0.4.0';
import { loadFieldDefinitions, loadSettingValue } from './smartinput-data-store.js?v=0.15.0';
import { ensureFieldCatalogSeed } from './field-registry.js?v=0.3.0';
import { loadReferenceDomain } from './reference-data-controller.js?v=0.1.1';
import {
  beginReferenceGeneration,
  buildReferenceGeneration,
  commitReferenceGeneration,
  failReferenceGeneration,
  loadActiveReferenceGeneration,
  normalizeReferenceDomainSnapshot,
  REFERENCE_DOMAINS,
  REFERENCE_GENERATION_SCHEMA
} from './reference-generation-repository.js?v=0.2.0';

const text = value => String(value ?? '').trim();

function generationId() {
  const token = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `REFGEN-${token}`;
}

// Independent work reads only a complete generation already activated in this app.
// The legacy owner catalog also migrates orders, so it is reserved for explicit refresh.
export async function loadLocalWarehouseCatalog(companyId, { loadGeneration = loadActiveReferenceGeneration } = {}) {
  const company = text(companyId);
  const stored = await loadGeneration(company);
  if (!stored) throw new Error('로컬 창고 기준정보가 없습니다. 기준정보 갱신을 실행하세요. 입력과 자동저장은 계속 사용할 수 있습니다.');
  const { generation, entities } = stored;
  if (generation?.schemaVersion !== REFERENCE_GENERATION_SCHEMA || generation.status !== 'ACTIVE'
    || generation.companyId !== company || !Array.isArray(entities)
    || entities.some(row => row.companyId !== company || row.generationId !== generation.generationId)) {
    throw new Error('SMARTINPUT_LOCAL_REFERENCE_SCOPE_INVALID');
  }
  for (const domain of REFERENCE_DOMAINS) {
    const metadata = generation.domains?.[domain];
    const count = entities.filter(row => row.domain === domain).length;
    if (!metadata || !['READY', 'EMPTY'].includes(metadata.status) || metadata.count !== count
      || (metadata.status === 'EMPTY') !== (count === 0)) throw new Error('SMARTINPUT_LOCAL_REFERENCE_GENERATION_INVALID');
  }
  const warehouses = entities.filter(row => row.domain === 'warehouse').map(row => row.value);
  const normalized = normalizeReferenceDomainSnapshot('warehouse', { rows: warehouses }, company);
  if (normalized.contentHash !== generation.domains.warehouse.contentHash) throw new Error('SMARTINPUT_LOCAL_WAREHOUSE_CONTENT_CHANGED');
  return {
    warehouses,
    aliases: warehouses.flatMap(row => Array.isArray(row.referenceAliases) ? row.referenceAliases.filter(alias => alias.warehouseId === row.warehouseId) : []),
    aliasesAvailable: warehouses.every(row => Array.isArray(row.referenceAliases)),
    revision: generation.domains.warehouse.ownerRevision,
    generationId: generation.generationId
  };
}

function sessionEmployee() {
  try {
    const bundle = JSON.parse(sessionStorage.getItem('oneapp.nexus.home.session.v1') || 'null');
    const user = bundle?.session?.user;
    if (!text(user?.loginId)) return [];
    return [{
      userId: text(user.userId),
      loginId: text(user.loginId),
      employeeCode: text(user.loginId),
      displayName: text(user.displayName || user.loginId),
      status: 'ACTIVE',
      revision: Number(user.version || 0)
    }];
  } catch {
    return [];
  }
}

export async function readAllReferenceSnapshots({ companyId, referenceLoader = loadReferenceDomain, warehouseLoader = loadWarehouseCatalog } = {}) {
  const seed = await ensureFieldCatalogSeed({ force: true });
  const [product, customer, warehouseCatalog] = await Promise.all([
    referenceLoader('product', { allowFallback: false }),
    referenceLoader('customer', { allowFallback: false }),
    warehouseLoader()
  ]);
  if (product.status === 'ERROR') throw new Error(product.error?.message || 'PRODUCT_REFERENCE_REFRESH_FAILED');
  if (customer.status === 'ERROR') throw new Error(customer.error?.message || 'CUSTOMER_REFERENCE_REFRESH_FAILED');
  const fieldDefinitions = await loadFieldDefinitions(seed.metadata.generationId);
  return {
    product: { status: product.status, rows: product.rows, revision: product.revision, contentHash: product.contentHash },
    customer: { status: customer.status, rows: customer.rows, revision: customer.revision, contentHash: customer.contentHash },
    warehouse: {
      status: warehouseCatalog.warehouses?.length ? 'READY' : 'EMPTY',
      rows: (warehouseCatalog.warehouses || []).map(row => ({
        ...row,
        referenceAliases: (warehouseCatalog.aliases || []).filter(alias => alias.warehouseId === row.warehouseId)
      })),
      revision: warehouseCatalog.revision || warehouseCatalog.updatedAt || '0'
    },
    employee: { status: sessionEmployee().length ? 'READY' : 'EMPTY', rows: sessionEmployee(), revision: 'NEXUS-SESSION' },
    project: { status: 'EMPTY', rows: [], revision: '0' },
    fieldDefinition: {
      status: fieldDefinitions.length ? 'READY' : 'EMPTY',
      rows: fieldDefinitions,
      revision: seed.metadata.sourceSha256,
      contentHash: seed.metadata.sourceSha256
    },
    companyId,
    previousGenerationId: (await loadSettingValue(`referenceActive:${companyId}`))?.generationId || ''
  };
}

export async function refreshAllReferenceData({ companyId, snapshotLoader = readAllReferenceSnapshots } = {}) {
  const id = generationId();
  const startedAt = new Date().toISOString();
  const staging = await beginReferenceGeneration(companyId, id, startedAt);
  try {
    const snapshots = await snapshotLoader({ companyId });
    const bundle = buildReferenceGeneration({ companyId, generationId: id, snapshots, startedAt });
    const generation = await commitReferenceGeneration(bundle);
    globalThis.dispatchEvent?.(new CustomEvent('smartinput:reference-generation-activated', {
      detail: { generation, domains: generation.domains }
    }));
    return { generation, entities: bundle.entities };
  } catch (error) {
    await failReferenceGeneration(staging, error);
    throw error;
  }
}
