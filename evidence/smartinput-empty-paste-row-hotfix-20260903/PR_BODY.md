## Summary

- ignore only completely blank or effective-whitespace-only source rows across clipboard, mapping-worktable, and Excel/structured-sheet intake
- preserve blank-cell column positions and distinguish explicit zero/negative values from blank numeric cells
- retain meaningful identity-missing rows for the existing required-item validator and preserve each target worktable's established overwrite behavior
- add focused unit coverage plus direct-grid and mapping-grid browser regressions; no visual or persistence-contract changes

## Contract preservation

- source matrices and company/voucher/header-order template signatures are unchanged
- direct worktable and mapping-worktable overwrite contracts are locked independently
- no UI structure/CSS, column order, buttons, shortcuts, Draft/IndexedDB schema, save payload, official voucher V2, reference-data, or common-runtime changes
- common asset tokens remain `nexus-ui.css` 1.3.5, `nexus-ui-app-themes.css` 1.3.9, and `nexus-ui.js` 1.4.2

## Verification

- test-first baseline reproduction: focused test failed on `5fb0ee2` before implementation
- `node scripts/test-smartinput-empty-source-rows.mjs`
- all 33 `scripts/test-smartinput*.mjs` entry points
- `node scripts/validate-repository.mjs` — 24 checks, 0 warnings
- `node scripts/test-client-safety.mjs`
- `node --check` for all changed/new JavaScript modules
- `git diff --check`

All checks pass. Browser regressions cover blank/space/tab/line-break/NBSP/zero-width rows, internal blank cells, explicit zero, negative values, trailing blank rows, overwrite/undo, and runtime/console isolation.

## Data impact and rollback

No data migration or persisted-data rewrite. Revert the single hotfix commit; no database rollback is required.

## Gate

PM verification is required before merge.
