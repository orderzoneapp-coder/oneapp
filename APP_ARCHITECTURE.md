# ONEAPP Application Architecture

- Repository: orderzoneapp-coder/oneapp
- Architecture document version: 1.6.0
- Last reviewed: 2026-08-28
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
| `nexus/index.html` | Web entry | Production | Public login, first-owner bootstrap, and invitation activation entry; no business token is entered here |
| `nexus/home/index.html` | Web entry | Production | Permission-filtered normal-user work home shown after authentication |
| `nexus/company.html` | Web entry | Production | Authenticated company-profile lookup for every permitted user and owner-master-only maintenance of company fields, accounting periods, addresses, and reviewed local OCR results |
| `nexus/admin/index.html` | Web entry | Production | Owner-master-only user, permission, service-secret, recovery, and audit administration |
| `nexus/server/nexus-auth-gateway.gs` | Apps Script service | Production | Authentication database, opaque sessions, permission enforcement, audit logging, and server-only credential proxy to the retained cloud service |
| `MerchOps.html` | Web entry | Production | Product master review, pricing, promotion, and Excel-based product-information application workflow; stopped-product state is consumed only for worktable protection and compatibility reads |
| `DataOps.html` | Web entry | Production | Purchase, sales, inventory, stock ledger, cost, and performance analysis; administrator-reviewed out-of-list inventory product selection and positive-count sale resume |
| `SmartParser.html` | Web entry | Production | Parse external documents, resolve duplicate mappings, own supplier exclusions and stopped/sold-out product management, apply approved changes directly to the product master, and record change history |
| `export_center.html` | Web entry | Production | Validate selected results, prepare output payloads, export Excel, and apply approved master changes |
| `settings.html` | Web entry | Production | Manage mappings, pricing rules, visible columns, table views, cloud URL, and shared configuration |
| `history_viewer.html` | Web entry | Production | Inspect product-change history and price trends |
| `Master.html` | Web entry | Pilot | Product-master lookup and administrator-reviewed add/update; initial registration and full replacement are not active in the first phase |
| `Item_manager.html` | Web entry | Pilot / transition | Existing category lookup and product-management route retained until approved feature migration and result verification are complete |
| `orders.html` (`orderops_list.html`, `orderops/list.html`) | Web entry | Pilot | ORDER Q shipment management: `orders.html` is the primary public entry and deploys the complete root ORDER Q source; the existing root mirror and canonical compatibility route remain synchronized. The app provides four-way structure-first Excel intake, read-only DataOps finalized-inventory and SmartInput order-ledger adapters, editable order status and order-aware inventory balance/stock-ledger review, purchase-plan editing and recovery, explicit revisioned cloud sharing, and integrated Excel output |
| `orderq/index.html` (`input.html`, `parser.html`, `collector.html`, `cloud.html`) | Web entry group | Pilot | ORDER Q vNext manual/text order intake, source-preserving historical collection, order-to-sales fulfillment evidence, parser evidence review, and token-protected revisioned cloud sync; existing `orderops/` remains an independent compatibility route |
| `smartinput/index.html` | Web entry | Pilot | Standalone SmartInput workbench for order, purchase, sale, and estimate source capture through direct, file, text, clipboard, photo OCR, and voice STT inputs; source-preserving automatic analysis; configurable entry fields; local estimate catalog; and order delivery to the ORDER Q vNext ledger |
| `coreEngine.js` | Shared library | Production | Storage, pricing, history, export, cloud synchronization, and master-data utilities |
| `code.gs` (`company-profile.gs`) | Cloud service | Production | Google Apps Script API for master, history, configuration, the finalized DataOps inventory snapshot, immutable Shipping purchase-plan revisions, and revisioned server-owned company profile data |

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

### 5.2 NEXUS authentication and authorization

`nexus/index.html` is the only public application entry. The first completed bootstrap creates exactly one `OWNER_MASTER`; no later request can create or transfer that role. The owner master invites users, assigns `FULL_ACCESS`, `VIEWER`, or non-administrative `CUSTOM` permissions, soft-deletes users, restores them for 30 days, configures business service credentials, and inspects the audit trail from the separate `nexus/admin/index.html` screen. Signed-in users enter `nexus/home/index.html`, where only permitted applications are shown.

`nexus/server/nexus-auth-gateway.gs` is deployed as a standalone Apps Script Web App executing as its owner. Its private spreadsheet stores users, password verifiers, sessions, rate limits, and audit records. Passwords are transformed in the browser with PBKDF2-SHA-256 before transmission and are never stored as entered. The gateway adds its own private HMAC pepper, issues random opaque 12-hour sessions, revokes all user sessions on deletion, and rejects every protected request whose session or permission is invalid. Authentication state is held only in per-tab `sessionStorage`; persistent browser storage must not contain an authentication session or a business credential.

The gateway is also the only browser-facing route to protected Apps Script business actions. Under `NEXUS_AUTH_V2`, application clients call `ONEAPP_AUTH.gateway(operationId, payload)` with POST only. The server registry fixes allowed applications, required user permission, upstream action, Foundation/DataOps/ORDER Q/Shipping boundary, READ/WRITE credential, allowed payload fields, response sanitizer, and audit category. Browser input cannot select an upstream URL, raw action, actor, user, application, request identity, or credential. Eight boundary credentials remain in NEXUS Script Properties and four binding sets in ONEAPP validate fixed-length SHA-256 digests, service roles, scope, status, and rotation metadata. The upstream actor is always `NEXUS_GATEWAY`; the signed-in user is an audit subject only. V1 remains a separate `LEGACY_V1` server compatibility path and is not used by V2 application consumers.

`foundation.replace_all` is the only V2 full-replacement operation. It requires both `foundation.write` and `foundation.replace`; the ONEAPP server writes Master, History, and Config to the inactive A/B slot under a script lock, verifies the complete staged dataset, and only then switches the active pointer. A timeout or write failure before activation leaves the previous slot active. V2 browser consumers cannot invoke the legacy `initSync`, `chunk_master`, or `chunk_history` sequence; the authenticated `LEGACY_V1` Gateway compatibility path stages the same inactive slot and activates it only after the final config verification.

The owner master is the only administrative authority. `FULL_ACCESS` means all business permissions and explicitly excludes `admin.users`, `admin.services`, `admin.audit`, and `admin.company`; custom profiles cannot contain an `admin.*` permission. The server, not the menu, is authoritative. UI filtering is convenience only, and every proxy or administration request is independently authorized by the gateway.

### 5.2.1 NEXUS common header

`nexus/common/nexus-top.js` is the shared `<nexus-top>` web component. `nexus/common/apps-config.js` is the single runtime mapping from application IDs to the four work groups and the SmartInput global entry. The default header flow is Foundation (`기준정보`), Pricing (`가격·시세`), SmartInput, Shipping (`주문·출고`), then Inventory (`재고·정산`), with the existing management/operations divider between Pricing and SmartInput. SmartInput remains the fixed first entry in the operations section, while its visibility is managed in the same header-settings list as the work groups. The five entries render as text tabs with a desaturated selected background and no underline while preserving `aria-current`, ordering, hiding, mobile horizontal access, and application identity contracts. The Light/Dark switch is always available beside the tabs and is not duplicated in the settings drawer. Display names and filenames are not app identity contracts.

Header preferences are local display state under the `oneapp.nexus.v1.` prefix. Work-group order and visibility are stored separately from per-application favorites and hidden state. A hidden current work group is rendered temporarily without changing the stored preference.

The current application reports only its own save, synchronization, warning, and error state through `window.NEXUS_TOP.reportStatus`. Concurrent signals use the fixed priority `error > warning > progress > normal`; snapshots from other applications are historical and must include their last-check time rather than appear live. `nexus:before-navigate` is the cancelable leave-guard event owned by the current application. After navigation is allowed, the shared header owns a same-tab loading cover that uses no external image assets and carries the current light or dark mode in a short-lived destination marker in `sessionStorage`. Existing consumers clear it after the destination `load`; an opt-in consumer with `data-nexus-ready-strategy="app"` clears it only after full server authentication, current authorization context, and its minimum interactive shell are ready and it dispatches `nexus:app-ready`. Cached or expired authorization must never expose the data shell. To avoid a cold refresh on normal navigation without weakening that gate, the authentication client refreshes its five-minute client bundle 90 seconds before expiry while the tab is active and rechecks freshness on `pageshow`, visibility return, and header-link intent. BroadcastChannel refresh signals never copy the tab-scoped session token. The bounded 12-second safety timeout remains the final recovery path.

Every consumer reserves `--nexus-top-height`; the shared component fixes it at 64px on desktop and 104px at 680px and below, and each consumer includes a light-DOM fallback. Failure to load or initialize the header must leave the application boot path independent and show only the retryable NEXUS fallback. The complete event and API examples are documented in `nexus/common/README.md` and registered as the `nexus-header` shared contract in `app-manifest.json`.

The authenticated user action opens a compact account panel. `내 회사정보` opens the read route for every user, `업무 홈` returns to the permission-filtered home, and the separate logout control remains available. This panel does not grant write authority; the company application and both server layers independently require `OWNER_MASTER` through `admin.company` for writes.

`smartinput/index.html` is a NEXUS-header consumer during its standalone pilot. Its public route is `/smartinput/`; it is registered in the all-apps list and as the fixed-position SmartInput global entry. SmartInput remains part of the Shipping application group for application-list organization and status routing.

### 5.2.2 NEXUS company profile

`nexus/home/index.html` reads the company summary through `company.profile_read` and renders explicit `LOADING`, `EMPTY`, `READY`, or `ERROR` states. `nexus/company.html` owns the view/edit experience. Every authenticated Foundation reader can view the profile and accounting periods; only the unique owner master can write, manage accounting periods, review OCR extraction, create a deployment backup, or run the task-scoped migration. `FULL_ACCESS`, `VIEWER`, and `CUSTOM` roles never receive `admin.company`.

The canonical state is server-owned by `company-profile.gs` in `CompanyProfile_NEXUS`, `CompanyAccountingPeriods_NEXUS`, `CompanyAudit_NEXUS`, `CompanyBackups_NEXUS`, and `CompanyMigrations_NEXUS`. Browser `localStorage`, `sessionStorage`, defaults, and per-load seeding are not company data stores. Profile and accounting writes require the current company revision, run under the common script lock, append an audit record, verify the saved snapshot, and restore every affected sheet snapshot if any step fails.

The one-time migration is identified by `NEXUS-COMPANY-20260827-01`. It updates only approved source fields, records explicit unknowns as `null`, preserves `false`, stores business types/items as arrays, keeps every unprovided existing value, and records an immutable applied marker so reruns and later deployments cannot overwrite user changes. A deployment backup is recorded before the first production application. Rollback uses that backup plus the pre-deployment Apps Script immutable version; records are not silently deleted.

Business-certificate images and PDFs are validated by file signatures and processed locally with PDF.js and Tesseract.js. Only the extracted allow-listed field values, field confidence, source labels, and document signals may cross the gateway for validation. The source file, raw OCR text, representative birth date, resident number, and other sensitive document content are never persisted or logged. Address lookup reuses the existing Daum Postcode service and keeps address 1 and address 2 independent.

### 5.2.3 NEXUS application fixed layout

`nexus/common/nexus-app-ui.css` is the fixed application-layout interface under the common header. The common header spans the browser width; supported application workspaces use the shared `--nexus-content-max-width` and fixed component dimensions. No alternate spacing preference, event, or saved value is read or applied. `nexus/common/nexus-ui-contract.js` is the code registry for application rollout status and registered exceptions; `nexus/common/NEXUS_APP_UI_CONTRACT.md` is the matching operator and regression record.

Foundation is the first pilot consumer. `Master.html`, its embedded `partner_db.html`, and `Item_manager.html` consume the contract. Master uses one light application header containing the Foundation title and product/customer target tabs; the former black `MASTER · target` bar is prohibited. The application header spans the browser width independently from the centered `--nexus-content-max-width` workspace. A second tool row always exposes the current parent and the `조회`/`일괄관리` child routes; search, counts, and work actions occupy the right-side group. Product/customer lookup remains the default route, while new registration is a work action and batch management is a persistent child route. The embedded customer workbench consumes the same theme tokens and accepts same-origin `ONEAPP_NEXUS_THEME` updates without reload. Product and customer tables remain horizontally scrollable data structures on narrow screens instead of converting to cards. MerchOps, DataOps, ORDER Q, and Smart Parser retain their current UI as registered staged exceptions until their separate rollout gates pass.

### 5.3 Shared browser state

The current applications share the browser database `MerchOpsDB` and a set of `localStorage` keys.

The NEXUS company profile is an explicit exception to browser-owned state: its canonical record, revisions, accounting periods, audit, backups, and migration marker exist only in the protected server sheets described in 5.2.2.

Important contracts include:

| Contract | Current key or resource | Main consumers |
|---|---|---|
| Company profile | Protected Apps Script sheets owned by `company-profile.gs`; no browser storage key | NEXUS work home and `nexus/company.html` through the authenticated gateway |
| Product master | `merchMaster_v870`, `MerchOpsDB` / `master_products`; B+ state `oneapp.foundation.product-backup-state.v1` is committed atomically with each master replacement | MerchOps, SmartParser, DataOps synchronization, export center, settings, history viewer, ORDER Q 수기입력(읽기 전용 검색) |
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
| OrderOps order-view presets | `oneapp.orderops.order-view-presets.v1` | ORDER Q per-view local display preferences only; named search/filter/sort conditions, visible columns, column order, and saved widths may be captured, and one preset per view may be marked as the access-time default. Presets remain excluded from workspace recovery and cloud plans |
| ORDER Q vNext local ledger | IndexedDB `oneapp-orderq-vnext` v17 | ORDER Q vNext and standalone SmartInput order delivery; operational orders, historical source batches, sales/purchase/ledger/inventory facts, fulfillment links, parser evidence, the legacy sync queue, and additive Foundation B+ outbox/recovery/quarantine stores |
| Foundation B+ device identity | `oneapp.foundation.device-id.v1` | Product and Customer backup clients; identifies the originating browser installation without replacing product/customer IDs |
| ORDER Q vNext access token | `oneapp_orderq_access_token_v1` | Local cloud request credential only; excluded from IndexedDB records, imports, recovery payloads, and sync entities |
| ORDER Q manual-entry defaults | `oneapp.orderq.manual-defaults.v1` | ORDER Q vNext only; restores the last shipment warehouse and transaction type for the next new manual order in the same browser |
| SmartInput local draft | `oneapp.smartinput.draft.v1` | SmartInput only; preserves target tab, ordered source records and active source, per-source staging rows, the source-row application ledger, source batches and source-to-row links, administrator edits, matching state, responsive panel state, and delivery result. It is not a final order ledger or a cloud backup contract. |
| SmartInput delivery history | `oneapp.smartinput.delivery-history.v1` | SmartInput only; retains the latest 30 local delivery references for operator continuity. Final order state and durable business history remain owned by ORDER Q. |
| SmartInput local data and input templates | IndexedDB `oneapp-smartinput` v4 | SmartInput pilot only; stores tax-to-delivery link groups, temporary-delivery metadata, confirmed source-orderer mappings, delivery-policy and form-layout settings, device-local estimate documents, source images, and revisioned `inputTemplates`. A v3-to-v4 upgrade adds only the template store and preserves every existing record. Existing-template imports are structurally read-only: they stage values without changing mappings, display names, order, or template revision, and reach the work table only after explicit application. It is not customer canonicalization and does not merge orders. |
| SmartInput recent drafts | `oneapp.smartinput.drafts.v1` | SmartInput only; retains up to 30 device-local mode drafts for reopen and split-order continuity. ORDER Q remains the owner after delivery. |

A storage-key rename is a schema migration.

It must:

1. provide a compatibility read path;
2. write the new key;
3. preserve existing user data;
4. identify all consumers;
5. include migration validation;
6. include a rollback plan;
7. confirm production behavior after deployment.

### 5.4 Cloud synchronization

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
| POST | `orderq_sync_push` | Token-protected incremental ORDER Q entity push with revision conflict, source-message duplicate prevention, and recoverable order-bundle writes |
| POST | `orderq_sync_pull` | Token-protected incremental ORDER Q entity pull after the device cursor |
| POST | `orderq_order_head` | Token-protected latest ORDER Q order bundle and revision lookup |
| POST | `nexus_gateway_foundation_backup_head_read` | Return product/customer Head metadata and Primary metadata without returning or applying business payloads |
| POST | `nexus_gateway_foundation_backup_product_write` | Validate Primary and three-way base Revision CAS, then stage, verify, and publish an immutable Product Snapshot |
| POST | `nexus_gateway_foundation_backup_customer_events_write` | Validate ordered Customer Events and publish one immutable Customer backup Revision |
| POST | `nexus_gateway_foundation_backup_customer_snapshot_write` | Validate Customer references and publish a periodic immutable Customer Snapshot |
| POST | `nexus_gateway_foundation_backup_version_list` / `nexus_gateway_foundation_backup_version_read` | List or read a company-scoped immutable version for administrator restore preview only |
| POST | `nexus_gateway_foundation_backup_restore_audit_write` | Record the verified outcome of an administrator-approved local restore |
| POST | `nexus_gateway_foundation_device_status_read` / `register` / `promote` | Read device status, register a device, or promote a new Primary with an incremented Epoch |
| GET | `full` or omitted | Return master, history, and configuration |
| GET | `master_only` | Return product master and summary |
| GET | `config_only` | Return configuration only |

The DataOps snapshot contract is `ONEAPP_DATAOPS_SNAPSHOT_V1`. Its canonical row order is the existing whole-stock ten columns (`단위`, `품목코드`, `품명`, `규격`, `재고`, `기록`, `거래`, `구매가`, `기본`, `적요`) followed by `행사가`. It is a FULL snapshot; consumers must preserve every source LOT row and must not mutate units or treat it as a partial update. MerchOps inventory F8 is an output-only projection of that preserved snapshot: it emits one row per product code, sums stock quantity only, keeps the existing latest representative-LOT price/cost basis, never creates automatic subdivision inventory rows, and blocks output when missing codes, output duplicates, non-zero stock outside the source, total-stock mismatch, or shopping-mall/ERP code-order mismatch is detected.

`dataops_snapshot_commit` writes the inactive `DataOpsSnapshot_A` or `DataOpsSnapshot_B` sheet, verifies schema, SHA-256, row count, cell count, and same-code LOT promotion consistency, then switches the `ONEAPP_DATAOPS_CURRENT_SLOT` Script Property under `LockService`. A failed staging write leaves the previous current slot unchanged. The revision is derived by the server from basis date and canonical hash, so rereading or recommitting the same finalized snapshot returns the same identity.

Both DataOps snapshot actions keep their existing POST action names and snapshot data response shape. `dataops_snapshot_commit` and `dataops_snapshot_get` use the configured shared cloud URL without requesting, storing, sending, or validating an operator token. Existing requests that include a legacy token remain compatible and the server ignores that field. Existing master, history, configuration, and all other API actions, sheets, payloads, and response contracts remain unchanged.

### 5.4.1 Foundation B+ Local Primary backup

`FOUNDATION_BACKUP_V1` unifies the product and Customer operating policy while keeping their local backup engines separate. The browser-local database is the daily operational source. The server is an immutable version, lineage, recovery-transfer, and audit authority; it is not permitted to push or automatically apply product or Customer payloads to a browser.

- Product writes commit the whole product master, permanent `productId`, local Revision, hash, and one coalesced pending Snapshot in the same `MerchOpsDB` transaction. The worker waits for a 30-second quiet period and never waits longer than five minutes.
- Customer writes commit Customer/Alias/Event data, the local Revision, and a Customer Event outbox row in one `oneapp-orderq-vnext` v17 transaction. The worker uses a 10-second quiet period, sends at 50 events, and never waits longer than 60 seconds. A periodic full Customer Snapshot establishes or compacts the lineage.
- On the server, `baseServerRevision < Head` returns `DIVERGED`; equality alone may create the next immutable Revision; `baseServerRevision > Head` returns `REVISION_AHEAD_INVALID`. A rejected request never advances Head and the client never rewrites its base Revision automatically.
- A backup requires a registered current Primary device and matching `primaryEpoch`. Promotion is an explicit administrator operation and increments the Epoch so an earlier Primary can no longer write.
- Empty local Customer data is `RESTORE_REQUIRED`, not a trigger for Cloud Pull. Populated Customer data renders from local storage and never starts background Pull. Automatic reads are limited to Head, count, hash, version availability, and device metadata.
- The pre-B+ Customer sync queue is retained, copied into `foundationLegacyQuarantine`, and marked `QUARANTINED_LEGACY_SYNC`/`localOnly`. It is neither deleted nor replayed automatically. The actual quarantined count—not a hard-coded value—is displayed for the recovery inventory.
- Restore requires a version list/read, SHA-256 verification, local/server comparison, duplicate and reference checks, a local safety Snapshot, explicit administrator approval, an atomic local replacement, reread verification, and local/server audit. A zero-row or 20%-plus reduction requires a second destructive-change confirmation. Unsynced pre-restore outbox rows are retained as `QUARANTINED_PRE_RESTORE`.
- Feature flags default to backup enabled and automatic Pull disabled. A failure to read flags must preserve local data and must never enable automatic Pull.

Server sheets are append-only `FoundationBackupVersion`, `FoundationBackupChunk`, `FoundationCustomerEvent`, `FoundationDevice`, `FoundationPrimary`, `FoundationOperationResult`, and `FoundationRestoreAudit`; `FoundationBackupHead` is an append-only sequence whose newest verified row is the logical Head. Payload chunks are written and reread before a Version and Head are made visible. A response-loss retry with the same backup ID returns the prior result without consuming another Revision.

The Shipping cloud contract is `ONEAPP_SHIPPING_PURCHASE_PLAN_V1`, and its embedded analysis contract is `shipping-workspace/v2`. `shipping_plan_save` writes `ShippingPlanStaging`, verifies SHA-256 and declared row/cell counts, appends the immutable payload to `ShippingPlanHistory`, rereads it, and only then appends `ShippingPlanIndex`. The index is the sole visibility boundary: an append that is not indexed is an orphan and must never be returned by list/get, while an index failure leaves every previously finalized revision and the previous latest revision unchanged. Revisions are not automatically deleted.

All Shipping plan actions use POST bodies and the separate `ONEAPP_SHIPPING_PLAN_ACCESS_TOKEN`. They do not read or write DataOps A/B snapshots, `ONEAPP_DATAOPS_CURRENT_SLOT`, `MasterDB`, `HistoryLogs`, or `AppConfig`. Local autosave is not cloud transfer; another computer can retrieve only revisions saved through the explicit cloud-save action.

ORDER Q vNext actions use `ONEAPP_ORDERQ_ACCESS_TOKEN`, with the existing Shipping token as a compatibility fallback when a separate ORDER Q token has not been configured. Order and order-item writes are staged in `ORDER_TXN_LOG`, verified as a bundle, and restored to the previous bundle after a partial failure. Historical import facts are synchronized in shared purpose sheets; customer-specific sheets are prohibited.

M9/M10 official ORDER Q commands use `ORDERQ_M9_TXN_LOG` as a bounded recovery journal. Full before/mutation payloads are split into digest-verified chunk rows below the Google Sheets per-cell limit; the durable primary row stores only count, key-set digest, content digest, cursor, ledger, and command linkage. A non-terminal official transaction blocks pull and further official commands until complete commit verification or complete rollback. Migration V2 and official-command journals have separate schema identifiers and recovery scanners.

Changing any action name, payload shape, response shape, authentication rule, or field normalization requires coordinated updates to:

- `code.gs`;
- `coreEngine.js`;
- every calling application;
- automated contract checks;
- backup and restore validation;
- rollback procedures.

### 5.5 Shared engine status

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

### 5.6 Client-side safety baseline

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

### 6.5 Master add/update and selected deletion review

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
21. Product deletion is available only for explicitly selected, already-saved products in `Item_manager.html`; unsaved edits must be saved or discarded first.
22. Deleting every remaining product is prohibited. Initial registration, full replacement, and full reset retain their separate approval and recovery boundary.
23. A selected deletion removes the product master rows, matching stopped-product metadata, and matching pending shop-status rows as one revision-checked operation. Official deletion history and local compatibility mirrors are verified in the same success unit, and any failure restores the prior state.
24. Product deletion does not erase historical orders, sales, purchases, ledgers, or prior audit records. Those records keep their snapshotted product identity.
25. A successful local deletion is not represented as a cloud deletion until the operator explicitly runs the existing cloud synchronization action.

### 6.6 ORDER Q smart file intake

1. The input workbench exposes order, warehouse inventory, purchase, and sales file slots.
2. The existing four-slot source strip is one full drag surface that accepts one to four files and classifies every dropped file by worksheet structure and column names first; touching a named slot opens its single-file picker without adding a separate visible bundle target.
3. Configured sheet-name aliases are used only when structural candidates tie; filename aliases are the final tie-breaker.
4. Administrator column aliases are passed to the real order and inventory parsers without renaming source headers.
5. Order and warehouse inventory remain required. Inventory balance is the warehouse-stock sum minus the current editable order quantity. Purchase rows populate stock-ledger inbound and purchase-place displays, while sales rows populate the stock-ledger `출고` display. Sales-only product codes remain visible as zero-stock stock-ledger rows so uploaded outbound history is not omitted; neither optional source changes the existing inventory-balance formula.
6. Mapping aliases and purchase-place input history remain local UI preferences. Parsed optional-source rows travel with the analyzed workspace so local recovery and explicit cloud loading reproduce the same stock-ledger view.
7. The warehouse-inventory view and workbook expose order information as `거래처(수량)단가` in `정보`, while original `적요` and `적요1` text is preserved separately in `적요`. The source `사용` column is omitted, product identity remains first, and the trailing price field named `창고` in the source is displayed as `창고단가` without moving it.
8. Order-status edits to order quantity, purchase place, warehouse, delivery note, and unit price remain inside the existing `shipping-workspace/v2` optional row fields and are recalculated before local recovery, explicit cloud save, stock-ledger display, purchase selection, and integrated workbook output.
9. Warehouse and manager color assignments are local persistent display preferences. Changing a color saves and applies it immediately, while `전체 다시보기` clears only active warehouse and manager filters and never resets saved colors.
10. The settings modal initially exposes the five most recent local recovery records and reveals the remaining retained records through an explicit `더보기` control; record retention and verification still follow the ten-record recovery contract.
11. System.IO status text states the current operator action in Korean. ORDER Q uses F2 to clear result search, specification, warehouse, manager, column-condition, and column-sort view state while preserving analyzed data and saved warehouse/manager colors. Each table header exposes an Excel-like menu for ascending or descending sort and independent blank/zero exclusion. Filter buttons sit after the column tools, and color assignment is a separate target selector with an explicit white cancel swatch, ten visible pastel choices, and a vivid-color expansion; choosing white removes only the selected warehouse or manager's visible color without clearing other saved assignments, and native color inputs are not embedded in filter buttons.
12. Warehouse inventory accepts only the aggregate wide layout: one row per product code, a required source `수량`, and one or more warehouse quantity columns. Every row must satisfy `수량 = signed sum of warehouse quantity columns`; duplicate product codes, missing breakdown columns, and row-based stock-closing workbooks are blocked.
13. The operator-facing product brand is `ORDER Q`, owned by ONEAPP, and its stated purpose is shipment management (`출고관리`). The approved ORDER Q image asset is the visible header identity and is displayed at the same apparent cap height as the ONEAPP wordmark. Existing `orderops` routes, source filenames, storage keys, workspace schemas, cloud actions, and internal compatibility labels remain unchanged until a separately approved internal rename or migration.
14. The integrated ORDER Q workbook contains six sheets: delivery notices, order status, stock ledger, warehouse inventory, purchase upload, and sales upload. The sales-upload sheet follows the administrator-provided 22-column `판매입력` contract and is generated only from current nonzero order allocation rows; previously uploaded sales-history files remain shipment-completion evidence and are never re-exported as new sales vouchers.
15. A table print uses the active visible rows, current sort/filter result, visible columns, and the last explicitly saved column-width proportions. Widths are proportionally fitted to A4 portrait, and wrapped print cells must not clip long product names.
16. The header recovery action restores the latest SHA-256-verified local temporary record directly. The settings modal remains the route for choosing older retained records, and corrupted candidates remain blocked by the existing verification contract.
17. ORDER Q v1.35 defines an actual shortage as an inventory-backed product whose `warehouse stock total - current order quantity` is negative. `재고부족` focus shows only those order rows in order status; stock ledger and warehouse inventory additionally show inventory-backed substitute candidates whose normalized product-code first six characters match a shortage category. Missing inventory information is a separate review state and is never promoted into the verified-shortage focus.
18. Quantity presentation preserves the administrator's calculation trail: the calculated column is named `잔량`, blank remains blank, zero is muted, and a negative remainder is displayed as the signed numeric result such as `-3` with the same pale-yellow emphasis as its purchase-place cell. `발주 N`, `정보없음`, or other explanatory text is never substituted into a numeric quantity cell; review state remains available to the separate status-column filter, while purchase-upload export may still derive the required positive quantity from the signed result. Ordered rows use one pale context fill from product code through order quantity. Exact `EA`/`소분` rows use normal-weight red text for product, specification, and quantity context, while an exact `BOX` row uses bold black for both product name and specification. Automatic warehouse rainbow fills are disabled by default; only explicit saved color assignments are applied. Purchase-place Tab navigation centers the next verified-shortage row and selects its input. Order-information unit prices use thousands separators on screen and in the integrated workbook without changing numeric source values.
19. Named view presets persist local display conditions for order status, stock ledger, warehouse inventory, purchases, and sales: search and filters, sort, visible columns, column order, and explicitly saved column widths. One preset per view may be marked as the default and is applied automatically when that result view opens. Applying a preset discards keys absent from the current workbook and never changes analyzed rows, editable business values, workspace recovery, cloud plans, or color assignments. Header-body clicks do not sort; sorting remains available only inside the header filter control.
20. The small folder-shaped `통합` picker beside `데이터 소스` is a batch wrapper for the existing order, inventory, purchase, and sales inputs, not a sixth result tab or a new business-data type; no full-width integrated-upload panel is shown. The five result tabs are ordered as order, stock ledger, inventory, purchase, and sales. In `환경설정 > 통합 Excel 시트명 매칭`, administrators may register comma-separated per-kind aliases. An identical normalized alias assigned to more than one kind blocks saving with a warning. Each workbook sheet is classified by a ranked alias match: exact normalized sheet-name matches win over contained aliases, then the sheet must pass required-header and structure validation. This lets `판매입력` resolve to the exact sales alias instead of the contained purchase alias `매입`, while a configured `미출고` alias can still recognize `미출고현황`. Valid sheets replace only their active kind; a later valid sheet or individual upload of the same kind wins. Missing, ignored, or invalid sheets never clear the previously active kind, so one bad sheet cannot block valid sheets in the same workbook.

### 6.7 Standalone SmartInput intake

1. The public pilot route is `/smartinput/` with stable application ID `smart-input`. NEXUS exposes SmartInput as a fixed-position global entry immediately after the brand and also lists it as a shipping application. Its visibility is controlled from the common-header settings independently from the Shipping work-group preference; when SmartInput is the current hidden entry, it is temporarily shown as the current location. The page retains an independent header-failure fallback.
2. The NEXUS header always spans the browser width. The SmartInput application bar and three-column work area use a centered maximum width of `1360px`; the left column reports independent data states, the center owns intake, and the right contains related apps. Order links open `orderq/index.html` and `orders.html` in new tabs so the draft remains mounted.
3. The first input contract includes direct entry, Excel/file import, text, clipboard text/image paste, photo OCR, and browser voice STT. Unsupported OCR, speech, or external-library states leave manual entry available and do not erase the source text.
4. Each capture creates an ordered source record whose `sourceId` is SHA-256 of the raw payload bytes; an Excel table paste hashes the received bytes together with its HTML/TSV input kind. Analysis writes only per-source staging; it must leave existing work-table bytes unchanged and call no voucher writer. Selected staging rows append only after the explicit `테이블에 추가` action; identical products are not merged and receive only a duplicate-possibility marker.
5. Applied rows retain `sourceId`, the voucher-group/table/source-position/normalized-value logical `sourceRowKey`, `batchId`, `sourceLineKey`, and, when created by the ORDER Q intake engine, `intakeLineId`. The application ledger blocks a repeated source/logical-row application across parser versions. Re-analysis refreshes staging independently and cannot restore a deleted work row without explicit reapply authorization.
6. ORDER Q candidate generation must use the unified read-only catalog, not only `STORE.PRODUCTS`. The catalog merges common-master products before ORDER Q history products, so a product that exists only in the common master can still become an exact matched row. The behavioral contract fixture must keep that product absent from ORDER Q and verify an actual `MATCHED` result. Kakao date separators and message metadata never become product rows; only lines with a parsed quantity structure enter matching, while excluded conversation remains preserved in the immutable source message. SmartParser and SmartInput fallback use the same extractor, including terminal punctuation cleanup and the `상자` unit. Rows are displayed as `일치 N · 확인 M · 미인식 K`; customer rematching recalculates those counts from the resulting rows.
7. The ORDER Q vNext IndexedDB `oneapp-orderq-vnext` and `createOrder()` are the common order ledger. SmartInput creates revisioned order and order-item records with source-line evidence, then reuses the existing sync queue; it does not create a parallel final-order store.
8. `orderq/index.html` reads the common order ledger directly. In `orders.html`, tapping the order-status card before analysis invokes the separately validated read-only adapter and converts device-local `SMART_INPUT` orders from the same vNext ledger into the existing shipment input contract. Completed and fully cancelled orders and cancelled or excluded item rows are not reintroduced into shipment work. The adapter does not create a second order store, mutate the ledger, or trigger cloud synchronization.
9. Purchase and sale tabs preserve independent drafts and the complete input contract, but DataOps delivery remains disabled until target schemas and ownership are approved. An unrelated app is never substituted as a delivery target.
10. After a successful order save, the completed order remains owned by ORDER Q. SmartInput starts the next draft while retaining a bounded local delivery reference; modification, cancellation, shipment judgment, and ledger state are not owned by SmartInput.
11. Customer linking is relational, never canonical merging: one confirmed link group has one tax customer and may contain multiple registered or temporary delivery customers. The tax customer is never an order-aggregation key, and orders remain separate by delivery customer and delivery site.
12. A manually confirmed source-orderer alias maps first to a delivery customer. Exact unambiguous repeats may auto-select that delivery customer; similar or conflicting aliases remain review candidates. The linked tax customer is resolved after delivery-customer selection and is snapshotted with the SmartInput draft and delivery reference.
13. SmartInput-owned IndexedDB `oneapp-smartinput` v4 stores device-local customer link groups, temporary-delivery metadata, source-orderer mappings, delivery settings, estimate documents, source images, and revisioned input templates. Its v3-to-v4 migration creates only `inputTemplates` and preserves all prior records byte-for-byte. Official customer creation continues through the Customer Master mutation contract, and temporary-delivery status does not make a customer eligible for the single tax-customer role.
14. Delivery dates are validated from the selected delivery customer's weekday override or the app default weekdays, recurring and dated holidays, and the Asia/Seoul same-day cutoff. A post-cutoff same-day draft remains visible but cannot be delivered to ORDER Q until the date is corrected.
15. SmartInput does not expose an editable order-date field. Each draft records an immutable current-time `recordedAt`, derives the internal ORDER Q compatibility `orderDate` from that timestamp in Asia/Seoul, records successful delivery time separately, and exposes only the delivery date to the operator.
16. SmartInput never shows ordered workflow progress such as `3/5`, step numbers, or a fabricated current stage. Its left rail derives source presence, row count, match counts, and ORDER Q delivery readiness independently from current data.
17. Excel files and HTML-table or TSV clipboard input are normalized into the same `ImportMatrix` contract before header detection and mapping. A new-template session may create and revise the field mapping, display names, and column order. An existing-template session applies the stored structure immediately and updates values only; unmapped source columns are ignored, and the store rejects every structure-write command before opening a transaction so the saved record and revision remain unchanged.
18. The left parser is one uninterrupted active-source review window. Excel template controls are a default-closed compact trigger and modal overlay, never an in-flow panel that reduces the source viewport. Image object URLs render before byte hashing or OCR, and source zoom, scroll, and switching remain available while analysis runs.
19. Multiple sources use one list with previous/next activation and per-source `REGISTERED`, `ANALYZING`, `STAGED`, `PARTIALLY_APPLIED`, `APPLIED`, or `FAILED` recovery state. Activating or registering a source does not replace other staging or work rows. Source removal discards only its unapplied staging and preserves applied rows and ledger; work-row deletion preserves source and analysis history and never auto-restores the row.

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
| SmartInput source, parser, draft, or order delivery | SmartInput single-source review viewport, raw-byte identity, per-source staging and explicit application, source-row ledger deduplication, deletion separation, administrator-edit protection, duplicate marking, product/customer master reads, ORDER Q vNext ledger creation and sync queue, and the read-only `orders.html` consumer adapter including completed/cancelled exclusion and source fingerprinting |
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

ORDER Q is registered as a Pilot with `orders.html` as its primary public entry. `orders.html` and `orderops_list.html` deploy the same root-level source, while `orderops/list.html` remains the canonical compatibility route. It owns the isolated `shipping-purchase-plan` local/cloud contract and uses `orderops/orderops-source-adapter.js` only to read and verify the existing DataOps finalized snapshot and device-local SmartInput order rows. It does not call `coreEngine.js`, write either source contract, trigger ORDER Q cloud sync, or change MerchOps or DataOps business behavior. Disabling the public entries and reverting their PR is the code rollback path; already finalized cloud revisions remain append-only operational records and are not deleted by rollback.

SmartInput is registered as a standalone Pilot at `smartinput/index.html`. It is not a production NEXUS dependency during independent validation. Reverting the SmartInput files removes the pilot entry without changing existing input routes or final ORDER Q records already created through the shared ledger.

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

- `dataops/template-engine.js` owns the local `DATAOPS_TEMPLATE_V1` contract. `DATAOPS_DEFAULT_V1` is always available and cannot be overwritten or deleted; custom templates preserve role-specific header mappings, required-field rules, purpose, working-column order, version, and revision.
- Excel intake analyzes the header row before the existing parser, excludes server-computed/system fields, and reuses a saved role mapping without migrating existing DataOps data. Missing administrator-required fields block with `TEMPLATE_REQUIRED_FIELD_MISSING`; stale template edits block with `TEMPLATE_VERSION_CONFLICT`.
- Stock-ledger templates preserve the existing balance calculation and ignore order quantity. Unshipped-status templates add editable order/planned-outbound quantity and expose read-only `예상잔량 = 전산잔량 - 주문`; existing `전산잔량` and `로스` remain server-computed fields.
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
- The default Order Status sequence is warehouse, customer, group, manager, product code, product name, specification, product information, order, unit price, all warehouse-inventory columns, notice, and purchase. Product information shows the product-code order-quantity total once only when that code has multiple order rows; a single order row remains blank, and product-name differences do not split the code aggregate. Warehouse is read-only; order, unit price, notice, and purchase remain editable.
- Warehouse inventory shows `정보` as `거래처(수량)단가` with grouped unit prices, preserves order notes in a separate `적요` column, omits `사용`, keeps product identity first, and displays the trailing source price field `창고` as `창고단가` on screen and in the integrated workbook.
- `재고부족` focus is shared across F5–F7. F5 keeps verified-shortage order rows only; F6/F7 group same-six-character inventory-backed substitutes after the shortage row. The calculated column is displayed as `잔량` and keeps the signed result such as `-3`; missing inventory information remains available as a status-column filter value.
- Purchase input supplies stock-ledger inbound/purchase-place displays and sales input supplies the `출고` display, including zero-stock rows for product codes absent from the current inventory file. The inventory balance remains warehouse stock minus the current order quantity.

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

## Customer Master shared boundary (2026-08)

- Customer Master is the shared customer authority for ORDER IN, direct order entry, Collector, and customer history lookup.
- IndexedDB is the Local Primary operational source, not a disposable Cloud cache. A device with no local customers reports `RESTORE_REQUIRED`; a populated device reads local data immediately. Neither case performs automatic server-to-local Pull. Server data can be applied only through the administrator restore contract in section 5.4.1.
- `qualityStatus` owns merge state independently from trading `status`. Non-superseded rows are self-canonical. A `SUPERSEDED` row points to a different ACTIVE canonical customer.
- New live work uses only the canonical customer ID. Historical document customer IDs are immutable and are expanded to the canonical family at read time for unified history and ledger views.
- Customer Excel import is `customerCode`-identified immediate create/update and row-atomic. Empty non-code fields preserve the current value, duplicate codes inside one file fail only those duplicate rows, unmatched columns are reported and excluded, and name similarity never blocks a write. Pre-B+ import sync rows are quarantined and never replayed; new Customer mutations create B+ Event outbox records in the same local transaction and retry only one-way backup with bounded backoff. ORDER IN, direct input, Master, and Collector quick-create remain explicit live creates that return a real customer ID immediately.
