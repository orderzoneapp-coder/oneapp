import { ORDERQ_DB_VERSION as ORDERQ_V7_DB_VERSION } from './orderq-v7-contracts.js?v=0.8.0';

export const ORDERQ_DB_VERSION = 8;
export const ORDERQ_PREVIOUS_DB_VERSION = ORDERQ_V7_DB_VERSION;

export const V8_STORE = Object.freeze({
  INTAKE_SESSIONS: 'intakeSessions',
  INTAKE_SOURCE_PARTS: 'intakeSourceParts',
  INTAKE_DOCUMENTS: 'intakeDocuments',
  INTAKE_LINES: 'intakeLines',
  INTAKE_EVENTS: 'intakeEvents'
});

const index = (name, keyPath, options = {}) => Object.freeze({
  name,
  keyPath,
  options: Object.freeze({ ...options })
});

export const V8_STORE_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: V8_STORE.INTAKE_SESSIONS,
    keyPath: 'intakeSessionId',
    indexes: Object.freeze([
      index('bySourceOccurrenceKey', 'sourceOccurrenceKey', { unique: true }),
      index('byRawFingerprint', 'rawFingerprint'),
      index('byStageUpdatedAt', ['stage', 'updatedAt'])
    ])
  }),
  Object.freeze({
    name: V8_STORE.INTAKE_SOURCE_PARTS,
    keyPath: 'sourcePartId',
    indexes: Object.freeze([
      index('bySession', 'intakeSessionId'),
      index('bySourceMessageKey', 'sourceMessageKey'),
      index('byContentHash', 'contentHash')
    ])
  }),
  Object.freeze({
    name: V8_STORE.INTAKE_DOCUMENTS,
    keyPath: 'intakeDocumentId',
    indexes: Object.freeze([
      index('bySession', 'intakeSessionId'),
      index('bySourceDocumentKey', 'sourceDocumentKey', { unique: true }),
      index('byReviewStatus', 'reviewStatus'),
      index('byOrderId', 'orderId')
    ])
  }),
  Object.freeze({
    name: V8_STORE.INTAKE_LINES,
    keyPath: 'intakeLineId',
    indexes: Object.freeze([
      index('byDocument', 'intakeDocumentId'),
      index('bySourcePart', 'sourcePartId'),
      index('byMatchStatus', 'matchStatus'),
      index('byReviewStatus', 'reviewStatus'),
      index('byProductIdentityStatus', 'productIdentityStatus')
    ])
  }),
  Object.freeze({
    name: V8_STORE.INTAKE_EVENTS,
    keyPath: 'eventId',
    indexes: Object.freeze([
      index('bySession', 'intakeSessionId'),
      index('byDocument', 'intakeDocumentId'),
      index('byLine', 'intakeLineId'),
      index('byOccurredAt', 'occurredAt')
    ])
  })
]);

export const INTAKE_CONTRACT_VERSION = 'ORDER_INTAKE_V1';
export const ORDER_SOURCE_DOCUMENT_CANONICAL_VERSION = 'ORDER_SOURCE_DOCUMENT_CANONICAL_V1';
export const SOURCE_OCCURRENCE_KEY_VERSION = 'ORDER_SOURCE_OCCURRENCE_V1';
export const SOURCE_DOCUMENT_KEY_VERSION = 'ORDER_SOURCE_DOCUMENT_V1';
export const SOURCE_LINE_KEY_VERSION = 'ORDER_SOURCE_LINE_V1';

export const INTAKE_SESSION_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  COMMITTED: 'COMMITTED',
  EXCLUDED: 'EXCLUDED'
});

export const INTAKE_STAGE = Object.freeze({
  CAPTURED: 'CAPTURED',
  EXTRACTION_REVIEW: 'EXTRACTION_REVIEW',
  MATCH_REVIEW: 'MATCH_REVIEW',
  DOCUMENT_REVIEW: 'DOCUMENT_REVIEW',
  COMMITTED: 'COMMITTED'
});

export const INTAKE_REVIEW_STATUS = Object.freeze({
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  EXCLUDED: 'EXCLUDED'
});

export const PRODUCT_IDENTITY_STATUS = Object.freeze({
  MASTER_LINKED: 'MASTER_LINKED',
  TEMPORARY_CONFIRMED: 'TEMPORARY_CONFIRMED',
  UNRESOLVED: 'UNRESOLVED'
});
