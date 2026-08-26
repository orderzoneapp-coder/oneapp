import { ORDERQ_DB_VERSION as V15 } from './orderq-v15-contracts.js?v=0.1.0';

export const ORDERQ_DB_VERSION = 16;
export const ORDERQ_PREVIOUS_DB_VERSION = V15;
export const CLOSE_CONTRACT_VERSION = 'DATAOPS_CLOSE_V1';
export const CLOSE_ALGORITHM_VERSION = 'DATAOPS_CLOSE_ALGORITHM_V1';

const index = (name, keyPath, unique = false) => Object.freeze({ name, keyPath, options: Object.freeze({ unique }) });
const store = (name, keyPath, indexes) => Object.freeze({ name, keyPath, indexes: Object.freeze(indexes) });

export const V16_STORE = Object.freeze({
  APPROVED_CLOSE_BASELINES: 'approvedCloseBaselines',
  CLOSE_SERIES: 'closeSeries',
  CLOSE_REVISIONS: 'closeRevisions',
  CLOSE_SOURCE_SNAPSHOTS: 'closeSourceSnapshots',
  CLOSE_RESULT_SNAPSHOTS: 'closeResultSnapshots',
  CLOSE_ISSUES: 'closeIssues',
  CLOSE_ISSUE_DECISIONS: 'closeIssueDecisions',
  CLOSE_INVENTORY_ROWS: 'closeInventoryRows',
  CLOSE_ORDER_ROWS: 'closeOrderRows',
  CLOSE_PURCHASE_ROWS: 'closePurchaseRows',
  CLOSE_SALES_ROWS: 'closeSalesRows',
  CLOSE_RECEIVABLE_ROWS: 'closeReceivableRows',
  CLOSE_PAYABLE_ROWS: 'closePayableRows',
  CLOSE_AUDIT_EVENTS: 'closeAuditEvents',
  CLOSE_REPORT_MANIFESTS: 'closeReportManifests'
});

export const V16_STORE_DEFINITIONS = Object.freeze([
  store(V16_STORE.APPROVED_CLOSE_BASELINES, 'baselineId', [
    index('byCompanyInventoryDate', ['companyId','inventoryKey','businessDateBefore'], true), index('byStatus', 'status')
  ]),
  store(V16_STORE.CLOSE_SERIES, 'closeSeriesId', [
    index('byCompanyDateCurrency', ['companyId','closeBusinessDate','currency'], true),
    index('byStatus', 'status'), index('byHeadRevision', ['closeSeriesId','seriesHeadRevision'], true)
  ]),
  store(V16_STORE.CLOSE_REVISIONS, 'closeRevisionId', [
    index('bySeriesRevision', ['closeSeriesId','revision'], true), index('bySeriesStatus', ['closeSeriesId','status']),
    index('byCommandId', 'commandId', true), index('byIdempotencyKey', 'idempotencyKey', true),
    index('bySourceSealId', 'sourceSealId'), index('byFinalReceiptFingerprint', 'finalReceiptFingerprint', true)
  ]),
  store(V16_STORE.CLOSE_SOURCE_SNAPSHOTS, 'sourceSealId', [
    index('bySeries', ['closeSeriesId','sealedAt']), index('bySourceDigest', 'sourceADigest'), index('byTokenDigest', 'closeReadTokenDigest')
  ]),
  store(V16_STORE.CLOSE_RESULT_SNAPSHOTS, 'resultSnapshotId', [index('byRevisionId', 'closeRevisionId', true), index('byResultDigest', 'resultBDigest')]),
  store(V16_STORE.CLOSE_ISSUES, 'issueId', [index('byRevision', ['closeRevisionId','severity']), index('byStatus', ['closeRevisionId','status']), index('byCode', ['closeRevisionId','issueCode'])]),
  store(V16_STORE.CLOSE_ISSUE_DECISIONS, 'issueDecisionId', [index('byIssue', ['issueId','decidedAt']), index('byDecisionDigest', 'decisionDigest', true)]),
  store(V16_STORE.CLOSE_INVENTORY_ROWS, 'closeInventoryRowId', [index('byRevisionId', 'closeRevisionId'), index('byInventoryKey', ['closeRevisionId','inventoryKey'], true)]),
  store(V16_STORE.CLOSE_ORDER_ROWS, 'closeOrderRowId', [index('byRevisionId', 'closeRevisionId'), index('byOrderItem', ['closeRevisionId','orderId','orderItemId'], true)]),
  store(V16_STORE.CLOSE_PURCHASE_ROWS, 'closePurchaseRowId', [index('byRevisionId', 'closeRevisionId'), index('byDocument', ['closeRevisionId','purchaseDocumentId'], true)]),
  store(V16_STORE.CLOSE_SALES_ROWS, 'closeSalesRowId', [index('byRevisionId', 'closeRevisionId'), index('byDocument', ['closeRevisionId','salesDocumentId'], true)]),
  store(V16_STORE.CLOSE_RECEIVABLE_ROWS, 'closeFinancialRowId', [
    index('byRevision', ['closeRevisionId','ledgerSequence','entryId'], true), index('byPartner', ['closeRevisionId','partnerId','currency']), index('byEntryId', ['closeRevisionId','entryId'], true)
  ]),
  store(V16_STORE.CLOSE_PAYABLE_ROWS, 'closeFinancialRowId', [
    index('byRevision', ['closeRevisionId','ledgerSequence','entryId'], true), index('byPartner', ['closeRevisionId','partnerId','currency']), index('byEntryId', ['closeRevisionId','entryId'], true)
  ]),
  store(V16_STORE.CLOSE_AUDIT_EVENTS, 'auditEventId', [index('bySeries', ['closeSeriesId','createdAt']), index('byRevision', ['closeRevisionId','createdAt']), index('byCommandId', 'commandId')]),
  store(V16_STORE.CLOSE_REPORT_MANIFESTS, 'reportManifestId', [index('byRevisionTemplate', ['closeRevisionId','templateVersion'], true), index('byFileDigest', 'fileDigest')])
]);

export const V16_META_DEFAULTS = Object.freeze({
  closeContractVersion: CLOSE_CONTRACT_VERSION,
  closeAlgorithmVersion: CLOSE_ALGORITHM_VERSION,
  currentClosePointers: Object.freeze({}),
  lastCloseAuditSequence: 0,
  closeProjectionVersion: '1',
  expectedDataOpsDeployment: Object.freeze({ deploymentId:'AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw', deploymentVersion:'31', gitCommit:'48a52ec34fa938cd60fe965b795083539460627f' }),
  expectedOrderQDeployment: Object.freeze({ deploymentId:'AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw', deploymentVersion:'31', gitCommit:'48a52ec34fa938cd60fe965b795083539460627f' })
});
