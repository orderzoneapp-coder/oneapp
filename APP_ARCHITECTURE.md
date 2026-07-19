# ONEAPP Application Architecture

- Repository: orderzoneapp-coder/oneapp
- Architecture document version: 1.0.0
- Last reviewed: 2026-07-20
- Machine-readable companion: app-manifest.json

## 1. Purpose

ONEAPP turns ERP, supplier, inventory, sales, and shopping-mall data into reviewed product information that can be applied back to operational systems. Excel is a bidirectional review and correction medium, not a one-way export format.

This document defines the current application boundaries, shared data contracts, change-impact rules, release process, and the registration process for planned applications.

## 2. Architecture principles

1. GitHub main is the production source of truth.
2. Production changes are made on a branch, reviewed in a pull request, and merged only after validation.
3. Shared field names, storage keys, cloud actions, and navigation paths are treated as contracts.
4. A change to a shared contract must be reviewed against every consumer, even when only one screen is visibly changed.
5. Planned applications do not become production dependencies until their owner, purpose, inputs, outputs, and status are recorded in app-manifest.json.
6. Duplicate _test files are not a recovery source of truth. Recovery uses Git history, stable tags, and PR reverts. A separately named preview page may be kept only when an alternate validation URL is operationally required.

## 3. System overview

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

All applications exchange state through shared browser storage and, where configured, the Google Apps Script cloud synchronization service implemented by code.gs.

## 4. Component catalog

| Component | Type | Status | Primary responsibility |
|---|---|---|---|
| MerchOps.html | Web entry | Production | Product master review, pricing, promotion, stop management, information-change review, and Excel application workflow |
| DataOps.html | Web entry | Production | Purchase, sales, inventory, stock ledger, cost, and performance analysis |
| SmartParser.html | Web entry | Production | Parse external documents, normalize product information, and create supply-stop or information-change candidates |
| export_center.html | Web entry | Production | Validate selected results, prepare output payloads, export Excel, and apply approved master changes |
| settings.html | Web entry | Production | Manage mappings, pricing rules, visible columns, table views, cloud URL, and shared configuration |
| history_viewer.html | Web entry | Production | Inspect product-change history and price trends |
| coreEngine.js | Shared library | Production | Storage, pricing, history, export, cloud synchronization, and master-data utilities |
| code.gs | Cloud service | Production | Google Apps Script API for master, history, and configuration backup and restore |

## 5. Runtime relationships

### 5.1 Navigation

MerchOps links to SmartParser, export center, settings, and history viewer using relative application URLs. SmartParser, export center, settings, and history viewer provide a route back to MerchOps.

Changing a filename or moving a file therefore requires a repository-wide navigation review. Do not reorganize production files into folders without first updating and testing every relative link and deployment route.

### 5.2 Shared browser state

The current applications share the browser database MerchOpsDB and a set of localStorage keys. Important contracts include:

| Contract | Current key or resource | Main consumers |
|---|---|---|
| Product master | merchMaster_v870, MerchOpsDB | MerchOps, SmartParser, DataOps synchronization, export center, settings, history viewer |
| Master change notification | merchMaster_sync_trigger | MerchOps, SmartParser, DataOps, export center, settings |
| Change history | merchHistory_v870 | MerchOps, SmartParser, DataOps, history viewer, cloud backup |
| Information-change queue | merchInfoChangeQueue_v1 | SmartParser and MerchOps information workflow |
| Parser dictionary | parserDict_v870 | SmartParser, MerchOps, settings, cloud configuration |
| Margin and pricing rules | merchMarginRules_v878 | MerchOps, SmartParser, settings, core engine |
| Mapping configuration | merchMappings_v870 | MerchOps, settings, cloud configuration |
| Master links | merchMasterLinks_v870 | MerchOps, settings, cloud configuration |
| Shared cloud URL | oneapp_cloud_sync_url_v1 | MerchOps, DataOps, settings, history viewer, core engine |
| Legacy cloud URL | merchCloudUrl_v870 | Compatibility fallback only |
| Active table target | merchActiveTableTarget_v1 | MerchOps and settings |
| Active table view | merchActiveTableViewId_v1 | MerchOps and settings |

A storage-key rename is a schema migration. It must provide a compatibility read path, write the new key, preserve existing user data, and include a rollback plan.

### 5.3 Cloud synchronization

code.gs exposes the following current API actions:

| Method | Action | Responsibility |
|---|---|---|
| POST | initSync | Clear and initialize master and history synchronization data |
| POST | chunk_master | Append a chunk of product-master records |
| POST | chunk_history | Append a chunk of history records |
| POST | config | Save shared configuration |
| GET | full or omitted | Return master, history, and configuration |
| GET | master_only | Return product master and summary |
| GET | config_only | Return configuration only |

Changing any action name, payload shape, response shape, or field normalization requires coordinated updates to code.gs and every calling page.

### 5.4 Shared engine status

coreEngine.js defines the intended ONEAPP shared modules:

- ONEAPP.STORAGE
- ONEAPP.PRICING
- ONEAPP.HISTORY
- ONEAPP.EXPORT
- ONEAPP.CLOUD
- ONEAPP.MASTER

As of this review, settings.html explicitly loads coreEngine.js. MerchOps, DataOps, and SmartParser still contain overlapping or locally implemented logic. Treat coreEngine.js as the intended shared contract, but do not remove duplicated implementations until compatibility tests prove that each application produces the same output.

## 6. Primary business flows

### 6.1 External information to shopping-mall update

1. SmartParser reads and normalizes an external document.
2. Supply-stop and product-information differences become review candidates.
3. MerchOps matches candidates against the master and displays the information-change queue.
4. The operator validates and edits product data using the original Excel structure.
5. Export center generates the ERP or shopping-mall update workbook.
6. Completion state and history are recorded after the relevant system upload is confirmed.

### 6.2 Inventory and performance insight

1. DataOps imports purchase, sales, inventory, and stock-ledger information.
2. Product codes and master information are matched using shared mappings.
3. Cost, inventory, and trend results are calculated.
4. MerchOps uses those results as review evidence without treating DataOps inventory files as owners of promotion-theme data.
5. Approved changes are exported and recorded in history.

### 6.3 Configuration and recovery

1. Settings manages shared mappings, pricing rules, columns, views, and cloud URL.
2. Configuration can be backed up to or restored from code.gs.
3. Data restoration must preserve the existing product master, history, and compatibility keys unless an explicit migration has been reviewed.

## 7. Change-impact rules

| Change type | Minimum review scope |
|---|---|
| MerchOps layout or button placement | MerchOps plus navigation and basic load smoke test |
| Product field, canonical name, or Excel mapping | MerchOps, SmartParser, DataOps, export center, settings, history viewer |
| Pricing or margin calculation | coreEngine, MerchOps, DataOps, SmartParser, export center |
| Storage key or IndexedDB schema | Every listed consumer plus migration and rollback |
| Cloud action or payload | code.gs, coreEngine, MerchOps, DataOps, settings, history viewer |
| Navigation path or filename | Every HTML entry point and deployed routes |
| Information-change workflow | SmartParser, MerchOps, export center, history viewer, cloud backup |
| Planned app promotion to production | Manifest update, architecture review, navigation review, and PR validation |

## 8. Application lifecycle

Applications use the following statuses:

- planned: purpose and scope are being designed; no production dependency is allowed.
- pilot: implementation exists for controlled testing; production data writes require explicit safeguards.
- production: supported operational application.
- deprecated: read-only or migration period; replacement and removal date must be recorded.
- archived: retained only in Git history or releases and not deployed as an active entry point.

A planned application must record:

1. Stable application ID and proposed filename
2. Business purpose and owner
3. Input and output data
4. Shared contracts it reads and writes
5. Upstream and downstream applications
6. Validation and rollback method
7. Target lifecycle status

## 9. Release, validation, and recovery

### Release

1. Start from the latest main branch.
2. Create a focused branch.
3. Change only files inside the declared impact scope.
4. Validate syntax, application load, navigation, storage compatibility, and the affected business flow.
5. Open a draft PR with the changed files, impact, and validation result.
6. Merge after review and verify the deployed page with a hard refresh.

### Recovery

- Use a stable Git tag for a verified production point.
- Use GitHub Revert on the breaking PR or create a rollback PR from the verified commit.
- Do not depend on stale _test copies for restoration.
- If an emergency alternate URL is required, keep one explicitly named preview or stable page with an owner and verification date; it is a validation entry point, not the source of truth.

## 10. Governance

- app-manifest.json is the machine-readable inventory.
- This document explains intent and change policy.
- A PR that adds, renames, promotes, deprecates, or removes an application must update both files.
- A PR that changes a shared data contract must list every reviewed consumer.
- Unknown planned applications remain outside production dependencies until they are registered.
