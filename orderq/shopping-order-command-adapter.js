import {
  SHOPPING_ORDER_DEDUPE_SCHEMA,
  SHOPPING_ORDER_HEADERS,
  buildShoppingOrderCandidates,
  validateShoppingOrderHeaders
} from './shopping-order-dedupe-core.js?v=0.2.0';
import {
  SHOPPING_ORDER_IMPORT_REPOSITORY_VERSION,
  commitShoppingOrderCandidates,
  inspectShoppingOrderCandidates
} from './shopping-order-import-repository.js?v=0.1.0';

export const SHOPPING_ORDER_COMMAND_ADAPTER_VERSION = 'ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER_V1';

const text = value => String(value ?? '').trim();

function validateRequest(request = {}) {
  if (request.schemaVersion !== SHOPPING_ORDER_DEDUPE_SCHEMA) throw new Error('SHOPPING_ORDER_REQUEST_SCHEMA_INVALID');
  const companyId = text(request.companyId);
  if (!companyId) throw new Error('SHOPPING_ORDER_COMPANY_REQUIRED');
  if (!Array.isArray(request.candidates)) throw new Error('SHOPPING_ORDER_CANDIDATES_REQUIRED');
  request.candidates.forEach((candidate, index) => {
    if (text(candidate.companyId) !== companyId) throw new Error(`SHOPPING_ORDER_COMPANY_SCOPE_INVALID:${index + 1}`);
  });
  return companyId;
}

function requestOptions(request, companyId) {
  return {
    defaultCompanyId: companyId,
    actor: text(request.actor || 'SMART_INPUT_ADMIN')
  };
}

export function createShoppingOrderCandidates(sourceRows = [], options = {}) {
  return buildShoppingOrderCandidates(sourceRows, options);
}

export function isExactShoppingOrderSource(headers = []) {
  return validateShoppingOrderHeaders(headers).length === 0;
}

export async function inspectShoppingOrderImport(request = {}) {
  const companyId = validateRequest(request);
  return inspectShoppingOrderCandidates(request.candidates, requestOptions(request, companyId));
}

export async function commitShoppingOrderImport(request = {}) {
  const companyId = validateRequest(request);
  return commitShoppingOrderCandidates(request.candidates, requestOptions(request, companyId));
}

export function shoppingOrderCapability() {
  return Object.freeze({
    ready: true,
    adapterVersion: SHOPPING_ORDER_COMMAND_ADAPTER_VERSION,
    repositoryVersion: SHOPPING_ORDER_IMPORT_REPOSITORY_VERSION,
    schemaVersion: SHOPPING_ORDER_DEDUPE_SCHEMA,
    sourceHeaders: [...SHOPPING_ORDER_HEADERS],
    localActualLedgerOnly: true,
    multiDeviceGlobalDedupe: false
  });
}

export const ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER = Object.freeze({
  version: SHOPPING_ORDER_COMMAND_ADAPTER_VERSION,
  schemaVersion: SHOPPING_ORDER_DEDUPE_SCHEMA,
  capability: shoppingOrderCapability,
  isExactSource: isExactShoppingOrderSource,
  createCandidates: createShoppingOrderCandidates,
  inspect: inspectShoppingOrderImport,
  commit: commitShoppingOrderImport
});

if (typeof window !== 'undefined') {
  window.ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER = ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER;
}
