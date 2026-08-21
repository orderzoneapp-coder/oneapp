import { ORDERQ_DB_VERSION as ORDERQ_V10_DB_VERSION } from './orderq-v10-contracts.js?v=0.16.0';

export const ORDERQ_DB_VERSION = 11;
export const ORDERQ_PREVIOUS_DB_VERSION = ORDERQ_V10_DB_VERSION;

export const V11_STORE = Object.freeze({
  CUSTOMER_HEADER_MAPPINGS: 'customerHeaderMappings',
  CUSTOMER_USER_FIELD_DEFINITIONS: 'customerUserFieldDefinitions'
});

export const V11_STORE_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: V11_STORE.CUSTOMER_HEADER_MAPPINGS,
    options: Object.freeze({ keyPath: 'mappingId' }),
    indexes: Object.freeze([
      Object.freeze({ name: 'bySourceHeader', keyPath: ['sourceSystem', 'normalizedHeader'], options: Object.freeze({ unique: true }) }),
      Object.freeze({ name: 'byTargetField', keyPath: 'targetFieldKey' }),
      Object.freeze({ name: 'byUpdatedAt', keyPath: 'updatedAt' })
    ])
  }),
  Object.freeze({
    name: V11_STORE.CUSTOMER_USER_FIELD_DEFINITIONS,
    options: Object.freeze({ keyPath: 'fieldKey' }),
    indexes: Object.freeze([
      Object.freeze({ name: 'byTypeOrder', keyPath: ['fieldType', 'displayOrder'] }),
      Object.freeze({ name: 'byEnabled', keyPath: 'enabled' }),
      Object.freeze({ name: 'byUpdatedAt', keyPath: 'updatedAt' })
    ])
  })
]);
