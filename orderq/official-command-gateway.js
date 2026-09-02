import {
  buildFrozenPurchaseIntent,
  buildFrozenSaleIntent,
  findOfficialPurchaseBySource,
  findOfficialSaleBySource,
  loadOfficialPurchaseAggregate,
  loadOfficialSaleAggregate,
  inspectOfficialStocktakeConflicts,
  applyRemotePendingInventoryResolutionPayload,
  runOfficialInventoryRematchCommand,
  runCentralOfficialVoucherCommand,
  saveOfficialVoucherDraft
} from './official-voucher-repository.js?v=0.26.0';
import {
  assertInventoryRematchCommandV2,
  buildInventoryRematchCommandV2
} from './inventory-rematch-core.js?v=0.3.0';
import {
  assertOfficialCommandV2,
  assertOfficialLedgerProjectionV2,
  isOfficialVoucherIdentityV2,
  OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
} from './official-voucher-v2-contract.js?v=0.5.0';
import {
  assertOfficialStocktakeProjectionV2,
  OfficialStocktakeInspectionUnavailableError
} from './stocktake-conflict-v2.js?v=0.2.0';

// The public Gateway surface remains V1. Identity V2 is an additive,
// feature-gated command contract rather than a breaking Gateway API change.
export const OFFICIAL_COMMAND_GATEWAY_VERSION = 'ONEAPP_ORDERQ_OFFICIAL_COMMAND_GATEWAY_V1';

export const OFFICIAL_VOUCHER_V2_FEATURE_GATES = Object.freeze({
  PURCHASE: false,
  SALE: false
});
export const OFFICIAL_INVENTORY_REMATCH_FEATURE_GATE = false;

const repositoryPort = Object.freeze({
  buildFrozenPurchaseIntent,
  buildFrozenSaleIntent,
  findOfficialPurchaseBySource,
  findOfficialSaleBySource,
  loadOfficialPurchaseAggregate,
  loadOfficialSaleAggregate,
  inspectOfficialStocktakeConflicts,
  applyRemotePendingInventoryResolutionPayload,
  runOfficialInventoryRematchCommand,
  runCentralOfficialVoucherCommand,
  saveOfficialVoucherDraft
});

const text = value => String(value ?? '').trim();

function commandKind(source = {}) {
  const command = source.intent || source.commandEnvelope || source.commandSource || source;
  const commandType = text(command?.commandType).toUpperCase();
  if (commandType.endsWith('PURCHASE')) return 'PURCHASE';
  if (commandType.endsWith('SALE')) return 'SALE';
  const explicit = text(source.kind).toUpperCase();
  return ['PURCHASE', 'SALE'].includes(explicit) ? explicit : '';
}

function normalizeFeatureGates(value = {}) {
  return Object.freeze({
    PURCHASE: value.PURCHASE === true || value.purchase === true,
    SALE: value.SALE === true || value.sale === true
  });
}

function validateInventoryRematchBoundary(source, inventoryRematchEnabled) {
  const checked = assertInventoryRematchCommandV2(source);
  if (!inventoryRematchEnabled) throw new Error('ORDERQ_REMATCH_V2_FEATURE_DISABLED');
  return checked;
}

function assertInventoryRematchResult(result, checked) {
  if (text(result?.command?.commandId) !== checked.command.commandId
    || text(result?.command?.commandPayloadDigest) !== checked.payloadDigest
    || text(result?.productResolution?.companyId) !== checked.command.companyId
    || text(result?.productResolution?.unresolvedProductId) !== checked.command.unresolvedProductId
    || text(result?.productResolution?.productId) !== checked.command.selectedProduct.productId) {
    throw new Error('ORDERQ_REMATCH_V2_RESULT_IDENTITY_INVALID');
  }
  const movements = Array.isArray(result?.inventoryMovements) ? result.inventoryMovements : [];
  if (movements.length !== checked.command.expectedEffects.length
    || movements.some(row => text(row.companyId) !== checked.command.companyId
      || text(row.commandId) !== checked.command.commandId
      || text(row.productId) !== checked.command.selectedProduct.productId
      || text(row.effectStatus) === 'RESOLVED_WITHOUT_MOVEMENT_AFTER_STOCKTAKE')) {
    throw new Error('ORDERQ_REMATCH_V2_RESULT_EFFECT_INVALID');
  }
  return result;
}

function validateV2Boundary(source, featureGates) {
  const command = source.intent || source.commandEnvelope || source.commandSource || source;
  const identityVersion = text(command?.identityVersion);
  if (identityVersion && identityVersion !== OFFICIAL_VOUCHER_IDENTITY_VERSION_V2) {
    throw new Error('ORDERQ_OFFICIAL_V2_IDENTITY_VERSION_INVALID');
  }
  if (!isOfficialVoucherIdentityV2(source)) return null;
  const checked = assertOfficialCommandV2(source);
  const explicitKind = text(source.kind).toUpperCase();
  if (explicitKind && explicitKind !== checked.kind) throw new Error('ORDERQ_OFFICIAL_V2_COMMAND_KIND_MISMATCH');
  if (!featureGates[checked.kind]) throw new Error(`ORDERQ_OFFICIAL_V2_${checked.kind}_FEATURE_DISABLED`);
  return checked;
}

// ORDER Q owns this boundary. V1 remains a compatibility path. V2 commands
// are accepted only through independently enabled purchase/sale gates and are
// validated before the Repository repeats the same integrity checks.
export function createOfficialCommandGateway(repository = repositoryPort, options = {}) {
  const requestedFeatureGates = options.featureGates || OFFICIAL_VOUCHER_V2_FEATURE_GATES;
  const featureGates = normalizeFeatureGates(requestedFeatureGates);
  const inventoryRematchEnabled = requestedFeatureGates.INVENTORY_REMATCH === true
    || requestedFeatureGates.inventoryRematch === true;
  return Object.freeze({
    version: OFFICIAL_COMMAND_GATEWAY_VERSION,
    featureGates,
    freezePurchaseIntent: source => repository.buildFrozenPurchaseIntent(source),
    freezeSaleIntent: source => repository.buildFrozenSaleIntent(source),
    findPurchaseBySource: identity => repository.findOfficialPurchaseBySource(identity),
    findSaleBySource: identity => repository.findOfficialSaleBySource(identity),
    loadPurchaseAggregate: documentId => repository.loadOfficialPurchaseAggregate(documentId),
    loadSaleAggregate: documentId => repository.loadOfficialSaleAggregate(documentId),
    inspectStocktakeConflicts(source) {
      const checked = validateV2Boundary(source, featureGates);
      if (!checked) return Promise.resolve({ conflicts: [], identityVersion: '' });
      if (typeof repository.inspectOfficialStocktakeConflicts !== 'function') {
        throw new OfficialStocktakeInspectionUnavailableError();
      }
      return repository.inspectOfficialStocktakeConflicts(source);
    },
    saveDraft(source, actor) {
      const checked = validateV2Boundary(source, featureGates);
      if (checked) {
        if (typeof repository.inspectOfficialStocktakeConflicts !== 'function') {
          throw new OfficialStocktakeInspectionUnavailableError();
        }
        return Promise.resolve(repository.inspectOfficialStocktakeConflicts(source))
          .then(() => repository.saveOfficialVoucherDraft(source, actor));
      }
      return repository.saveOfficialVoucherDraft(source, actor);
    },
    execute(command) {
      const checked = validateV2Boundary(command, featureGates);
      if (checked) {
        if (commandKind(command) !== checked.kind) throw new Error('ORDERQ_OFFICIAL_V2_COMMAND_KIND_MISMATCH');
        if (typeof repository.inspectOfficialStocktakeConflicts !== 'function') {
          throw new OfficialStocktakeInspectionUnavailableError();
        }
      }
      const projected = repository.runCentralOfficialVoucherCommand(command);
      if (!checked) return projected;
      return Promise.resolve(projected).then(result => {
        assertOfficialLedgerProjectionV2(result, checked);
        assertOfficialStocktakeProjectionV2(result, checked.command);
        return result;
      });
    },
    buildInventoryRematchCommand(source) {
      return buildInventoryRematchCommandV2(source);
    },
    executeInventoryRematch(source) {
      if (source?.cancelled === true) {
        return Promise.resolve(Object.freeze({ cancelled: true, duplicate: false, officialWrites: 0 }));
      }
      const checked = validateInventoryRematchBoundary(source, inventoryRematchEnabled);
      if (typeof repository.runOfficialInventoryRematchCommand !== 'function') {
        throw new Error('ORDERQ_REMATCH_V2_REPOSITORY_UNAVAILABLE');
      }
      return Promise.resolve(repository.runOfficialInventoryRematchCommand(checked.command))
        .then(result => assertInventoryRematchResult(result, checked));
    },
    applyRemoteInventoryResolutionPayload(payload) {
      if (typeof repository.applyRemotePendingInventoryResolutionPayload !== 'function') {
        throw new Error('ORDERQ_REMATCH_REMOTE_REPOSITORY_UNAVAILABLE');
      }
      return repository.applyRemotePendingInventoryResolutionPayload(payload);
    }
  });
}

export const OfficialCommandGateway = createOfficialCommandGateway();
