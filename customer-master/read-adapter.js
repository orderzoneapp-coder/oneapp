import { APP_ID, SNAPSHOT_SCHEMA_VERSION, CUSTOMER_STATUS, clean, searchCustomerRows, sha256Hex } from './core.js';
import { STORE, getByKey } from './db.js';
import { listCustomerData } from './repository.js';

export const CUSTOMER_READ_ADAPTER_VERSION = 'ONEAPP_CUSTOMER_READ_ADAPTER_V1';

function projectCustomer(customer) {
  return {
    customerId: customer.customerId,
    customerCode: customer.customerCode || '',
    customerName: customer.customerName || '',
    status: customer.status,
    qualityStatus: customer.qualityStatus,
    representativeName: customer.representativeName || '',
    businessNumber: customer.businessNumber || '',
    phone: customer.phone || '',
    mobile: customer.mobile || '',
    address: customer.address || '',
    addressDetail: customer.addressDetail || '',
    contactName: customer.contactName || '',
    contactPhone: customer.contactPhone || '',
    group1Code: customer.group1Code || '',
    group1Name: customer.group1Name || '',
    group2Code: customer.group2Code || '',
    group2Name: customer.group2Name || '',
    priceGroupCode: customer.priceGroupCode || '',
    priceGroup: customer.priceGroup || '',
    revision: Number(customer.revision || 1),
    updatedAt: customer.updatedAt || '',
  };
}

export async function getCustomerSnapshot({ includeInactive = true } = {}) {
  const [{ customers, aliases, sourceLinks }, head] = await Promise.all([
    listCustomerData(), getByKey(STORE.META, 'headRevision'),
  ]);
  const selected = customers.filter((customer) => customer.status !== CUSTOMER_STATUS.DELETED)
    .filter((customer) => includeInactive || customer.status === CUSTOMER_STATUS.ACTIVE)
    .map(projectCustomer)
    .sort((left, right) => String(left.customerId).localeCompare(String(right.customerId)));
  const customerIds = new Set(selected.map((customer) => customer.customerId));
  const data = {
    customers: selected,
    aliases: aliases.filter((row) => customerIds.has(row.customerId) && row.active !== false)
      .map((row) => ({ customerId: row.customerId, alias: row.alias || row.rawText || '', normalizedText: row.normalizedText || '', source: row.source || '' })),
    sourceLinks: sourceLinks.filter((row) => customerIds.has(row.customerId) && row.active !== false)
      .map((row) => ({ customerId: row.customerId, sourceSystem: row.sourceSystem, sourceCustomerCode: row.sourceCustomerCode, sourceCustomerName: row.sourceCustomerName || '', revision: Number(row.revision || 1) })),
  };
  const revision = Number(head?.value || 0);
  const contentHash = await sha256Hex(data);
  return Object.freeze({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    adapterVersion: CUSTOMER_READ_ADAPTER_VERSION,
    ownerAppId: APP_ID,
    snapshotId: `CUSTOMER-${revision}-${contentHash.slice(0, 12)}`,
    snapshotVersion: revision,
    snapshotCreatedAt: new Date().toISOString(),
    contentHash,
    data,
  });
}

export async function findCustomers(query, { limit = 20, includeInactive = false } = {}) {
  const { customers, aliases, sourceLinks } = await listCustomerData();
  return searchCustomerRows(
    customers.filter((customer) => customer.status !== CUSTOMER_STATUS.DELETED)
      .filter((customer) => includeInactive || customer.status === CUSTOMER_STATUS.ACTIVE),
    aliases,
    sourceLinks,
    clean(query),
    limit,
  ).map(projectCustomer);
}

export const customerReadAdapter = Object.freeze({
  version: CUSTOMER_READ_ADAPTER_VERSION,
  getSnapshot: getCustomerSnapshot,
  search: findCustomers,
});

globalThis.ONEAPP_CUSTOMER_MASTER_READ_ADAPTER = customerReadAdapter;
