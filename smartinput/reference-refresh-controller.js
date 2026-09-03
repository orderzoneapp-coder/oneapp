import { loadWarehouseCatalog } from './legacy-integration-adapter.js?v=0.3.0';
import { loadFieldDefinitions, loadSettingValue } from './smartinput-data-store.js?v=0.6.0';
import { ensureFieldCatalogSeed } from './field-registry.js?v=0.1.0';
import { loadReferenceDomain } from './reference-data-controller.js?v=0.1.1';
import {
  beginReferenceGeneration,
  buildReferenceGeneration,
  commitReferenceGeneration,
  failReferenceGeneration
} from './reference-generation-repository.js?v=0.1.0';

const text = value => String(value ?? '').trim();

function generationId() {
  const token = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `REFGEN-${token}`;
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
      rows: warehouseCatalog.warehouses || [],
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
