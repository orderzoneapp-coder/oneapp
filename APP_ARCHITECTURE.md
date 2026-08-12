# ONEAPP Application Architecture

- Repository: orderzoneapp-coder/oneapp
- Architecture document version: 1.4.2
- Last reviewed: 2026-08-13
- Machine-readable companion: app-manifest.json

## 1. Purpose

ONEAPP turns ERP, supplier, inventory, sales, and shopping-mall data into reviewed product information that can be applied back to operational systems.

Excel is a bidirectional review and correction medium, not a one-way export format.

This document defines:

- current application boundaries;
- shared data contracts;
- application relationships;
- change-impact rules;
- development-path classification;
- validation and release processes;
- recovery principles;
- registration and promotion rules for planned applications.

Detailed working rules for Codex and AI development tools are defined in `AGENTS.md`.

Application-specific planning, development, and PM instructions may add stricter rules but must not override the shared contracts and architecture principles defined here.

---

## 2. Architecture principles

1. GitHub `main` is the production source of truth.
2. Production changes must follow the development path assigned before implementation.
3. Shared field names, storage keys, cloud actions, and navigation paths are contracts.
4. A change to a shared contract must be reviewed against every consumer, even when only one screen is visibly changed.
5. Planned applications do not become production dependencies until their owner, purpose, inputs, outputs, and status are recorded in `app-manifest.json`.
6. Duplicate `_test` files are not a recovery source of truth.
7. Recovery uses Git history, stable tags, PR reverts, and verified backups.
8. A separately named preview page may be kept only when an alternate validation URL is operationally required.
9. Existing operational behavior must be preserved unless a change is explicitly approved.
10. An application must not change another application's business meaning merely because they share data or utilities.
11. Automated test success does not by itself prove production readiness.
12. Production completion requires deployed behavior to be checked in the actual operational flow.
13. Technical safety is reviewed by development and PM roles.
14. Final operational policy and production acceptance remain administrator decisions.

---

## 3. System overview

```text
External ERP / suppliers / shopping malls
                   |
                   v
            SmartParser.html
       parse, normalize, detect changes
                   |
                   v
              MerchOps.html
     review, compare, edit, approve, export
        |             |              |
        v             v              v
   DataOps.html  export_center.html  settings.html
   inventory and   output validation  shared policies
   performance     and Excel output   and configuration
        |
        v
 history_viewer.html
```

All applications exchange state through shared browser storage and, where configured, the Google Apps Script cloud synchronization service implemented by `code.gs`.

ONEAPP is the company and shared development foundation.

MerchOps, DataOps, CustomerOps, ControlTower, SmartParser, HistoryViewer, Master, and related applications are separate operational solutions with their own purposes and workflows.

Shared storage or navigation does not make their business meaning identical.

---

## 4. Component catalog

| Component | Type | Status | Primary responsibility |
|---|---|---|---|
| `MerchOps.html` | Web entry | Production | Product master review, pricing, promotion, and Excel-based product-information application workflow; stopped-product state is consumed only for worktable protection and compatibility reads |
| `DataOps.html` | Web entry | Production | Purchase, sales, inventory, stock ledger, cost, and performance analysis; administrator-reviewed out-of-list inventory product selection and positive-count sale resume |
| `SmartParser.html` | Web entry | Production | Parse external documents, resolve duplicate mappings, own supplier exclusions and stopped/sold-out product management, apply approved changes directly to the product master, and record change history |
| `export_center.html` | Web entry | Production | Validate selected results, prepare output payloads, export Excel, and apply approved master changes |
| `settings.html` | Web entry | Production | Manage mappings, pricing rules, visible columns, table views, cloud URL, and shared configuration |
| `history_viewer.html` | Web entry | Production | Inspect product-change history and price trends |
| `Master.html` | Web entry | Pilot | Product-master lookup and administrator-reviewed add/update; initial registration and full replacement are not active in the first phase |
| `Item_manager.html` | Web entry | Pilot / transition | Existing category lookup and product-management route retained until approved feature migration and result verification are complete |
| `orderops/list.html` | Web entry | Pilot | ORDER Q shipment management: four-way structure-first Excel intake, editable order status and order-aware inventory balance/stock-ledger review, purchase-plan editing and recovery, explicit revisioned cloud sharing, and integrated Excel output |
| `coreEngine.js` | Shared library | Production | Storage, pricing, history, export, cloud synchronization, and master-data utilities |
| `code.gs` | Cloud service | Production | Google Apps Script API for master, history, configuration, the finalized DataOps inventory snapshot, and immutable Shipping purchase-plan revisions |

---

## 5. Runtime relationships

### 5.1 Navigation

MerchOps links to SmartParser, export center, settings, and history viewer using relative application URLs.

SmartParser, export center, settings, and history viewer provide a route back to MerchOps.

Changing a filename or moving a file therefore requires a repository-wide navigation review.

Production files must not be reorganized into folders without first updating and testing:

- every relative link;
- every application entry route;
- GitHub Pages deployment paths;
- navigation regression tests;
- external bookmarks or operational links where applicable.

### 5.2 Shared browser state

The current applications share the browser database `MerchOpsDB` and a set of `localStorage` keys.

Important contracts include:

| Contract | Current key or resource | Main consumers |
|---|---|---|
| Product master | `merchMaster_v870`, `MerchOpsDB` | MerchOps, SmartParser, DataOps synchronization, export center, settings, history viewer |
| Master change notification | `merchMaster_sync_trigger` | SmartParser, DataOps, export center, and settings; MerchOps reloads master values on a full page refresh and keeps an open worktable unchanged |
| Change history | `merchHistory_v870` | MerchOps, SmartParser, DataOps, history viewer, cloud backup |
| Parser dictionary | `parserDict_v870` | SmartParser, MerchOps, settings, cloud configuration |
| Parser supplier exclusions | `smartParserExcludeDict_v3012`, compatibility backup `smartParserExcludeDict_backup_v3015` | SmartParser owns writes, search, restore, scoped deletion, and automatic exclusion on the next parse; these keys are preserved without migration |
| Stopped-product management | IndexedDB `MerchOpsDB` keys `merchStoppedProducts_v2`, `pending_shop_status`; local mirrors `merchStoppedProducts_v2`, `pendingShopStatus` | SmartParser owns general stop/resume and management metadata writes; MerchOps reads stopped state for worktable protection; DataOps may perform resume-only writes through `masterAddUpdate.js` after a finalized positive inventory count |
| Stopped-product notification | `merchStopManager_sync_trigger` | SmartParser publishes verified stop-management changes; compatible readers refresh their stopped-state view without rewriting the shared list |
| DataOps post-close sale-resume recovery | `dataops_inventory_master_resume_v1` | DataOps only; records pending or failed sale-resume codes with the already-finalized inventory snapshot revision so retry never repeats inventory closing |
| Margin and pricing rules | `merchMarginRules_v878` | MerchOps, SmartParser, settings, core engine |
| Parser catalog warehouse map | `parserCatalogWarehouseMap_v1` (`{ [catalogName]: warehouseCodeString }`) | SmartParser, settings, core-engine `config_only` backup and restore |
| Mapping configuration | `merchMappings_v870` | MerchOps, settings, cloud configuration |
| Master links | `merchMasterLinks_v870` | MerchOps, settings, cloud configuration |
| Shared cloud URL | `oneapp_cloud_sync_url_v1` | MerchOps, DataOps, settings, history viewer, core engine |
| Legacy cloud URL | `merchCloudUrl_v870` | Compatibility fallback only |
| Active table target | `merchActiveTableTarget_v1` | MerchOps and settings |
| Active table view | `merchActiveTableViewId_v1` | MerchOps and settings |
| Shipping local recovery | IndexedDB `ONEAPPShippingManagementDB` / `workspaces`; `oneapp.shipping.recovery.pointer.v1` and `oneapp.shipping.recovery.meta.v1` | OrderOps only; IndexedDB stores the analysis workspace and inputs, while localStorage stores only the recovery pointer and metadata |
| Shipping table widths | `oneapp.shipping.table-widths.v1` | OrderOps local UI preference only; tab-specific widths are excluded from workspace, IndexedDB recovery, cloud plans, and purchase uploads |
| OrderOps Excel aliases | `oneapp.orderops.excel-mappings.v1` | OrderOps local parser preference only; administrator filename, sheet, and column aliases are excluded from workspace recovery and cloud plans |
| OrderOps purchase-name history | `oneapp.orderops.purchase-history.v1` | OrderOps local input convenience only; up to 30 recent nonblank purchase-place names are excluded from workspace recovery and cloud plans |

A storage-key rename is a schema migration.

It must:

1. provide a compatibility read path;
2. write the new key;
3. preserve existing user data;
4. identify all consumers;
5. include migration validation;
6. include a rollback plan;
7. confirm production behavior after deployment.

### 5.3 Cloud synchronization

`code.gs` exposes the following current API actions:

| Method | Action | Responsibility |
|---|---|---|
| POST | `initSync` | Clear and initialize master and history synchronization data |
| POST | `chunk_master` | Append a chunk of product-master records |
| POST | `chunk_history` | Append a chunk of history records |
| POST | `config` | Save shared configuration |
| POST | `dataops_snapshot_commit` | Validate and atomically finalize one DataOps FULL inventory snapshot |
| POST | `dataops_snapshot_get` | Return the latest finalized DataOps FULL inventory snapshot |
| POST | `shipping_plan_save` | Stage, verify, append an immutable Shipping purchase-plan payload, then publish its index row |
| POST | `shipping_plan_list` | List only indexed Shipping purchase-plan revisions, newest first |
| POST | `shipping_plan_get` | Verify and return an indexed Shipping purchase-plan revision |
| GET | `full` or omitted | Return master, history, and configuration |
| GET | `master_only` | Return product master and summary |
| GET | `config_only` | Return configuration only |

The DataOps snapshot contract is `ONEAPP_DATAOPS_SNAPSHOT_V1`. Its canonical row order is the existing whole-stock ten columns (`단위`, `품목코드`, `품명`, `규격`, `재고`, `기록`, `거래`, `구매가`, `기본`, `적요`) followed by `행사가`. It is a FULL snapshot; consumers must preserve every source LOT row and must not mutate units or treat it as a partial update. MerchOps inventory F8 is an output-only projection of that preserved snapshot: it emits one row per product code, sums stock quantity only, keeps the existing latest representative-LOT price/cost basis, never creates automatic subdivision inventory rows, and blocks output when missing codes, output duplicates, non-zero stock outside the source, total-stock mismatch, or shopping-mall/ERP code-order mismatch is detected.

`dataops_snapshot_commit` writes the inactive `DataOpsSnapshot_A` or `DataOpsSnapshot_B` sheet, verifies schema, SHA-256, row count, cell count, and same-code LOT promotion consistency, then switches the `ONEAPP_DATAOPS_CURRENT_SLOT` Script Property under `LockService`. A failed staging write leaves the previous current slot unchanged. The revision is derived by the server from basis date and canonical hash, so rereading or recommitting the same finalized snapshot returns the same identity.

Both DataOps snapshot actions keep their existing POST action names and snapshot data response shape. `dataops_snapshot_commit` and `dataops_snapshot_get` use the configured shared cloud URL without requesting, storing, sending, or validating an operator token. Existing requests that include a legacy token remain compatible and the server ignores that field. Existing master, history, configuration, and all other API actions, sheets, payloads, and response contracts remain unchanged.

The Shipping cloud contract is `ONEAPP_SHIPPING_PURCHASE_PLAN_V1`, and its embedded analysis contract is `shipping-workspace/v2`. `shipping_plan_save` writes `ShippingPlanStaging`, verifies SHA-256 and declared row/cell counts, appends the immutable payload to `ShippingPlanHistory`, rereads it, and only then appends `ShippingPlanIndex`. The index is the sole visibility boundary: an append that is not indexed is an orphan and must never be returned by list/get, while an index failure leaves every previously finalized revision and the previous latest revision unchanged. Revisions are not automatically deleted.

All Shipping plan actions use POST bodies and the separate `ONEAPP_SHIPPING_PLAN_ACCESS_TOKEN`. They do not read or write DataOps A/B snapshots, `ONEAPP_DATAOPS_CURRENT_SLOT`, `MasterDB`, `HistoryLogs`, or `AppConfig`. Local autosave is not cloud transfer; another computer can retrieve only revisions saved through the explicit cloud-save action.

Changing any action name, payload shape, response shape, authentication rule, or field normalization requires coordinated updates to:

- `code.gs`;
- `coreEngine.js`;
- every calling application;
- automated contract checks;
- backup and restore validation;
- rollback procedures.

### 5.4 Shared engine status

`coreEngine.js` defines the intended ONEAPP shared modules:

- `ONEAPP.STORAGE`
- `ONEAPP.PRICING`
- `ONEAPP.HISTORY`
- `ONEAPP.EXPORT`
- `ONEAPP.CLOUD`
- `ONEAPP.MASTER`
- `ONEAPP.ERRORS`

As of this review, `settings.html`, `SmartParser.html`, `MerchOps.html`, `Master.html`, `Item_manager.html`, and `DataOps.html` explicitly load `coreEngine.js`.

The `merchMarginRules_v878` normalize/select/calculate path is owned by `ONEAPP.PRICING`. SmartParser supplies the catalog warehouse only as calculation context and the final product `단위`; neither SmartParser nor MerchOps infers that unit from product name or specification. Exact non-wildcard warehouse-and-unit matches use the first saved rule, and every other case uses the single `*/*` default rule. Partial wildcard rules are not selected.

`parserCatalogWarehouseMap_v1` trims catalog names and warehouse-code strings without numeric conversion, so values such as `01` retain their leading zero and blank values remain valid. SmartParser and settings read and write this same key directly and synchronize it on browser storage and focus events. The key is carried inside the existing cloud `settingsKeys`; the `code.gs` action and payload schema are unchanged.

The legacy `parserListMarginRules_v1` value is retained for data compatibility but is not read, normalized, migrated, deleted, or rewritten by SmartParser, settings, MerchOps, or the shared pricing engine.

SmartParser uses `ONEAPP.STORAGE.commitMasterStateOrThrow` for stopped-product changes. The product master, `merchStoppedProducts_v2`, `pending_shop_status`, history, local compatibility mirrors, and synchronization notifications form one verified success unit. A history, mirror, notification, or linked-store failure restores the previous master and linked state. Existing `pendingAction` stop/resume records are normalized in place for compatibility and are not migrated to new keys.

MerchOps, DataOps, and SmartParser still contain other overlapping or locally implemented logic.

Treat `coreEngine.js` as the intended shared contract, but do not remove duplicated implementations until compatibility tests prove that each application produces the same output.

A shared-engine consolidation must not be performed as incidental refactoring during an unrelated feature or bug fix.

### 5.5 Client-side safety baseline

The master Excel workflow in `settings.html` uses the shared core engine and applies these controls before production data changes:

- Accept only `xlsx`, `xls`, or `csv` files up to 25 MB and 100,000 data rows.
- Block the entire apply action when a row has no product code.
- Block the entire apply action when a product code is duplicated.
- Block apply when no actual change exists.
- Keep existing products that are absent from the workbook.
- Treat workbook absence as a warning, not a delete instruction.
- Replace the IndexedDB master store in one transaction.
- Verify corresponding `localStorage` writes.
- If a post-write history or notification step fails, restore the previous master and history.
- Keep validation and storage errors visible until the operator fixes the file, retries, or clears the analysis.

Equivalent safety controls must be preserved when another application writes the same master or history contracts.

---

## 6. Primary business flows

### 6.1 External information to shopping-mall update

1. SmartParser reads and normalizes an external document.
2. The operator reviews the matched product.
3. The operator saves approved name, specification, or unit changes.
4. SmartParser applies the saved product information directly to the product master.
5. Every changed field is recorded in the existing history with:
   - before value;
   - after value;
   - timestamp;
   - product code;
   - field;
   - SmartParser route.
6. A currently open MerchOps worktable remains a snapshot.
7. A full MerchOps page refresh loads the changed master values.
8. MerchOps information Excel import/export remains available as an independent bidirectional correction workflow.

### 6.2 Supplier collision and stopped-product management

1. SmartParser removes saved supplier-exclusion entries before matching, without deleting or changing the internal product master.
2. Existing multiple-master candidates and multiple supplier rows that resolve to the same normalized applied code are shown in the duplicate tab and receive `_apply=false`.
3. No duplicate group is automatically merged, overwritten, or reduced to a representative row.
4. The operator resolves a duplicate through search and manual relinking, a reviewed new ERP code, connection cancellation, or supplier exclusion.
5. Saving is blocked while any applied-code duplicate remains, and the duplicate code, count, and duplicate-tab resolution path are shown.
6. SmartParser owns individual, selected, and all-product stop/resume management, including reason and memo updates.
7. Stop/resume writes the master sale state, stopped-product list, existing shop-status queue, history before/after values, SmartParser route, timestamp, and synchronization notifications as one verified unit.
8. MerchOps does not expose the stopped-product management button or panel and does not merge shared stop/resume `pendingAction` records into F7; it retains normalized compatibility reads and stopped-state worktable protection.
9. The existing exclusion, stopped-product, pending-status, history, and notification keys remain unchanged.

### 6.3 Inventory and performance insight

1. DataOps imports purchase, sales, inventory, and stock-ledger information.
2. Product codes and master information are matched using shared mappings.
3. Cost, inventory, and trend results are calculated.
4. MerchOps uses those results as review evidence.
5. DataOps inventory files do not become owners of promotion-theme data.
6. Approved changes are exported and recorded in history where the owning workflow requires it.
7. DataOps file absence, parsing failure, and legitimate empty input must remain distinguishable conditions.
8. DataOps calculations must preserve source quantities unless an explicitly approved business rule changes them.
9. During inventory counting, F6 reads the confirmed local master snapshot without cloud access and opens at most one search row below the selected work row.
10. An out-of-list product uses zero book, inbound, outbound, and system balance; the operator-entered actual quantity is the variance, and an actual quantity of zero is excluded from the inventory list and closing scope.
11. A stopped product with a positive counted quantity becomes a sale-resume target only after the inventory snapshot finalizes successfully.
12. Inventory finalization and sale resume are separate recovery boundaries. A resume failure preserves the finalized snapshot and writes `dataops_inventory_master_resume_v1` so resume can be retried idempotently without another closing.

### 6.4 Configuration and recovery

1. Settings manages shared mappings, pricing rules, columns, views, and cloud URL.
2. Configuration can be backed up to or restored from `code.gs`.
3. Data restoration must preserve:
   - the existing product master;
   - history;
   - compatibility keys;
   - application-readable data shapes.
4. An explicit migration review is required before compatibility data is removed.
5. Backup success must not be assumed from request completion alone.
6. Restored data must be re-read and checked for expected counts and structure.

### 6.5 Master add/update review

1. Master accepts an Excel workbook only as an add/update comparison source when an existing master is present.
2. The operator reviews:
   - new products;
   - changed products;
   - same products;
   - missing products;
   - duplicate codes;
   - blank values;
   - numeric zero;
   - field-specific issues.
3. Products and fields begin unapproved.
4. Only administrator-confirmed and approved values enter the execution scope.
5. Missing products remain in the master.
6. Workbook columns that are absent do not become change candidates.
7. A new product is created only when the final approved values for product name, specification, and unit are all nonblank.
8. Upload omission, administrator-entered blank, blank selection, field exclusion, or partial field approval cannot bypass the required-value rule.
9. A zero-row master is rejected independently at:
   - workbook analysis;
   - execution-plan construction;
   - final commit boundary.
10. A zero-row master must use a separately approved initial-registration workflow.
11. The shared master writer checks the comparison revision.
12. The selected master changes and execution-linked history are completed as one verified unit.
13. A failure restores the previous master and history.
14. Master add/update uses the shared history retention contract, currently 5,000 records.
15. If complete new execution history and existing retained history cannot both fit, the operation stops before the master write.
16. Existing audit records must not be silently truncated to allow the new operation.
17. Storage quota or history verification failure restores the exact previous master and history.
18. Initial registration and full replacement remain unavailable until separate approval, backup, and recovery workflows are implemented.
19. `Item_manager.html` remains available during the transition.
20. `Item_manager.html` is not removed by this phase.

### 6.6 ORDER Q smart file intake

1. The input workbench exposes order, warehouse inventory, purchase, and sales file slots.
2. The existing four-slot source strip is one full drag surface that accepts one to four files and classifies every dropped file by worksheet structure and column names first; touching a named slot opens its single-file picker without adding a separate visible bundle target.
3. Configured sheet-name aliases are used only when structural candidates tie; filename aliases are the final tie-breaker.
4. Administrator column aliases are passed to the real order and inventory parsers without renaming source headers.
5. Order and warehouse inventory remain required. Inventory balance is the warehouse-stock sum minus the current editable order quantity. Purchase rows populate stock-ledger inbound and purchase-place displays, while sales rows populate the stock-ledger `출고수량` display. Sales-only product codes remain visible as zero-stock stock-ledger rows so uploaded outbound history is not omitted; neither optional source changes the existing inventory-balance formula.
6. Mapping aliases and purchase-place input history remain local UI preferences. Parsed optional-source rows travel with the analyzed workspace so local recovery and explicit cloud loading reproduce the same stock-ledger view.
7. The warehouse-inventory view and workbook expose order information as `거래처(수량)단가` in `정보`, while original `적요` and `적요1` text is preserved separately in `적요`. The source `사용` column is omitted and the existing source `창고` column is moved to that leading position.
8. Order-status edits to order quantity, purchase place, warehouse, delivery note, and unit price remain inside the existing `shipping-workspace/v2` optional row fields and are recalculated before local recovery, explicit cloud save, stock-ledger display, purchase selection, and integrated workbook output.
9. Warehouse and manager color assignments are local persistent display preferences. Changing a color saves and applies it immediately, while `전체 다시보기` clears only active warehouse and manager filters and never resets saved colors.
10. The settings modal initially exposes the five most recent local recovery records and reveals the remaining retained records through an explicit `더보기` control; record retention and verification still follow the ten-record recovery contract.
11. System.IO status text states the current operator action in Korean. ORDER Q uses F2 to clear only result search/specification/warehouse/manager view filters, while preserving analyzed data and saved warehouse/manager colors. Filter buttons sit after the column tools, and color assignment is a separate target selector with an explicit white cancel swatch, ten visible pastel choices, and a vivid-color expansion; choosing white removes only the selected warehouse or manager's visible color without clearing other saved assignments, and native color inputs are not embedded in filter buttons.
12. Warehouse inventory accepts both the existing wide warehouse-column layout and the row-based whole-stock layout used by stock-closing workbooks. In the row-based layout, `품명` maps to the product name, `재고` is the editable warehouse quantity only when `수량` is absent and `창고` is present, and the source warehouse code remains read-only; signed quantities and source rows are preserved without changing order, purchase, or sales calculations.
13. The operator-facing product brand is `ORDER Q`, owned by ONEAPP, and its stated purpose is shipment management (`출고관리`). The approved ORDER Q image asset is the visible header identity and is displayed at the same apparent cap height as the ONEAPP wordmark. Existing `orderops` routes, source filenames, storage keys, workspace schemas, cloud actions, and internal compatibility labels remain unchanged until a separately approved internal rename or migration.
14. The integrated ORDER Q workbook contains six sheets: delivery notices, order status, stock ledger, warehouse inventory, purchase upload, and sales upload. The sales-upload sheet follows the administrator-provided 22-column `판매입력` contract and is generated only from current nonzero order allocation rows; previously uploaded sales-history files remain shipment-completion evidence and are never re-exported as new sales vouchers.

---

## 7. Change-impact rules

| Change type | Minimum review scope |
|---|---|
| MerchOps layout or button placement | MerchOps plus navigation and basic load smoke test |
| DataOps display-only change | DataOps representative file load, result display, and basic regression test |
| Product field, canonical name, or Excel mapping | MerchOps, SmartParser, DataOps, export center, settings, history viewer |
| Pricing or margin calculation | coreEngine, MerchOps, DataOps, SmartParser, export center |
| Storage key or IndexedDB schema | Every listed consumer plus migration and rollback |
| Cloud action or payload | code.gs and every listed consumer; Shipping plan actions additionally require Shipping failure-injection and token-isolation tests |
| Navigation path or filename | Every HTML entry point and deployed route |
| Information-change workflow | SmartParser direct master apply, existing history viewer, master refresh behavior, and cloud history backup |
| Supplier exclusion or stopped-product management | SmartParser duplicate separation and save blocking, exclusion persistence and next-parse filtering, master/stopped-list/pending-status/history atomicity, MerchOps compatibility reads and worktable protection, rollback and failure injection |
| Master add/update or master writer | Master, coreEngine, MerchOps refresh, DataOps synchronization, SmartParser, history, backup and rollback |
| DataOps out-of-list inventory master add or post-close sale resume | DataOps F6 location/search/duplicate/zero rules, masterAddUpdate single-product API, coreEngine revision and rollback, Master/SmartParser canonical `판매여부`, stop-management linked state, history, finalized snapshot boundary, and retry idempotency |
| DataOps file classification or parsing | DataOps required/optional file policy, parsing errors, representative operational files, generated workbook, and regression tests |
| OrderOps file classification or parsing | OrderOps four-way structural classification, administrator aliases, required order/inventory validation, current allocation calculations, local recovery exclusion, and integrated workbook regression tests |
| Planned app promotion to production | Manifest update, architecture review, navigation review, and PR validation |
| Function-key behavior | Review only the owning application's workflow; do not assume the same function key has the same meaning in another application |
| Shared approval or audit rule | Every writer and reader of the affected data and history contract |
| Data deletion or migration | All consumers, backup, recovery, migration verification, and production acceptance |

The table defines minimum impact review.

A development-path classification may require a broader review, but must not reduce the minimum review required for a shared contract.

---

## 8. Application lifecycle

Applications use the following statuses:

### Planned

Purpose and scope are being designed.

No production dependency is allowed.

### Pilot

Implementation exists for controlled testing.

Production data writes require explicit safeguards.

### Production

Supported operational application.

### Deprecated

Read-only or migration period.

Replacement and removal date must be recorded.

### Archived

Retained only in Git history or releases.

Not deployed as an active entry point.

A planned application must record:

1. Stable application ID and proposed filename
2. Business purpose and owner
3. Input data
4. Output data
5. Shared contracts it reads
6. Shared contracts it writes
7. Upstream applications
8. Downstream applications
9. Validation method
10. Rollback method
11. Target lifecycle status

### 8.1 Registered planned applications

| Component | Status | Intended purpose | Development trigger |
|---|---|---|---|
| `trend_report.html` | Planned | Provide insight from MerchOps and DataOps results | Resume after both applications produce stable master, history, inventory, and performance data |
| `image_generator.html` | Planned utility | Produce offline-sales images and printed materials for price changes and promotional products | Resume after the MerchOps F9 review payload and downstream F10 print workflow are finalized |

These files may remain in the repository, but they are not production dependencies.

They do not receive feature expansion during the current MerchOps and DataOps development cycle unless separately approved.

Planned applications must not write production master data until they are promoted through architecture review.

ORDER Q is registered as a Pilot on the existing `orderops/list.html` compatibility route. It owns the isolated `shipping-purchase-plan` local/cloud contract, does not call `coreEngine.js`, and does not change MerchOps or DataOps business behavior. Disabling the route and reverting its PR is the code rollback path; already finalized cloud revisions remain append-only operational records and are not deleted by rollback.

---

## 9. Development, validation, release, and recovery

### 9.1 Development-path classification

Every development task is classified before implementation as one of:

1. Fast-track change
2. Standard development
3. Critical development

Classification is based on:

- operational impact;
- number of affected applications;
- shared-contract impact;
- data-write impact;
- rollback difficulty;
- validation requirements;
- production risk.

Code size alone does not determine the classification.

The planning owner records the selected path and its reason before development starts.

If implementation reveals a wider impact or greater risk, the path must be raised to standard or critical development.

A task must not remain fast-track merely because it began as a small request.

### 9.2 Fast-track change

A fast-track change must satisfy all of the following:

- It does not change a storage schema.
- It does not rename or change a shared contract.
- It does not delete, migrate, or transform existing production data.
- It does not change shared Core behavior.
- It does not change multiple applications' business behavior.
- It does not affect authorization, approval, audit, payment, or settlement.
- It can be validated through existing automated checks and a representative operational check.
- It can be easily reverted.
- Its change scope is limited to one application and one clearly bounded function or display area.

Typical examples include:

- wording or help-text changes;
- display-order changes;
- removal of an unnecessary output column;
- limited display-condition fixes;
- a narrow bug that incorrectly classifies a valid file as an error;
- a presentation-only correction that does not alter stored data.

Fast-track process:

1. Confirm the approved requirement.
2. Confirm the latest production source.
3. Apply the minimal change.
4. Run affected automated checks.
5. Run one representative operational check.
6. Commit and push.
7. Use a PR or approved direct path according to repository rules.
8. Merge and deploy.
9. Verify the deployed application.
10. Report the result to the planning owner.

Separate PM review may be omitted.

The planning owner's fast-track classification and development instruction count as pre-approval for the defined fast-track process.

A developer must stop and request reclassification when:

- the affected scope becomes larger;
- a shared module must change;
- unexpected data impact appears;
- existing tests are insufficient;
- another application's business behavior may change;
- rollback is no longer simple.

### 9.3 Standard development

Standard development includes:

- business-rule changes;
- file parsing or input-classification changes;
- multi-function changes;
- multi-file changes;
- meaningful regression risk;
- new validation rules;
- processing-flow changes that retain the existing data structure;
- changes requiring review of an associated application.

Standard development process:

1. Confirm the approved requirement.
2. Start from the latest `main`.
3. Create or use one focused work branch.
4. Change only files inside the declared impact scope.
5. Validate:
   - syntax;
   - application load;
   - affected business logic;
   - representative operational data;
   - relevant regression tests.
6. Commit and push.
7. Open or update one PR.
8. Perform one PM review.
9. If required, apply one grouped development correction.
10. Perform one PM re-review.
11. Confirm merge conditions.
12. Merge.
13. Confirm automatic deployment.
14. Verify the deployed application.
15. Report the final result to the planning owner.

PM review for standard development is limited to:

- agreement with the approved requirement;
- affected logic and files;
- CI results;
- representative operational validation;
- major regression risk;
- major data omission, duplication, or save risk.

Standard development must not be expanded into a full critical-development review without a newly identified critical risk.

Minor recommendations that do not block the approved requirement must be recorded as separate follow-up work rather than expanding the current task.

### 9.4 Critical development

Critical development includes any of the following:

- storage schema change;
- shared-contract change;
- data deletion;
- data migration;
- Master or shared storage-engine change;
- changes affecting multiple applications;
- authorization changes;
- approval-flow changes;
- audit-history changes;
- concurrency or conflict control;
- atomic writes;
- rollback or recovery changes;
- large-volume data processing;
- production outage risk;
- production data-loss risk;
- difficult or uncertain recovery.

Critical development process:

1. Confirm operational requirements with the administrator.
2. Define:
   - current problem;
   - target behavior;
   - unchanged behavior;
   - exception rules;
   - rollback method;
   - production acceptance conditions.
3. Start from the latest `main`.
4. Create a focused work branch.
5. Apply only the approved scope.
6. Validate with:
   - syntax checks;
   - targeted automated checks;
   - cross-application regression checks;
   - safe copied data;
   - failure and rollback scenarios;
   - large-volume tests where applicable.
7. Commit and push.
8. Open or update one Draft PR.
9. Perform detailed PM review.
10. Apply one grouped development correction where required.
11. Perform one PM re-review.
12. Confirm every required merge condition.
13. Merge.
14. Confirm automatic deployment.
15. Verify production behavior.
16. Confirm data, history, backup, and recovery results where applicable.
17. Report the final result to the planning owner.

Production source data must not be used for destructive validation.

Use:

- a safe copy;
- a separate browser profile;
- a test environment;
- a controlled pilot dataset;

as appropriate.

Critical development must not be merged while a material validation item remains unknown.

An unknown item must be reported as `not validated`, not assumed to be safe.

### 9.5 PM validation outcome

PM validation must end with one of:

- Merge recommended
- Conditional merge recommended
- Merge blocked

#### Merge recommended

Required validation is complete and no blocking issue remains.

#### Conditional merge recommended

Code-level validation is acceptable, but explicit pre-merge or operational conditions remain.

Every condition must be listed.

#### Merge blocked

A blocking defect, unacceptable risk, missing critical evidence, or unresolved shared-contract impact remains.

### 9.6 Review and correction limit

The standard collaboration limit is:

1. PM first review
2. One grouped developer correction
3. One PM re-review
4. Final PM decision

Problems must be grouped and delivered together.

They must not be sent one at a time in a repeating development-review loop.

Additional validation may be allowed only for:

- data-loss risk;
- payment or settlement;
- authentication or authorization;
- security;
- production outage;
- irreversible recovery risk.

### 9.7 Final reporting ownership

Developers report the following to the planning owner:

- implementation result;
- changed files;
- test result;
- PR status;
- merge and deployment status;
- deployed operational result;
- unresolved technical limits.

PM reports the following to the planning owner:

- validation scope;
- confirmed findings;
- remaining risks;
- items not independently validated;
- merge recommendation;
- pre-merge conditions;
- post-deployment checks.

The planning owner provides the final user-facing report after:

- development;
- required PM validation;
- merge;
- deployment;
- production verification;

are complete.

Developers and PM reviewers must not represent their own step as final completion of the entire collaboration process.

### 9.8 Release terminology

Development status uses the following stages:

| Stage | Reporting term | Completion condition |
|---|---|---|
| 1 | Code creation and review | Code drafted and impact scope reviewed |
| 2 | Code application and testing | Project files updated and local tests passed |
| 3 | PR registration and review | Commit, push, and PR registration completed; review in progress |
| 4 | PR merge and deployment | PR merged and automatic deployment completed |
| 5 | Production operation confirmed and complete | Production verification passed |

Terminology rules:

- `Applied` means stage 2 only.
- `PR registered` means stage 3.
- `Deployment complete` means stage 4.
- `Final complete` is used only after stage 5.
- `Updated` must be accompanied by the current stage.
- CI success alone is not production completion.

### 9.9 Recovery

- Use a stable Git tag for a verified production point.
- Use GitHub Revert on the breaking PR or create a rollback PR from the verified commit.
- Do not depend on stale `_test` copies for restoration.
- Preserve required operational data before migrations or high-risk writes.
- Verify restoration by reading back expected counts and structures.
- If an emergency alternate URL is required, keep one explicitly named preview or stable page with:
  - an owner;
  - a purpose;
  - a verification date.
- An alternate URL is a validation entry point, not the source of truth.
- A failed deployment must not be reported as successful merely because the merge completed.
- Recovery completion requires the affected operational workflow to be checked again.

---

## 10. Governance

- `app-manifest.json` is the machine-readable application inventory.
- This document defines architectural intent, shared contracts, impact rules, and release policy.
- `AGENTS.md` defines shared working rules for Codex and AI development tools.
- Application-specific project instructions define role-specific behavior.
- A PR that adds, renames, promotes, deprecates, or removes an application must update:
  - `app-manifest.json`;
  - this architecture document.
- A PR that changes a shared data contract must list every reviewed consumer.
- Unknown planned applications remain outside production dependencies until registered.
- Role-specific instructions must not weaken shared data and recovery contracts.
- A fast-track classification must not be used to bypass a shared-contract review.
- An application owner may require stricter validation than the minimum defined here.
- A difference between documentation and actual code must be reported before either is assumed correct.
- Architecture and manifest changes require explicit review.
- These documents must not be rewritten incidentally during unrelated feature work.

---

## 11. Development roadmap

Roadmap work is delivered as separate pull requests and verified after each merge.

### 11.1 Baseline and automated checks

- Establish a verified recovery point.
- Add JSON validation.
- Add HTML validation.
- Add JavaScript syntax validation.
- Add navigation checks.
- Add application-load checks.
- Keep repository contract validation aligned with documented architecture.

### 11.2 Client-side safety

- Validate imported rows before apply.
- Block ambiguous partial writes.
- Protect browser storage writes.
- Automatically restore failed master applies.
- Display actionable errors.
- Limit imported file:
  - type;
  - size;
  - row count.
- Distinguish missing optional files from parsing failures.
- Preserve source values including blank and numeric zero unless an approved rule changes them.

### 11.3 Cloud service protection

- Add request validation and access control to `code.gs`.
- Separate:
  - read actions;
  - write actions;
  - destructive actions.
- Reject unknown actions.
- Record authenticated actors where an approved identity system exists.
- Preserve compatibility until every consumer is updated and validated.

### 11.4 Atomic cloud backup

- Upload into a staging session.
- Verify counts and integrity.
- Finalize only after every chunk succeeds.
- Preserve the previous backup on:
  - interruption;
  - validation failure;
  - incomplete upload;
  - mismatched counts.
- Verify master and history together where they form one operational recovery unit.

### 11.5 Application-specific output stability

#### MerchOps

- F7 applies reviewed work to the master and does not consume shared stop-management `pendingAction` records.
- F8 creates the Excel output from the current work without changing the master.
- SmartParser information changes are already applied directly and are not queued into F7.
- Supplier exclusion and stopped/sold-out product management are SmartParser-owned workflows; MerchOps keeps read-only stopped-state protection for its worktable.
- F9 sends the current result to Export Center for a separate review-and-output flow.

#### DataOps

- F6 opens one out-of-list product search row below the selected inventory row and uses only the confirmed local master snapshot.
- F9 downloads the combined inventory, ledger, and analysis workbook.
- After F9 finalizes the FULL inventory snapshot, stopped products with positive newly counted inventory are resumed through the shared atomic master/history path. Resume failure is retried separately and never repeats the finalized closing.
- F10 prints the DataOps result.
- F8 is currently unassigned.
- F8 remains reserved until a separate requirement is approved.

#### ORDER Q

- F3 focuses the integrated search field and keeps the caret ready for immediate input.
- F4 opens Smart Input, Enter starts shipment analysis, and a successful multi-file drop captures Enter for analysis so an earlier focused control is not reactivated; refresh remains an explicit button action without a function-key shortcut.
- F5 opens Order Status, F6 opens the Stock Ledger, F7 opens Warehouse Inventory, and F8 saves the reviewed cloud revision.
- F9 prints only the current visible tab state, including active filters, rows, column visibility and column order, on A4 portrait.
- F10 downloads the complete integrated workbook regardless of current screen filters, hidden columns or column order.
- The existing four-file source strip classifies one to four dropped files by columns and sheet structure before sheet-name and filename aliases; each named slot remains a single-file touch selector, and no persistent bundle panel is added.
- The result tabs are ordered Validation Summary, Order Status, Stock Ledger, and Warehouse Inventory; the former Unshipped Status label is Order Status.
- Result tables use a light Excel-style cell grid. Editors do not draw a second border inside the table cell, and the active editable cell receives a light focus fill.
- The default Order Status sequence is warehouse, customer, manager, product code, product name, specification, order, unit price, all warehouse-inventory columns, notice, and purchase. Warehouse is read-only; order, unit price, notice, and purchase remain editable.
- Warehouse inventory shows `정보` as `거래처(수량)단가`, preserves order notes in a separate `적요` column, omits `사용`, and moves the existing `창고` source column to the leading position on screen and in the integrated workbook.
- Purchase input supplies stock-ledger inbound/purchase-place displays and sales input supplies the `출고수량` display, including zero-stock rows for product codes absent from the current inventory file. The inventory balance remains warehouse stock minus the current order quantity.

Function keys are application-owned behavior.

They may share:

- validation;
- backup;
- download-status;
- audit utilities.

Their business meaning must not be unified merely because the key number is the same.

### 11.6 Dependency and shared-engine hardening

- Pin or self-host critical browser dependencies.
- Introduce content-security controls.
- Consolidate compatible shared logic through `coreEngine.js`.
- Do not remove local implementations until equivalence is proven.
- Add consumer-contract tests before shared-logic replacement.
- Separate shared-engine hardening from unrelated operational fixes.

### 11.7 Collaboration-path verification

The three development paths must themselves be periodically reviewed.

#### Fast-track verification

Confirm that fast-track work:

- remains limited in scope;
- does not bypass shared-contract review;
- completes automated and representative operational checks;
- reaches production verification without unnecessary PM delay.

#### Standard-development verification

Confirm that standard PM review:

- remains focused;
- does not expand into critical review without cause;
- provides grouped feedback;
- completes at most one correction and one re-review by default.

#### Critical-development verification

Confirm that critical development:

- includes copied-data validation;
- includes rollback evidence;
- identifies unresolved production risks;
- does not merge on assumptions.

After the production MerchOps and DataOps workflows are stable, planned applications may be reviewed individually for promotion to Pilot status.
