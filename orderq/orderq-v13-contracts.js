import { ORDERQ_DB_VERSION as ORDERQ_V12_DB_VERSION } from './orderq-v12-contracts.js?v=0.17.0';

export const ORDERQ_DB_VERSION = 13;
export const ORDERQ_PREVIOUS_DB_VERSION = ORDERQ_V12_DB_VERSION;
export const V13_PURCHASE_DOCUMENT_INDEXES = Object.freeze([
  Object.freeze({ name: 'byOriginRunDocument', keyPath: Object.freeze(['originSystem', 'originTransactionId', 'sourceDocumentKey']), options: Object.freeze({ unique: true }) }),
  Object.freeze({ name: 'byOriginExternalDocument', keyPath: Object.freeze(['originSystem', 'externalDocumentNo']), options: Object.freeze({ unique: false }) })
]);
