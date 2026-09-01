import { canonicalSha256 } from '../orderq/official-voucher-core.js?v=0.20.0';
import {
  activateReferenceGeneration,
  loadActiveReferenceGeneration,
  saveReferenceGenerationState
} from './smartinput-data-store.js?v=0.6.0';

export const REFERENCE_GENERATION_SCHEMA = 'ONEAPP_REFERENCE_GENERATION_V1';
export const REFERENCE_DOMAINS = Object.freeze(['customer', 'product', 'warehouse', 'employee', 'project', 'fieldDefinition']);

const text = value => String(value ?? '').normalize('NFKC').trim();
const clone = value => JSON.parse(JSON.stringify(value));

export function referenceEntityId(domain, row = {}) {
  const fields = {
    customer: ['customerId', 'customerCode'],
    product: ['productId', 'masterProductId', 'itemCode'],
    warehouse: ['warehouseId', 'warehouseCode'],
    employee: ['loginId', 'userId'],
    project: ['projectId', 'projectCode'],
    fieldDefinition: ['fieldId']
  }[domain] || [];
  const id = fields.map(field => text(row[field])).find(Boolean);
  if (!id) throw new Error(`SMARTINPUT_REFERENCE_ENTITY_ID_REQUIRED:${domain}`);
  return id;
}

export function normalizeReferenceDomainSnapshot(domain, snapshot = {}, companyId) {
  if (!REFERENCE_DOMAINS.includes(domain)) throw new Error(`SMARTINPUT_REFERENCE_DOMAIN_INVALID:${domain}`);
  const status = text(snapshot.status || (snapshot.rows?.length ? 'READY' : 'EMPTY')).toUpperCase();
  if (!['READY', 'EMPTY'].includes(status)) throw new Error(`SMARTINPUT_REFERENCE_DOMAIN_ERROR:${domain}`);
  const rows = clone(Array.isArray(snapshot.rows) ? snapshot.rows : []);
  if (status === 'EMPTY' && rows.length) throw new Error(`SMARTINPUT_REFERENCE_EMPTY_HAS_ROWS:${domain}`);
  const ids = new Set();
  const entities = rows.map(row => {
    const entityId = referenceEntityId(domain, row);
    if (ids.has(entityId)) throw new Error(`SMARTINPUT_REFERENCE_ENTITY_DUPLICATED:${domain}:${entityId}`);
    ids.add(entityId);
    const code = text(row.customerCode || row.itemCode || row.warehouseCode || row.loginId || row.projectCode || row.sourceFieldCode);
    const searchText = [code, row.customerName, row.itemName, row.warehouseName, row.displayName,
      row.projectName, row.displayLabel, row.advancedLabel].map(text).filter(Boolean).join(' ').toLocaleLowerCase('ko');
    return { companyId, domain, entityId, code, searchText, value: row };
  });
  const contentHash = text(snapshot.contentHash) || canonicalSha256(rows);
  return {
    domain,
    status: rows.length ? 'READY' : 'EMPTY',
    ownerRevision: text(snapshot.ownerRevision ?? snapshot.revision ?? snapshot.snapshotId ?? '0'),
    count: rows.length,
    contentHash,
    entities
  };
}

export function buildReferenceGeneration({ companyId, generationId, snapshots = {}, startedAt = new Date().toISOString() } = {}) {
  const company = text(companyId);
  const id = text(generationId);
  if (!company) throw new Error('SMARTINPUT_REFERENCE_COMPANY_REQUIRED');
  if (!id) throw new Error('SMARTINPUT_REFERENCE_GENERATION_ID_REQUIRED');
  const domains = {};
  const entities = [];
  REFERENCE_DOMAINS.forEach(domain => {
    if (!snapshots[domain]) throw new Error(`SMARTINPUT_REFERENCE_DOMAIN_MISSING:${domain}`);
    const normalized = normalizeReferenceDomainSnapshot(domain, snapshots[domain], company);
    domains[domain] = {
      status: normalized.status,
      ownerRevision: normalized.ownerRevision,
      count: normalized.count,
      contentHash: normalized.contentHash
    };
    normalized.entities.forEach(row => entities.push({ ...row, generationId: id }));
  });
  const completedAt = new Date().toISOString();
  return {
    generation: {
      schemaVersion: REFERENCE_GENERATION_SCHEMA,
      generationId: id,
      companyId: company,
      status: 'STAGED',
      domains,
      startedAt,
      completedAt,
      activatedAt: ''
    },
    entities
  };
}

export async function beginReferenceGeneration(companyId, generationId, startedAt = new Date().toISOString()) {
  const generation = {
    schemaVersion: REFERENCE_GENERATION_SCHEMA,
    generationId,
    companyId,
    status: 'STAGING',
    domains: {},
    startedAt,
    completedAt: '',
    activatedAt: ''
  };
  await saveReferenceGenerationState(generation);
  return generation;
}

export async function failReferenceGeneration(generation, error) {
  const failed = {
    ...generation,
    status: 'FAILED',
    completedAt: new Date().toISOString(),
    error: { code: text(error?.code || error?.message || 'REFERENCE_REFRESH_FAILED'), message: text(error?.message || error) }
  };
  await saveReferenceGenerationState(failed);
  return failed;
}

export async function commitReferenceGeneration(bundle) {
  return activateReferenceGeneration(bundle);
}

export { loadActiveReferenceGeneration };
