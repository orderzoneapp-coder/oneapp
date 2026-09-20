import {
  SHOPPING_ORDER_DEDUPE_SCHEMA,
  SHOPPING_ORDER_HEADERS,
  buildShoppingOrderCandidates,
  validateShoppingOrderHeaders
} from './shopping-order-dedupe-core.js?v=0.2.1';

export { SHOPPING_ORDER_DEDUPE_SCHEMA, SHOPPING_ORDER_HEADERS };
export const SHOPPING_ORDER_SOURCE_ADAPTER_VERSION = 'ONEAPP_ORDERQ_SHOPPING_ORDER_SOURCE_ADAPTER_V1';

// Public owner contract for local source preparation only. Ledger inspection and
// commit remain exclusively on the separate command adapter.
export function createShoppingOrderCandidates(sourceRows = [], options = {}) {
  return buildShoppingOrderCandidates(sourceRows, options);
}

export function isExactShoppingOrderSource(headers = []) {
  return validateShoppingOrderHeaders(headers).length === 0;
}

export const ONEAPP_ORDERQ_SHOPPING_ORDER_SOURCE_ADAPTER = Object.freeze({
  version: SHOPPING_ORDER_SOURCE_ADAPTER_VERSION,
  schemaVersion: SHOPPING_ORDER_DEDUPE_SCHEMA,
  capability: () => Object.freeze({ schemaVersion: SHOPPING_ORDER_DEDUPE_SCHEMA, sourceHeaders: [...SHOPPING_ORDER_HEADERS] }),
  isExactSource: isExactShoppingOrderSource,
  createCandidates: createShoppingOrderCandidates
});
