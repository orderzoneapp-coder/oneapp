import {
  OFFICIAL_COMMAND_GATEWAY_VERSION,
  OfficialCommandGateway
} from './official-command-gateway.js?v=0.4.0';

export const OFFICIAL_COMMAND_ADAPTER_VERSION = 'ONEAPP_ORDERQ_OFFICIAL_COMMAND_ADAPTER_V1';

export function createOfficialCommandAdapter(gateway = OfficialCommandGateway) {
  return Object.freeze({
    version: OFFICIAL_COMMAND_ADAPTER_VERSION,
    gatewayVersion: OFFICIAL_COMMAND_GATEWAY_VERSION,
    freezePurchaseIntent: source => gateway.freezePurchaseIntent(source),
    freezeSaleIntent: source => gateway.freezeSaleIntent(source),
    async findPurchaseCommandContext(identity) {
      const document = await gateway.findPurchaseBySource(identity);
      const aggregate = document ? await gateway.loadPurchaseAggregate(document.purchaseDocumentId) : null;
      return { document, aggregate };
    },
    async findSaleCommandContext(identity) {
      const document = await gateway.findSaleBySource(identity);
      const aggregate = document ? await gateway.loadSaleAggregate(document.salesDocumentId) : null;
      return { document, aggregate };
    },
    loadPurchaseCommandAggregate: documentId => gateway.loadPurchaseAggregate(documentId),
    loadSaleCommandAggregate: documentId => gateway.loadSaleAggregate(documentId),
    inspectStocktakeConflicts: source => gateway.inspectStocktakeConflicts(source),
    beginPurchaseCommand: (draft, actor) => gateway.saveDraft({
      kind: 'PURCHASE',
      ...draft,
      purchaseDocumentId: draft.purchaseDocumentId
    }, actor),
    beginSaleCommand: (draft, actor) => gateway.saveDraft({
      kind: 'SALE',
      ...draft,
      salesDocumentId: draft.salesDocumentId
    }, actor),
    commitPurchaseCommand: command => gateway.execute(command),
    commitSaleCommand: command => gateway.execute(command)
  });
}

export const OfficialCommandAdapter = createOfficialCommandAdapter();

export const freezePurchaseCommandIntent = source => OfficialCommandAdapter.freezePurchaseIntent(source);
export const freezeSaleCommandIntent = source => OfficialCommandAdapter.freezeSaleIntent(source);
export const findPurchaseCommandContext = identity => OfficialCommandAdapter.findPurchaseCommandContext(identity);
export const findSaleCommandContext = identity => OfficialCommandAdapter.findSaleCommandContext(identity);
export const loadPurchaseCommandAggregate = documentId => OfficialCommandAdapter.loadPurchaseCommandAggregate(documentId);
export const loadSaleCommandAggregate = documentId => OfficialCommandAdapter.loadSaleCommandAggregate(documentId);
export const inspectOfficialStocktakeConflicts = source => OfficialCommandAdapter.inspectStocktakeConflicts(source);
export const beginPurchaseCommand = (draft, actor) => OfficialCommandAdapter.beginPurchaseCommand(draft, actor);
export const beginSaleCommand = (draft, actor) => OfficialCommandAdapter.beginSaleCommand(draft, actor);
export const commitPurchaseCommand = command => OfficialCommandAdapter.commitPurchaseCommand(command);
export const commitSaleCommand = command => OfficialCommandAdapter.commitSaleCommand(command);
