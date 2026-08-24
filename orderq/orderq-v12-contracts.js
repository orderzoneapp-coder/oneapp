import { ORDERQ_DB_VERSION as ORDERQ_V11_DB_VERSION } from './orderq-v11-contracts.js?v=0.16.0';

export const ORDERQ_DB_VERSION = 12;
export const ORDERQ_PREVIOUS_DB_VERSION = ORDERQ_V11_DB_VERSION;

export const V12_STORE = Object.freeze({
  VOUCHER_EVENTS: 'voucherEvents',
  RECEIVABLE_ENTRIES: 'receivableEntries',
  PAYABLE_ENTRIES: 'payableEntries'
});

const index = (name, keyPath, options = {}) => Object.freeze({ name, keyPath, options: Object.freeze({ ...options }) });

export const V12_STORE_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: V12_STORE.VOUCHER_EVENTS,
    options: Object.freeze({ keyPath: 'eventId' }),
    indexes: Object.freeze([
      index('byDocumentRevision', ['documentType', 'documentId', 'sourceDocumentRevision'], { unique: true }),
      index('byCommandId', 'commandId', { unique: true }),
      index('byIdempotencyKey', 'idempotencyKey', { unique: true }),
      index('byEventType', 'eventType'),
      index('byPartnerOccurredAt', ['partnerId', 'occurredAt']),
      index('byLedgerSequence', 'ledgerSequence', { unique: true }),
      index('byReversalOf', 'reversalOf')
    ])
  }),
  Object.freeze({
    name: V12_STORE.RECEIVABLE_ENTRIES,
    options: Object.freeze({ keyPath: 'entryId' }),
    indexes: Object.freeze([
      index('byDocumentRevision', ['salesDocumentId', 'sourceDocumentRevision']),
      index('byPartnerId', 'partnerId'),
      index('byCommandId', 'commandId'),
      index('byIdempotencyKey', 'idempotencyKey'),
      index('byEffectKey', 'effectKey', { unique: true }),
      index('byEntryType', 'entryType'),
      index('byPartnerOccurredAt', ['partnerId', 'occurredAt']),
      index('byLedgerSequence', 'ledgerSequence', { unique: true }),
      index('byReversalOf', 'reversalOf'),
      index('byBusinessEffect', ['salesDocumentId', 'sourceDocumentRevision', 'entryType', 'effectOrdinal', 'partnerId'], { unique: true })
    ])
  }),
  Object.freeze({
    name: V12_STORE.PAYABLE_ENTRIES,
    options: Object.freeze({ keyPath: 'entryId' }),
    indexes: Object.freeze([
      index('byDocumentRevision', ['purchaseDocumentId', 'sourceDocumentRevision']),
      index('byPartnerId', 'partnerId'),
      index('byCommandId', 'commandId'),
      index('byIdempotencyKey', 'idempotencyKey'),
      index('byEffectKey', 'effectKey', { unique: true }),
      index('byEntryType', 'entryType'),
      index('byPartnerOccurredAt', ['partnerId', 'occurredAt']),
      index('byLedgerSequence', 'ledgerSequence', { unique: true }),
      index('byReversalOf', 'reversalOf'),
      index('byBusinessEffect', ['purchaseDocumentId', 'sourceDocumentRevision', 'entryType', 'effectOrdinal', 'partnerId'], { unique: true })
    ])
  })
]);

export const V12_SYNC_ENTITY_CONTRACT = Object.freeze({
  VOUCHER_EVENT: Object.freeze({ storeName: V12_STORE.VOUCHER_EVENTS, idField: 'eventId' }),
  RECEIVABLE_ENTRY: Object.freeze({ storeName: V12_STORE.RECEIVABLE_ENTRIES, idField: 'entryId' }),
  PAYABLE_ENTRY: Object.freeze({ storeName: V12_STORE.PAYABLE_ENTRIES, idField: 'entryId' })
});
