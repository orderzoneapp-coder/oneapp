# SmartInput empty source-row hotfix

## Preflight

- Baseline: `origin/main` `5fb0ee26fd8af4eb28cfa6e8d85b28d2b66c9f43`
- Branch: `codex/smartinput-empty-paste-row-hotfix-20260903`
- Worktree: `C:\Users\USER\Documents\ChatGPT\NEXUS\work\oneapp-smartinput-empty-paste-row-hotfix-20260903`
- Repository: `https://github.com/orderzoneapp-coder/oneapp.git`
- Worktree state before edits: clean
- Reviewed contracts:
  - `AGENTS.md` 2.3.4
  - `APP_ARCHITECTURE.md` 2.1.30
  - `app-manifest.json` schema 1.3.9; `smart-input` remains a pilot and owns local work/template mapping
  - `orderq/ARCHITECTURE.md` 0.9.0; official voucher owner boundary is unchanged
  - `smartinput/README.md`; source matrix, positional template signature, blank/zero preservation, and existing save validation remain authoritative

## Current and target state

- Current: source-row inclusion uses ordinary string `trim()` in clipboard and mapping paths. Zero-width-only rows survive as working rows, while header-grid validation can reject trailing blank rows with short physical widths before blank rows are excluded. The structured parser also drops a meaningful row when both product identity cells are blank, hiding downstream required-field validation.
- Target: classify rows by display values without mutating the source matrix. Ignore only rows whose every cell consists of ordinary/invisible whitespace; keep every column position inside meaningful rows; preserve explicit `0`, negative values, and existing target-row overwrite behavior; keep identity-missing meaningful rows for the existing voucher validator.
- Conflicts: none. No UI, template signature, column order, storage schema, Draft contract, official voucher V2, or ORDER Q owner write path change is required.
- Execution class: local SmartInput input-normalization hotfix (`LOCAL_OPERATION`).

## Verification record

- RED reproduction on baseline `5fb0ee2`: `node scripts/test-smartinput-empty-source-rows.mjs` failed because a completely blank trailing row with a short physical width reached exact-header row-length validation (`actual false`, `expected true`).
- GREEN focused regression: `node scripts/test-smartinput-empty-source-rows.mjs` PASS.
  - Clipboard source: ordinary blank rows, spaces, tabs, line-break rows, NBSP, zero-width spaces, and multiple trailing blank rows do not create working rows.
  - Mapping worktable: the immutable `sourceMatrix` and the complete header signature remain unchanged; internal blank cells retain their column positions.
  - Excel worksheet: the full used range remains available as source evidence while blank/whitespace-only rows are omitted only from working rows.
  - Values: explicit `0` and negatives survive; blank/invisible-only numeric cells project as `null`, not zero.
  - Validation: a meaningful row with blank item code and name remains present and reaches the existing `row:*:item` validator.
- All 33 `scripts/test-smartinput*.mjs` entry points PASS, including direct worktable paste, mapping-worktable overwrite/undo, settings, persistence/isolation, XLSX source reading, structured parsing, official-voucher boundaries, and browser E2E. Browser suites reported zero runtime/console failures.
- `node --check` PASS for every changed/new JavaScript module and the focused test.
- `node scripts/validate-repository.mjs` PASS (`24 checks`, `0 warnings`).
- `node scripts/test-client-safety.mjs` PASS.
- `git diff --check` PASS (only the repository's Windows line-ending notices were emitted).

## Change and impact

- Adds one SmartInput-local pure source-value classifier and applies it at the clipboard plan, template working-row projection, structured-sheet parser, and work-row meaningfulness boundary.
- Keeps blank cells in meaningful rows positional and preserves each existing paste target's established behavior: direct worktable blank cells do not overwrite existing values, while mapping-worktable range paste continues to overwrite the addressed range, including blanks.
- Does not change HTML structure or CSS. `smartinput.js` is cache-busted to `0.11.10`; common assets remain `nexus-ui.css` `1.3.5`, `nexus-ui-app-themes.css` `1.3.9`, and `nexus-ui.js` `1.4.2`.
- No IndexedDB version/store/key, Draft schema, saved template signature, save payload, official voucher V2, reference data, column order, button, or shortcut change. Existing persisted data requires no migration and is not rewritten.

## Rollback

- Revert the single hotfix commit. No database rollback or data restoration is required because this change only affects in-memory import normalization before existing validation and persistence.
