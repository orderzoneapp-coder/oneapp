import { ORDERQ_DB_VERSION as ORDERQ_V8_DB_VERSION } from './orderq-v8-contracts.js?v=0.11.0';

export const ORDERQ_DB_VERSION = 9;
export const ORDERQ_PREVIOUS_DB_VERSION = ORDERQ_V8_DB_VERSION;

export const V9_STORE = Object.freeze({
  CUSTOMER_EVENTS: 'customerEvents'
});

export const V9_STORE_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: V9_STORE.CUSTOMER_EVENTS,
    options: Object.freeze({ keyPath: 'eventId' }),
    indexes: Object.freeze([
      Object.freeze({ name: 'byCustomerId', keyPath: 'customerId' }),
      Object.freeze({ name: 'byEventType', keyPath: 'eventType' }),
      Object.freeze({ name: 'byOccurredAt', keyPath: 'occurredAt' })
    ])
  })
]);
