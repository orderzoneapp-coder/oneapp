# ORDER Q vNext Architecture

Version: 0.8.0
Reviewed: 2026-08-14

## 1. Scope

ORDER Q vNext is an independent pilot under `/orderq/`. Existing `orderops/` and root `orderops_list.html` remain unchanged.

Phase 3 adds `/orderq/parser.html`. ORDER IN/SmartParser never writes ORDER / ORDER_ITEM directly: raw text and parse decisions are stored separately, then confirmed actions call the shared Order Intake Engine. Direct input, ORDER IN, Excel, shopping-mall, and external adapters share that same boundary.

vNext 0.8.0 keeps `input → document history → operations` as separate work surfaces and makes document history the primary order-document lookup and inline editing surface. The document list derives representative product and total quantity without storing duplicate summary fields. Expanded documents edit customer, warehouse, assignee, delivery date, workflow states, memo, products, quantities, and prices with the existing optimistic-revision boundary. Item additions, removals, and field changes are appended to the existing `ORDER_EVENT` detail payload. A fully cancelled document remains immutable except for assignee and administrator state, including `CHECKED → UNCHECKED`.

`/orderq/operations.html` still filters order documents before product aggregation and never duplicates document editing. IndexedDB v7 adds the dispatch, allocation, approval, reservation, movement, and reconciliation stores without rewriting legacy v6 rows. `deliveryExpectedDate` remains an optional order JSON field, and item-change entries use the existing event detail JSON. Legacy `status` remains the item-matching summary for compatibility while `orderStatus`, `adminStatus`, and derived operations status own the workflow. All browser modules share the 0.8.0 release query. The cloud sheet schema and action names remain unchanged because v7 entities define only a future synchronization contract in M1; server synchronization is not enabled yet.

Manual entry remains code-first and keyboard-driven. A newly created direct-entry document starts with administrator status `CHECKED`, while ORDER IN, Excel, shopping-mall, and external collection continue to start as `UNCHECKED`. Product search runs only from the item-code cell; Enter follows customer → warehouse → item code → quantity → price → memo and creates a new row after the last memo. Product columns remain directly editable but are skipped by that primary entry path. `supplyAmount` and optional `vatAmount` remain editable. Price basis, saved column widths, date arrows, and warehouse master behavior remain unchanged from v0.5.1.

The vNext data path is:

`Direct / ORDER IN / Excel / Shopping mall / External → Order Intake → IndexedDB → Sync Engine → Cloud Adapter → Google Apps Script / purpose sheets`

Later, only the Cloud Adapter boundary is intended to change to `Server API → PostgreSQL`; the Order Intake and local repository contracts remain stable.

## 2. Ownership and source of truth

- Current phase: IndexedDB `oneapp-orderq-vnext` is the local working database.
- IndexedDB schema v7 is a non-destructive extension of v6. Browser upgrade transactions provide rollback on migration failure, and the M1 backup/restore repository validates a full backup before applying one atomic restore transaction.
- Legacy Collector inventory effects preserve source quantity signs: purchase uses the stored sign and sales uses its inverse. `ACTIVE` and `REVERSAL` are interpreted without `Math.abs`, while rolled-back or disabled rows are excluded.
- ORDER Q operational confirmation and ERP posting are separate. `erpPostingStatus` uses `NOT_READY`, `READY`, `EXPORTED`, `POSTED`, `RECONCILED`, or `CORRECTION_REQUIRED`; external transaction, document, line, batch, and fingerprint identifiers remain distinct.
- MVP writes retain `actorId`/creator/updater audit fields with `ADMIN` as the default local actor. An explicit blank actor is invalid. Capability names are an extension contract, not a full user-management implementation.
- SmartParser immutable input: `rawInputs`; message decisions and confirmed values: `parseResults`.
- Duplicate boundary: unique `sourceMessageKey` indexes on `parseResults` and `orders`.
- Google Sheet cloud is a central synchronization and recovery layer, not an ERP ledger.
- Historical sales and purchase documents are future ERP-ledger-compatible facts, while fulfillment links and parser evidence remain derived review data.
- Future server phase: server DB becomes primary; IndexedDB becomes cache/offline storage.
- Order system identity is `orderId`; manager identity is `orderNo`; external systems retain `externalOrderNo`. An order line is `orderItemId`; customer identity is `customerId`; warehouse identity is `warehouseId`.
- `orderNo` is allocated atomically inside the local order transaction as `YYYYMMDD-NNN`; `orderId` remains the cloud synchronization key.
- Assignee belongs to each document, never to the customer. Order events record assignee and workflow-state changes. Sales documents use the same assignee snapshot for later inheritance and reporting.
- IndexedDB `warehouses` and `warehouseAliases` are rebuilt lazily from order and history payload snapshots, so an older cloud backend remains compatible.
- Order changes are revisioned. Delete-by-overwrite is prohibited for business cancellation/history. `전체` is a query filter, never a stored state.
- Live sales transfer history is append-only inside `ORDER_EVENT`. `SALES_TRANSFER_ALLOCATED` stores one sales-document/line/order-item allocation; `SALES_TRANSFER_REVERSED` compensates it. The deterministic event identity blocks duplicate allocation for `salesDocumentId + salesLineId + orderItemId`.
- Effective transferred quantity, remaining quantity, transfer status, and operations status are derived. Negative remaining quantity is an over-transfer error and is never clamped to zero.
- Operations closure is derived from all valid items having zero remaining quantity, no over-transfer, and administrator status not being `HOLD`. Close/reopen events record the transition and reason; `closedAt` is only a convenience projection.

## 3. Cloud contract

Schema: `ONEAPP_ORDERQ_SYNC_V1`

POST actions:

- `orderq_sync_push`
- `orderq_sync_pull`
- `orderq_order_head`

The client uses the existing shared cloud URL contract `oneapp_cloud_sync_url_v1` with legacy fallback `merchCloudUrl_v870`.

Purpose sheets are created on first sync and share one central workbook:

- `ORDER`
- `ORDER_ITEM`
- `ORDER_EVENT`
- `CUSTOMER_MASTER`
- `CUSTOMER_ALIAS_MAPPING`
- `PRODUCT_MAPPING`
- `UNIT_MAPPING`
- `MAPPING_EVENT`
- `SYNC_META`
- `PRODUCT_MASTER_ORDERQ`
- `IMPORT_BATCH` / `SOURCE_RECORD`
- `SALES_DOCUMENT` / `SALES_LINE`
- `PURCHASE_DOCUMENT` / `PURCHASE_LINE`
- `LEDGER_DOCUMENT` / `LEDGER_LINE`
- `INVENTORY_SNAPSHOT` / `INVENTORY_LINE`
- `HISTORICAL_ORDER` / `HISTORICAL_ORDER_LINE`
- `FULFILLMENT_LINK` / `PARSER_EVIDENCE` / `COLLECTOR_SETTING`
- `ORDER_TXN_LOG`

ORDER Q cloud actions require `ONEAPP_ORDERQ_ACCESS_TOKEN`; when it is not separately configured, the existing Shipping access token is the compatibility fallback. Order bundle writes use a recoverable transaction log and restore the previous bundle after a partial write.

Do not create one sheet per customer. Customer-specific lookup is performed with `customerId` fields inside common tables.

## 4. Incremental synchronization

Every local change enters IndexedDB `syncQueue` with a unique `queueId`.

`SYNC_META` is an append-only cloud change index using a monotonically increasing `sequence`. Each browser stores its last applied cursor and pulls only later sequences.

A repeated `queueId` is idempotent and must not create a duplicate cloud write.

A local cloud failure does not discard the order. The queue remains pending and can be retried.

Phase 1 data is compatible: on the first phase 2 sync, Customer/Alias/Event reference records not already represented in the queue are queued once.

## 5. Order concurrency

Order mutation uses optimistic locking:

- create: `revision=1`, `baseRevision=0`
- update/cancel: new `revision`, with the previously loaded revision in `baseRevision`
- cloud accepts the write only when the current server revision equals `baseRevision`

When two devices open the same revision, the first accepted cloud save wins. The second stale save is rejected as a conflict.

Policy:

- no automatic overwrite;
- no automatic merge;
- preserve the user's current form contents;
- show the cloud revision conflict;
- administrator applies/reads the cloud latest order and then re-enters or confirms the intended change.

When cloud is unavailable, local-first work is permitted. A later synchronization can therefore surface a conflict; it must never silently choose one side.

## 6. Data separation

The following are separate logical datasets even when linked by IDs:

- customer master;
- customer alias/mapping dictionary;
- product/unit mapping dictionaries;
- mapping events;
- order/order-item/order-event transactions;
- future ERP customer sales ledger.

The future ERP sales ledger is the authoritative transaction ledger. Mapping dictionaries are recognition memory and must not be treated as ledger facts.

Historical order-to-sales matching uses the previous business day first, then same-day orders received before the configurable operating cutoff. Date-only legacy orders keep a lower-confidence `TIME_MISSING` evidence and are not silently promoted to confirmed mappings.

## 7. Deployment boundary

GitHub Pages deploys `/orderq/` from repository `main` automatically.

The Google Apps Script backend is a separate deployment boundary. A repository merge of `code.gs` / `orderq-cloud.gs` does not by itself prove that the live Apps Script Web App contains those versions. Phase 2 production acceptance therefore requires the bound Apps Script project to deploy both files and a two-device operational test.
