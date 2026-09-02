# ORDER Q vNext Architecture

Version: 0.9.0
Reviewed: 2026-09-03
Official voucher boundary review: `NEXUS-SI-V2-07A` / 2026-09-03

## 1. Scope

ORDER Q vNext is an independent pilot under `/orderq/`. The existing `orderops/list.html` compatibility screen consumes its read-only unresolved-review Adapter only inside the approved result-area state; root `orderops_list.html` remains unchanged.

Phase 3 adds `/orderq/parser.html`. ORDER IN/SmartParser never writes ORDER / ORDER_ITEM directly: raw text and parse decisions are stored separately, then confirmed actions call the shared Order Intake Engine. Direct input, ORDER IN, Excel, shopping-mall, and external adapters share that same boundary.

vNext 0.9.0 keeps the 0.7.1 `input → document history → operations` work surfaces and the separate official-voucher background synchronization boundary. It retains the ORDER Q-owned official command Adapter and Gateway used by SmartInput purchase/sale finalize, the default-off V2 stocktake checkpoint decision boundary, and the read-only unresolved-product review model plus pure rematch-impact preview. Phase 6C provides the default-off explicit inventory-rematch owner command. Phase 7A adds default-off owner-only correction/cancel command and immutable Revision plans without connecting a product UI, changing a Store, activating Cloud, or changing the existing document-list editing behavior.

`/orderq/operations.html` still filters order documents before product aggregation and never duplicates document editing. IndexedDB v7 retains the existing order stores and adds official command, voucher revision, inventory effect, AR/AP, checkpoint, unresolved-product and queue records without deleting prior data. `deliveryExpectedDate` remains optional and item-change entries continue to use the existing event detail JSON. Legacy `status` remains the item-matching summary for compatibility while `orderStatus`, `adminStatus`, and derived operations status own the workflow.

`NEXUS-SI-V2-02~05` establishes the local call boundary and additive V2 contract for SmartInput purchase/sale finalize. Finalize Services resolve Product and Customer Snapshots by exact company-scoped code, builders freeze that evidence, and the Gateway and Repository validate it again. Product matching uses the Product owner key—outer trim followed by exact source-string equality—so case, width and internal-space variants remain distinct. Customer matching separately uses the Customer owner `normalizedCustomerCode` rule: NFKC, Korean-locale lowercase and whitespace collapse. Matched products create `+quantity` purchase or `-quantity` sale movements with factor 1; matched zero quantity persists `ZERO_EFFECT`. Unmatched and name-only rows create no official inventory movement and instead keep `UNRESOLVED_PRODUCT` source values and document/line/Revision review links. Exact matched customer code alone creates base payable/receivable; missing or unmatched customer records the omission reason in the Revision. V2 inventory, pending and base payable/receivable entries use the voucher `businessDate` as `effectiveAt`, while `occurredAt` remains the command-recording timestamp; Gateway and Repository both reject a ledger projection whose dates diverge. Before any V2 draft write, all matched rows are checked against the latest confirmed company+productCode+warehouse checkpoint. A before-date or same-day-unproven effect requires the approved included/not-included decision; cancel never enters the write path. Gateway preview and the Repository's write transaction both validate decision targets, checkpoint identity, projection, payload identity and idempotency. V1 remains unchanged. Cloud activation, rematch batch/UI, correction and cancellation features remain explicit follow-up work. This phase adds only the approved transient dialog CSS and a module cache-buster; it changes no IndexedDB schema/data, permanent table/column/button/tab, Cloud deployment or production activation.

Manual entry remains code-first and keyboard-driven. A newly created direct-entry document starts with administrator status `CHECKED`, while ORDER IN, Excel, shopping-mall, and external collection continue to start as `UNCHECKED`. Product search runs only from the item-code cell; Enter follows customer → warehouse → item code → quantity → price → memo and creates a new row after the last memo. Product columns remain directly editable but are skipped by that primary entry path. `supplyAmount` and optional `vatAmount` remain editable. Price basis, saved column widths, date arrows, and warehouse master behavior remain unchanged from v0.5.1.

The vNext data path is:

`Direct / ORDER IN / Excel / Shopping mall / External → Order Intake → IndexedDB → Sync Engine → Cloud Adapter → Google Apps Script / purpose sheets`

Later, only the Cloud Adapter boundary is intended to change to `Server API → PostgreSQL`; the Order Intake and local repository contracts remain stable.

## 2. Ownership and source of truth

- Current phase: IndexedDB `oneapp-orderq-pre-m1-v6` v7 is the isolated local working database. The previous M1~M10 database remains preserved and is not opened by this rollback build.
- ORDER Q owns official purchase/sale documents and lines, command receipts, voucher Revisions, inventory movements or pending effects, inventory checkpoints, unresolved-product records, base payable/receivable entries, and the official local sync queue. SmartInput owns drafts, autosave, input templates, field settings, reference-generation cache and estimate originals; it consumes an ORDER Q command Adapter and must not write ORDER Q raw stores.
- The V2 owner façade is the ORDER Q `OfficialCommandGateway`, backed by the ORDER Q `OfficialVoucherRepository`. This is an app-owner boundary, not the NEXUS common Gateway. SmartInput purchase/sale finalize uses it through the ORDER Q command Adapter; Phase 6C rematch and Phase 7A correction/cancel build/commit use the same Adapter/Gateway. Legacy remote product-resolution replay is routed through the Gateway and the former raw local rematch writer fails closed. Phase 7A has no product UI consumer. The Repository rechecks company, command idempotency, expected Revision, identity, immutable Head evidence and transaction atomicity.
- The unresolved-review read façade is `unresolved-review-read-adapter.js`, backed only by the ORDER Q `unresolved-review-repository.js`. The Repository reads existing `unresolvedProducts`, `pendingInventoryEffects`, purchase/sale documents and lines, voucher Revisions, and optional inventory checkpoints. Consumers receive the combined contract and never receive raw Store handles or open the ORDER Q database. Evidence with the same pending-effect ID is deduplicated only after every shared link field is compared; a conflict remains `REVIEW_REQUIRED` with the differing field names. A point-get target outside the requested company contributes only an explicit company-mismatch issue, never its document, line, Revision, product, quantity, warehouse, date, or time payload. Owner read failure returns `ERROR` with a null count; an existing or absent database with no matching rows returns `EMPTY` with count zero. Product Snapshot failure may suppress reference candidates without hiding official review rows, while a rematch impact preview fails closed until the selected product can be verified.
- The user-facing product identity is the ERP `productCode`, unique as an outer-trimmed, otherwise exact string inside one company and preserving leading zeroes, case, character width and internal whitespace. Existing `productId` is a non-visible Product Snapshot compatibility key for the current inventory, checkpoint, rematch and sync storage contracts; this phase neither removes it nor introduces a user-visible `NXP-*` identifier.
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
- V1 keeps its existing partner validation. V2 separates voucher creation from customer matching: customer code and name are not voucher-required fields; a company-scoped Customer Snapshot code match under the owner `normalizedCustomerCode` rule creates the sale receivable or purchase payable base effect, while a missing or unmatched customer creates no AR/AP effect and does not block the voucher or inventory decision. The omission reason is stored in the Revision. Each created V2 AR/AP entry stores `effectiveAt=businessDate` and keeps command `occurredAt` separately; the Revision decision retains both dates. AR/AP closing, balance adjustment, tax invoices, offsetting and separate account adjustments remain outside this contract.
- Product matching is independent of voucher validity. An exact company-scoped `productCode` match uses the Product owner key: outer trim only, then exact source-string equality. Case, fullwidth/halfwidth and internal-space variants never auto-match. An exact result resolves the compatible hidden `productId` and allows inventory movement. A line with a code or name but no exact match still creates the voucher and immutable line Snapshot, creates no official inventory movement, and records an `UNRESOLVED_PRODUCT` pending/review record with source code/name/spec/unit and document/line/Revision links. Similar names are never auto-confirmed.
- Purchase inventory is `+quantity`; sale inventory is `-quantity`. Positive, zero and negative quantities are valid, V2 fixes the compatibility factor to 1, and a matched zero quantity persists an auditable `ZERO_EFFECT` rather than disappearing. Unmatched zero stays a review record and is not represented as official stock zero.
- A matched effect dated before the latest confirmed stocktake, or on the same date when order cannot be proven, requires an explicit user decision before official commit. Selection is per latest confirmed `companyId + productCode + warehouseId` checkpoint and per conflict row, with the existing hidden `productId` accepted only as a checkpoint compatibility key. The transient dialog confirms rows sequentially, permits mixed included/not-included decisions in one voucher or across groups, discards all collected choices on any cancel, and starts no write until every row has been selected and every group re-inspected. Command `occurredAt` and checkpoint `confirmedAt` are audit timestamps, not business-order evidence. Judgment `judgedAt` must be a complete ISO timestamp with `Z` or an explicit offset. `included` preserves the voucher and checkpoint, records `ABSORBED_BY_CHECKPOINT`, and does not change current stock; `not included` preserves both and creates exactly one deterministic linked `APPLIED_AS_LATE_ADJUSTMENT` movement; `cancel` writes no official document, line, Revision, inventory, AR/AP, command or queue record. The command payload and Revision preserve the decision, exact target/effect/checkpoint, `businessDate`, actor and judgment time. Gateway의 V2 inspect·Draft·execute와 custom Finalize는 stocktake inspection capability가 없으면 Repository 쓰기 포트를 호출하기 전에 fail-closed한다. Phase 6C reuses this same pure classifier for rematch and never produces the legacy automatic `RESOLVED_WITHOUT_MOVEMENT_AFTER_STOCKTAKE` outcome.
- Existing official-voucher, Draft and test records are not migrated to V2 and are not read through a new V1 compatibility migration. Development stays additive inside SmartInput DB v5 and ORDER Q DB v7; existing stores and records are not deleted or reinitialized.
- Purchase and sale use separate feature gates, validation and rollback. Normal SmartInput layout, buttons, keyboard shortcuts and workflow remain unchanged. Cloud Push/Pull, server deployment and official production activation are separate acceptance scopes.

### 2.2 Unresolved-product review and impact-preview contract

- Schema `ONEAPP_ORDERQ_UNRESOLVED_REVIEW_READ_MODEL_V1` requires `companyId` and provides deterministic exact filters, stable sorting with an unresolved-ID tie-breaker, and page/limit up to 200. It joins every pending effect and stored review link by `pendingEffectId`; an orphan effect, a missing document/line/Revision, an unconfirmed target, or a broken scope remains visible as `REVIEW_REQUIRED` rather than disappearing.
- Each link keeps the confirmation-time original product code, name, specification and unit; warehouse; `businessDate`; input and signed purchase/sale quantity; document kind, document ID, line ID, document Revision and Revision ID; and a trace URL. Official inventory is represented as `{ status: NOT_APPLIED, label: 미반영, officialQuantity: null }`; the unapplied signed quantity is a separate field and is never rendered as official stock zero.
- Candidate generation consumes only the current Product owner Snapshot. The same company rule and outer-trim-only exact product-code key from Phase 4 apply, so leading zeroes, case, fullwidth/halfwidth characters and internal spaces remain distinct. One exact-code row may be labeled `EXACT_COMPANY_PRODUCT_CODE`; name rows remain `EXACT_PRODUCT_NAME_REFERENCE_ONLY`. Every candidate has `automaticConfirmation=false` and explicit `자동확정 아님` evidence.
- Schema `ONEAPP_ORDERQ_UNRESOLVED_REMATCH_IMPACT_PREVIEW_V1` is a pure, read-only projection. It returns affected documents, lines, signed/input totals, warehouses, dates and each latest relevant checkpoint, and reuses `evaluateStocktakeCheckpointConflictV2()`. Effects before the checkpoint and same-day effects without trusted order evidence are `DECISION_REQUIRED`; proven later effects are `APPLY_READY`; missing source evidence is `REVIEW_REQUIRED`. It creates no rematch command, inventory movement, reference-data change or UI action.
- UI Gate U1 A was approved for Phase 6B, so `orderops` is the sole product UI consumer. It adds only a `미매칭` filter state to the existing `#resultsPanel`/`#previewTable`, exposes every Adapter page through bounded previous/next navigation, labels search/sort/column conditions as current-page scope, preserves the current page across list/detail transitions and the host view state on enter/exit, and calls impact preview only after explicit candidate selection. It adds no global tab, independent panel, popup, route, confirmation/apply action, write, Store or migration. Rollback removes the consumer module, result-state branch and manifest consumer registration while retaining all Phase 6A owner assets and DB v7 data. Phase 6B UI still exposes no rematch execution; the Phase 6C owner command is default-off and deliberately unconnected to product UI. Cloud/Pilot activation, correction/cancel and DB migration remain excluded.

### 2.3 Inventory-rematch command contract

- Schema `ONEAPP_ORDERQ_INVENTORY_REMATCH_COMMAND_V2` requires the current company and official identity version, deterministic `commandId=idempotencyKey`, actor, zoned `occurredAt`/`judgedAt`, explicit selection evidence with `automaticConfirmation=false`, the current Product Snapshot schema/snapshot ID/revision/content hash, and complete expected document/effect link sets. Product names and similarity never authorize selection.
- Before writing, the Repository verifies the Product Snapshot content hash and exact selected company/product ID/code/name/specification/unit. A readonly preflight, repeated inside the write transaction, reconciles pending and review evidence against the confirmed document, active confirmed line and hashed original Revision. It recalculates the factor-1 actual quantity, purchase-positive/sale-negative sign, warehouse, calendar-valid business date and only line/document-trusted business time, and requires document/line/Revision/pending/review to identify the same original command. Missing, partial, cross-company, changed, stale, jointly forged, or already-resolved evidence fails closed before official writes.
- Phase 5 `evaluateStocktakeCheckpointConflictV2()` remains the only classifier. Proven-after/no-checkpoint nonzero effects become `APPLIED_NORMAL`; before or same-day-unproven effects require one current checkpoint-bound decision per row. Zero always retains primary `effectStatus=ZERO_EFFECT`. Its independent `stocktakeEffectStatus` is blank when normal, `ABSORBED_BY_CHECKPOINT` when included, or `APPLIED_AS_LATE_ADJUSTMENT` when not included, and both statuses survive in the movement, resolved pending effect and audit Revision. Included has stock delta zero and `officialInventoryApplied=false`; normal and not-included remain true, with not-included represented by exactly one deterministic movement. `RESOLVED_WITHOUT_MOVEMENT_AFTER_STOCKTAKE` is never produced by the 6C command.
- One existing DB v7 transaction updates the unresolved and pending records and adds deterministic inventory/absorption movements, one unresolved-scoped audit Revision, one official command receipt, and one `OFFICIAL_INVENTORY_REMATCH_COMMAND` local syncQueue row. Original confirmed documents, lines, confirmation-time Product Snapshots, and their Revisions remain unchanged. A duplicate receipt returns the stored result even if the Product Snapshot later changes; a changed payload, stale evidence, or any write failure produces no partial official writes.
- The rematch feature gate stays OFF by default. Its queue status is `WAITING_SERVER_CONTRACT` and is not in the current official Cloud entity allowlist. Phase 6C adds no UI action, product-master write, production/Pilot activation, correction/cancellation, DB version, Store, or migration. Rollback reverts the 6C core/Gateway/Repository additions and their docs/tests; existing DB v7 rows created during explicit test execution remain historical facts and are not deleted automatically.

### 2.4 Official correction/cancel Revision contract

- Schema `ONEAPP_ORDERQ_OFFICIAL_REVISION_COMMAND_V2` and plan `ONEAPP_ORDERQ_OFFICIAL_REVISION_PLAN_V2` are owner-only contracts. A command requires company, purchase/sale kind, document ID, current expected Revision, `CORRECT` or `CANCEL`, actor, a calendar-valid zoned timestamp, reason, deterministic `commandId=idempotencyKey`, payload digest and the complete `ONEAPP_ORDERQ_OFFICIAL_REVISION_TARGET_V2` Head Snapshot. `CORRECT` also carries a complete replacement document/line Snapshot. The target contains the current projection, ACTIVE/CONFIRMED lines, hash-verified Head Revision, active inventory or pending-effect links and current command-receipt evidence.
- The Repository performs the same state read first in a readonly transaction and then again in the single write transaction. It rejects a stale Revision, cancelled/non-confirmed document, company/kind/document mismatch, altered Revision hash, broken active effect, different payload under the same command ID, and missing or changed command receipt. Initial POST `businessSnapshot` and Phase 7A full after-Snapshot formats are handled explicitly: every stored business, identity and linkage field is reconciled to the current projection, and both `status` and `businessStatus` must independently be `CONFIRMED`. A successful retry returns the stored receipt without adding effects.
- An unchanged confirmation-time product or partner identity and Snapshot remains authoritative even if the current owner master no longer contains it. A newly added or changed matched product must carry the current Product owner Snapshot and is rechecked for company-scoped exact/unique ERP code, product ID, code, name, specification, unit and revision. A changed partner resolution is likewise rechecked against the current Customer owner Snapshot. A changed matched partner is then rejected with an explicit unsupported AR/AP error even when the existing document has no linked base entry, because Phase 7A does not create the newly required payable/receivable effect.
- Every correction replacement reruns the official V2 confirmation preflight and amount contract. Blank text is never coerced to numeric zero; code-or-name, quantity, unit price, line amount, confirmation-time Product Snapshot, and document totals must agree, while explicit zero and negative values remain valid. Product identity comparison excludes transaction quantity/price/amount, so a quantity-only correction keeps the original confirmation identity without requiring a deleted master. For a new or changed line, both matched and unresolved code classifications are recomputed from the current Product owner Snapshot; code-less name-only identities require their deterministic company-scoped unresolved ID. Customer exact/zero/multiple/missing-ID classification is likewise recomputed, so a caller cannot self-declare a known exact product or customer as unresolved.
- `CORRECT` advances only the current document/line projection to Revision n+1. The prior document state remains reconstructible from its immutable Revision Snapshot. A changed matched effect creates a separately linked `REVISION_REVERSAL` row for each current valid effect and one `REVISION_AFTER_EFFECT` row for the replacement. Product, warehouse and business-date changes therefore never collapse old and new stock identities into one row. Before reversal, every candidate movement is reconciled to the source document, line and hash-valid Revision and to the recomputed product, code, warehouse, business/effective date, command, role/status, signed/original quantity and stocktake lineage. Normal, absorbed, late-adjustment, revision-after and Phase 6C rematch shapes are explicit; equal aggregate quantity never makes a forged identity valid. Matched-to-unmatched supersedes the current effect and creates a pending review; unmatched-to-matched supersedes the pending link and applies the selected exact Snapshot. A Phase 6C-resolved pending row is treated as the current matched effect without mutating its original confirmation Snapshot.
- `CANCEL` deletes no document, line, Revision or effect. It advances the projection to `CANCELLED`, preserves all lines under the cancelled Revision, reverses each actually applied current effect, and records an auditable zero reversal for an absorbed/non-applied effect. A second cancel fails closed and adds no effect.
- The Repository derives the entire current non-reversal movement set from every movement for the document, applies reversal lineage, and requires its ID union to equal the union of every Head `effectiveLineStates[].activeInventoryEffects` ID. It likewise requires all document rows still marked `PENDING_PRODUCT_MATCH` to equal the Head active-pending ID union. This document-wide coverage check runs for a full 7A Snapshot and after deriving states for an initial POST Snapshot, so an effect belonging to a removed historical line cannot become an untracked orphan. Every movement must be a member of its hash-valid source Revision effects; initial POST, Phase 6C rematch and 7A Revision formats each require their inventory type plus the applicable status/applied/role or pending ID and quantity fields, so an abbreviated `{id}` member is invalid. Reversal lineage, hidden reversals, extra active effects and `businessOccurredAt` are checked before checkpoint classification. An active pending effect must also have exactly one unresolved review link whose company, document/line/Revision/command, warehouse, date/time, signed quantity, amount, Product Snapshot and resolution match. Missing, duplicate or changed links fail in both readonly inspection and the repeated write transaction check.
- Purchase stock remains `+quantity` and sale stock `-quantity`; positive, zero and negative quantities and compatibility factor 1 remain exact. `effectStatus=ZERO_EFFECT`, `reversalStatus=REVERSED`, `stocktakeEffectStatus` and `officialInventoryApplied` are separate audit dimensions. Every matched reversal or replacement delta is classified using Phase 5 `evaluateStocktakeCheckpointConflictV2()` at that delta's original `businessDate`. Before-checkpoint and same-day-unproven rows require an explicit current decision per delta. All decisions and the current checkpoints are verified before the first write and again in the write transaction; an intermediate user cancel returns zero official writes.
- Phase 7A never creates, updates, deletes or reverses a payable/receivable entry. If any base AR/AP entry is linked to the current document, the command fails with `ORDERQ_OFFICIAL_REVISION_ARAP_EFFECT_UNSUPPORTED` until closing, adjustment, tax-invoice and offset policy is separately approved. The partner Store participates only in state verification, not as a writer.
- Superseding or cancelling pending effects recomputes the unresolved record's top-level state from all active review links. With remaining active links it stays `UNRESOLVED_PRODUCT`; with none it becomes `NO_ACTIVE_REVIEW` and leaves the closed links as audit evidence, so the Phase 6B list no longer returns it. A Phase 6C `MATCHED` unresolved identity is never cleared or downgraded by a replacement; reuse as a new pending identity fails closed and the whole transaction rolls back.
- `CORRECT_PURCHASE`, `CANCEL_PURCHASE`, `CORRECT_SALE` and `CANCEL_SALE` gates are independent and OFF by default. There is no SmartInput or OrderOps execution control in Phase 7A. `OFFICIAL_VOUCHER_REVISION_COMMAND` remains a local `WAITING_SERVER_CONTRACT` queue entity outside `official-voucher-sync.js` and the Cloud allowlist. DB v7, its Stores/indexes, Pilot status and deployment remain unchanged.

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
