import { ORDERQ_DB_VERSION as ORDERQ_V9_DB_VERSION } from './orderq-v9-contracts.js?v=0.12.1';

export const ORDERQ_DB_VERSION = 10;
export const ORDERQ_PREVIOUS_DB_VERSION = ORDERQ_V9_DB_VERSION;

export const V10_STORE = Object.freeze({
  CUSTOMER_SOURCE_LINKS: 'customerSourceLinks',
  CUSTOMER_SOURCE_LINK_EVENTS: 'customerSourceLinkEvents'
});

export const V10_STORE_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: V10_STORE.CUSTOMER_SOURCE_LINKS,
    options: Object.freeze({ keyPath: 'linkId' }),
    indexes: Object.freeze([
      Object.freeze({ name: 'bySourceLinkKey', keyPath: 'sourceLinkKey', options: Object.freeze({ unique: true }) }),
      Object.freeze({ name: 'byCustomerId', keyPath: 'customerId' }),
      Object.freeze({ name: 'bySourceSystem', keyPath: 'sourceSystem' }),
      Object.freeze({ name: 'byLinkStatus', keyPath: 'linkStatus' }),
      Object.freeze({ name: 'byUpdatedAt', keyPath: 'updatedAt' })
    ])
  }),
  Object.freeze({
    name: V10_STORE.CUSTOMER_SOURCE_LINK_EVENTS,
    options: Object.freeze({ keyPath: 'eventId' }),
    indexes: Object.freeze([
      Object.freeze({ name: 'byLinkId', keyPath: 'linkId' }),
      Object.freeze({ name: 'byEventType', keyPath: 'eventType' }),
      Object.freeze({ name: 'byOccurredAt', keyPath: 'occurredAt' })
    ])
  })
]);
