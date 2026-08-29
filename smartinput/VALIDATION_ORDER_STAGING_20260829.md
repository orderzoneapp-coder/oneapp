# SmartInput Excel staging and ORDER Q validation — 2026-08-29

## Scope and baseline

- Branch: `codex/smartinput-order-staging-v1-20260829`
- Baseline: `29704ba9b32711860f67c79cd47246711d8dd79c`
- Acceptance workbook: local administrator fixture `미출고현황.xlsx` (not committed)
- Storage/schema migrations: none
- ORDER Q integration boundary: existing `createOrder` writer, `listOrders` order-list reader, and `getOperationsSnapshot` operations reader

## Acceptance workbook result

| Check | Expected | Result |
|---|---:|---:|
| Detected header | A2:N2 | row 2 |
| Title/output-time exclusion | A1 and final output-time row excluded | pass |
| Staged rows | 93 | 93 |
| Existing work rows before explicit action | preserved | 1 of 1 preserved |
| Customer/order groups | 18 | 18 |
| Quantity | 184.5 | 184.5 |
| Amount | 2,168,350 | 2,168,350 |
| Decimal quantity | 0.5 retained | pass |
| `bOX` unit | warning + `BOX` normalization, no row loss | pass |
| Unit/specification | separate fields | pass |
| ORDER Q order-list reader | 18 orders | 18 |
| ORDER Q operations reader | 18 bundles | 18 |
| Same workbook rerun | 0 duplicates | 0 |
| Same business key + same hash | idempotent success | pass |
| Same business key + changed hash | conflict, no new order | `ORDER_BUSINESS_KEY_CONFLICT` |

Normalized source SHA-256 for the acceptance run was `914e98d79a689ba9936e97ae983d4331f1c1a4eff2d838a75dcc7e82a11689bd`.

## Workflow and failure isolation

- New-template flow reports template-save result independently, applies only the staged rows, then writes order groups.
- Existing-template flow uses the saved mapping and column structure without saving another template revision.
- A two-customer browser scenario forced one group to fail. The successful group was removed, only the failed customer's row remained, and retry wrote only that failed group.
- An unrelated work row present before the 93-row staging remained after all 18 staged groups succeeded.
- Optional reference-read failures did not block file parsing, table editing, template save, local ORDER Q writes, or either ORDER Q reader.

## UI and regression result

- Desktop 1440×1000: AppHeader 56px/full width, source 320px, work table 1096px × 741px scroll area.
- Text/paste/photo primary surfaces used 90.9%/90.9%/87.2% of the parser body; Excel preview used 83.7% after compact template controls.
- Mobile 390px: AppHeader 56px, four voucher tabs reachable, three initial work rows visible.
- Direct grid paste, text paste, CSV, TSV, XLSX, photo-preview/OCR isolation, voice isolation, draft recovery, dark/light/mobile, and all four voucher modes passed.
- Browser console errors: 0. Uncaught runtime errors: 0.

## Known contract/documentation gaps (not changed in this PR)

1. `APP_ARCHITECTURE.md` and `app-manifest.json` still describe the ORDER Q vNext local ledger as `oneapp-orderq-vnext` v4, while the current ORDER Q implementation and README use isolated `oneapp-orderq-pre-m1-v6` v6.
2. SmartInput declares `orderq-vnext-sync` as a consumed contract, but that shared contract's manifest consumer list does not include SmartInput. This PR keeps the already-used public writer/reader boundary and does not change ownership or schema documentation.
3. `integration-adapter.js` still targets an optional `orderq/customer-master.js` reference module that is absent on this baseline. The UI correctly shows the reference-read failure and manual entry/local work remain available.
4. Product-master search and selection inside the SmartInput work table is not implemented. This change preserves the existing product-reference status indicator and does not claim a product picker.

## Automated checks

- `scripts/test-smartinput-order-staging.mjs`
- `scripts/test-smartinput-structured-sheet-parser.mjs`
- `scripts/test-smartinput-grid-clipboard.mjs`
- `scripts/test-smartinput-multivoucher-stage1.mjs`
- `scripts/test-smartinput-independent-recovery.mjs`
- `scripts/test-smartinput-appheader-workspace.mjs`
- `scripts/test-smartinput-ocr.mjs`
- `scripts/test-smartinput-browser-e2e.mjs` with `SMARTINPUT_ACCEPTANCE_XLSX` set to the acceptance workbook

Merge and production deployment remain blocked pending PM review.
