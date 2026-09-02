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

export const OFFICIAL_COMMAND_GATEWAY_VERSION = 'ONEAPP_ORDERQ_OFFICIAL_COMMAND_GATEWAY_V1';

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

// ORDER Q owns this boundary. It intentionally delegates to the current
// repository without changing validation, identity, planning, or transaction
// behavior; those policy changes belong to later SmartInput V2 phases.
export function createOfficialCommandGateway(repository = repositoryPort) {
  return Object.freeze({
    version: OFFICIAL_COMMAND_GATEWAY_VERSION,
    freezePurchaseIntent: source => repository.buildFrozenPurchaseIntent(source),
    freezeSaleIntent: source => repository.buildFrozenSaleIntent(source),
    findPurchaseBySource: identity => repository.findOfficialPurchaseBySource(identity),
    findSaleBySource: identity => repository.findOfficialSaleBySource(identity),
    loadPurchaseAggregate: documentId => repository.loadOfficialPurchaseAggregate(documentId),
    loadSaleAggregate: documentId => repository.loadOfficialSaleAggregate(documentId),
    saveDraft: (source, actor) => repository.saveOfficialVoucherDraft(source, actor),
    execute: command => repository.runCentralOfficialVoucherCommand(command)
  });
}

export const OfficialCommandGateway = createOfficialCommandGateway();
