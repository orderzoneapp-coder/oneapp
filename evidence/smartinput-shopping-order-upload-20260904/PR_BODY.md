## Summary

- recognize the exact 17-column shopping-order XLS in SmartInput's existing order-mode Excel picker
- preserve immutable source-cell evidence and resolve customer, warehouse, and every product through existing owner data/selection UX
- display per-candidate new, actual-ledger duplicate, and review-required results, then commit only surplus candidates through the ORDER Q command adapter
- keep general Excel mapping, manual order, purchase, sale, estimate, DB schema, official Voucher V2, inventory, AR/AP, common runtime, and Cloud gates unchanged

## Baseline and ownership

- exact base and merge-base: `d44bbda357268289269574aa8f7b36333e013be5`
- SmartInput owns only source evidence, owner selections, and UI state
- ORDER Q remains the sole owner of signatures, actual-ledger reads, candidate transactions, order/item/event/queue writes, and race handling
- local actual-ledger idempotency only; no multi-device global-deduplication claim

## Verification

- all repository `test-orderq*.mjs` and `test-smartinput*.mjs`: 60/60 PASS
- actual `orderlist-260904.xls`: 14 rows, 5 candidates, quantity 24, amount 288,400, validation 0
- actual cumulative XLS: 12,301 total rows; latest date selects the same 14 rows; final parse 1,413.8ms
- multiset 1+2→1, 2+2→0, 1+3→2; customer/product/warehouse/amount/boundary fail closed
- isolated browser DB: 4 normal saved + 1 review 0-write, corrected surplus 1 saved, final repeat 5 duplicates 0-write
- owner race/stale/rollback and incomplete legacy ledger tests PASS
- 1920/1440/390 light/dark: overflow 0, clipping 0, focus PASS, console/runtime errors 0
- repository validator 24 checks / 0 warnings, client safety PASS, syntax PASS, `git diff --check` PASS

## Evidence and rollback

- work record: `docs/NEXUS_SMARTINPUT_SHOPPING_ORDER_UPLOAD_20260904_WORK_RECORD.md`
- screenshots and compact browser evidence: `evidence/smartinput-shopping-order-upload-20260904/`
- rollback: revert this PR's SmartInput consumer/UI wiring plus Phase 2 adapter exposure/amount validation; retain Phase 1 owner core and existing DB v7 facts. Do not delete or rewrite orders already explicitly saved.

## Merge gate

Do not merge or deploy until PM independently validates this exact PR head.
