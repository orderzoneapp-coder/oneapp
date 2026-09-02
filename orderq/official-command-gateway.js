import {
  buildFrozenPurchaseIntent,
  buildFrozenSaleIntent,
  findOfficialPurchaseBySource,
  findOfficialSaleBySource,
  loadOfficialPurchaseAggregate,
  loadOfficialSaleAggregate,
  runCentralOfficialVoucherCommand,
  saveOfficialVoucherDraft
} from './official-voucher-repository.js?v=0.21.0';
import {
  assertOfficialCommandV2,
  isOfficialVoucherIdentityV2,
  OFFICIAL_VOUCHER_IDENTITY_VERSION_V2
} from './official-voucher-v2-contract.js?v=0.1.0';

// The public Gateway surface remains V1. Identity V2 is an additive,
// feature-gated command contract rather than a breaking Gateway API change.
export const OFFICIAL_COMMAND_GATEWAY_VERSION = 'ONEAPP_ORDERQ_OFFICIAL_COMMAND_GATEWAY_V1';

export const OFFICIAL_VOUCHER_V2_FEATURE_GATES = Object.freeze({
  PURCHASE: false,
  SALE: false
});

const repositoryPort = Object.freeze({
  buildFrozenPurchaseIntent,
  buildFrozenSaleIntent,
  findOfficialPurchaseBySource,
  findOfficialSaleBySource,
  loadOfficialPurchaseAggregate,
  loadOfficialSaleAggregate,
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
  const featureGates = normalizeFeatureGates(options.featureGates || OFFICIAL_VOUCHER_V2_FEATURE_GATES);
  return Object.freeze({
    version: OFFICIAL_COMMAND_GATEWAY_VERSION,
    featureGates,
    freezePurchaseIntent: source => repository.buildFrozenPurchaseIntent(source),
    freezeSaleIntent: source => repository.buildFrozenSaleIntent(source),
    findPurchaseBySource: identity => repository.findOfficialPurchaseBySource(identity),
    findSaleBySource: identity => repository.findOfficialSaleBySource(identity),
    loadPurchaseAggregate: documentId => repository.loadOfficialPurchaseAggregate(documentId),
    loadSaleAggregate: documentId => repository.loadOfficialSaleAggregate(documentId),
    saveDraft(source, actor) {
      validateV2Boundary(source, featureGates);
      return repository.saveOfficialVoucherDraft(source, actor);
    },
    execute(command) {
      const checked = validateV2Boundary(command, featureGates);
      if (checked && commandKind(command) !== checked.kind) throw new Error('ORDERQ_OFFICIAL_V2_COMMAND_KIND_MISMATCH');
      return repository.runCentralOfficialVoucherCommand(command);
    }
  });
}

export const OfficialCommandGateway = createOfficialCommandGateway();
