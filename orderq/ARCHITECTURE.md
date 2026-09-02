# ORDER Q vNext Architecture

Version: 0.8.1
Reviewed: 2026-09-02
Official voucher contract review: `NEXUS-SI-V2-00` / 2026-09-02

## 1. Scope

ORDER Q vNext is an independent pilot under `/orderq/`. Existing `orderops/` and root `orderops_list.html` remain unchanged.

Phase 3 adds `/orderq/parser.html`. ORDER IN/SmartParser never writes ORDER / ORDER_ITEM directly: raw text and parse decisions are stored separately, then confirmed actions call the shared Order Intake Engine. Direct input, ORDER IN, Excel, shopping-mall, and external adapters share that same boundary.

vNext 0.8.0 keeps the 0.7.1 `input → document history → operations` work surfaces and adds a separate official-voucher background synchronization boundary. The document list derives representative product and total quantity without storing duplicate summary fields. Expanded documents edit customer, warehouse, assignee, delivery date, workflow states, memo, products, quantities, and prices with the existing optimistic-revision boundary. Item additions, removals, and field changes are appended to the existing `ORDER_EVENT` detail payload. A fully cancelled document remains immutable except for assignee and administrator state, including `CHECKED → UNCHECKED`.

`/orderq/operations.html` still filters order documents before product aggregation and never duplicates document editing. IndexedDB v7 retains the existing order stores and adds official command, voucher revision, inventory effect, AR/AP, checkpoint, unresolved-product and queue records without deleting prior data. `deliveryExpectedDate` remains optional and item-change entries continue to use the existing event detail JSON. Legacy `status` remains the item-matching summary for compatibility while `orderStatus`, `adminStatus`, and derived operations status own the workflow.

`NEXUS-SI-V2-00` is a document-only contract correction. It changes no JavaScript, HTML, CSS, IndexedDB schema, data, UI, feature gate, Cloud deployment, or production activation. The current source remains the compatibility baseline: SmartInput's `legacy-integration-adapter.js` loads the purchase/sale official modules, those modules call ORDER Q `runCentralOfficialVoucherCommand()`, the current preflight requires matched partner IDs, and `inventory-rematch-core.js` automatically suppresses checkpoint-earlier delayed effects. The V2 owner gateway, optional/unmatched-customer handling, and stocktake decision flow below are required follow-up implementation, not completed behavior.

Manual entry remains code-first and keyboard-driven. A newly created direct-entry document starts with administrator status `CHECKED`, while ORDER IN, Excel, shopping-mall, and external collection continue to start as `UNCHECKED`. Product search runs only from the item-code cell; Enter follows customer → warehouse → item code → quantity → price → memo and creates a new row after the last memo. Product columns remain directly editable but are skipped by that primary entry path. `supplyAmount` and optional `vatAmount` remain editable. Price basis, saved column widths, date arrows, and warehouse master behavior remain unchanged from v0.5.1.

The vNext data path is:

`Direct / ORDER IN / Excel / Shopping mall / External → Order Intake → IndexedDB → Sync Engine → Cloud Adapter → Google Apps Script / purpose sheets`

Later, only the Cloud Adapter boundary is intended to change to `Server API → PostgreSQL`; the Order Intake and local repository contracts remain stable.

## 2. Ownership and source of truth

- Current phase: IndexedDB `oneapp-orderq-pre-m1-v6` v7 is the isolated local working database. The previous M1~M10 database remains preserved and is not opened by this rollback build.
- ORDER Q owns official purchase/sale documents and lines, command receipts, voucher Revisions, inventory movements or pending effects, inventory checkpoints, unresolved-product records, base payable/receivable entries, and the official local sync queue. SmartInput owns drafts, autosave, input templates, field settings, reference-generation cache and estimate originals; it consumes an ORDER Q command Adapter and must not write ORDER Q raw stores.
- The V2 owner façade is the ORDER Q `OfficialCommandGateway`, backed by the ORDER Q `OfficialVoucherRepository`. This is an app-owner boundary, not the NEXUS common Gateway. Every UI, remote-replay, correction, cancellation, and later rematch path that changes official data must pass the same owner checks; the Repository rechecks company, command idempotency, expected Revision, identity and transaction atomicity.
- The user-facing product identity is the ERP `productCode`, unique as a string inside one company and preserving leading zeroes. Existing `productId` is a non-visible Product Snapshot compatibility key for the current inventory, checkpoint, rematch and sync storage contracts; this phase neither removes it nor introduces a user-visible `NXP-*` identifier.
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

### 2.1 Official purchase/sale V2 contract

- The current `VOUCHER_CORE_V1` finalize transaction writes the official document and lines, command receipt, voucher Revision, matched inventory movement or unresolved pending effect, the validated partner's base payable/receivable entry, unresolved-product identity where needed, and one `syncQueue` row as one IndexedDB commit. Failure leaves none of those finalize effects partially committed.
- The current SmartInput preflight requires master-matched partner IDs. V2 separates voucher creation from customer matching: customer code and name are not voucher-required fields; an exact company-scoped Customer Snapshot match creates the sale receivable or purchase payable base effect, while a missing or unmatched customer creates no AR/AP effect and does not block the voucher or inventory decision. The omission reason belongs in the Revision. AR/AP closing, balance adjustment, tax invoices, offsetting and separate account adjustments remain outside this contract.
- Product matching is independent of voucher validity. An exact company-scoped `productCode` match resolves the compatible `productId` and allows inventory movement. A line with a code or name but no exact match still creates the voucher and immutable line Snapshot, creates no official inventory movement, and records an unresolved pending effect. Similar names are candidates only and never auto-confirm a product.
- Purchase inventory is `+quantity`; sale inventory is `-quantity`. Positive, zero and negative quantities are valid, and V2 uses the entered quantity without an option or unit-conversion business rule. A zero quantity remains a valid zero effect.
- A matched effect dated before the latest confirmed stocktake, or on the same date when order cannot be proven, requires an explicit user decision before official commit. `included` preserves the voucher and checkpoint but does not change current stock; `not included` preserves the checkpoint and creates a linked late adjustment; `cancel` writes no official document, Revision, inventory, AR/AP or queue record. The current automatic `RESOLVED_WITHOUT_MOVEMENT_AFTER_STOCKTAKE` behavior is a known baseline gap and must not be treated as V2 completion.
- Existing official-voucher, Draft and test records are not migrated to V2 and are not read through a new V1 compatibility migration. Development stays additive inside SmartInput DB v5 and ORDER Q DB v7; existing stores and records are not deleted or reinitialized.
- Purchase and sale use separate feature gates, validation and rollback. Normal SmartInput layout, buttons, keyboard shortcuts and workflow remain unchanged. Cloud Push/Pull, server deployment and official production activation are separate acceptance scopes.

## 3. Cloud contract

Schema: `ONEAPP_ORDERQ_SYNC_V1`

POST actions:

- `orderq_sync_push`
- `orderq_sync_pull`
- `orderq_order_head`

Official voucher synchronization uses a separate compatibility boundary so older clients never advance past an official record they cannot apply:

- Schema: `ONEAPP_ORDERQ_OFFICIAL_SYNC_V1`
- Actions: `orderq_official_sync_push`, `orderq_official_sync_pull`
- Sheets: `OFFICIAL_VOUCHER_COMMAND`, `OFFICIAL_PRODUCT_RESOLUTION`, `OFFICIAL_SYNC_HEAD`, `OFFICIAL_SYNC_META`
- Partition and cursor: `companyId`

Official command payloads are immutable and chunked across cells to preserve long vouchers. The server accepts the first command for a voucher Revision, rejects a competing command as a conflict, and records the first product resolution for an unresolved system ID. Pull applies each command to voucher, inventory or pending inventory, payable/receivable and voucher revision in one local IndexedDB transaction. An apply failure stops that company's official cursor before the failed record and preserves a conflict row.

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

The current official-voucher finalize adds its immutable official command queue row inside the same owner transaction as the document, Revision, inventory/pending and base AR/AP effects. A local success is not evidence of Cloud activation; official Push/Pull remains disabled or retryable as `WAITING_SERVER_CONTRACT` until the separate deployment and acceptance gate is approved.

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

The Google Apps Script backend is a separate deployment boundary. A repository merge of `code.gs` / `orderq-cloud.gs` does not by itself prove that the live Apps Script Web App contains those versions. Official synchronization production acceptance requires the bound Apps Script project to deploy both files and a two-device, same-company conflict test plus a cross-company isolation test. Until that deployment succeeds, local finalize remains authoritative and `WAITING_SERVER_CONTRACT` rows remain retryable.

`NEXUS-SI-V2-00` does not deploy either boundary, enable official Push/Pull, merge to `main`, or activate purchase/sale V2. Its rollback is the documentation commit or PR revert; it never deletes official or draft data.
