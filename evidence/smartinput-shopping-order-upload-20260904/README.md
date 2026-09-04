# SmartInput shopping-order upload evidence

- Task: `NEXUS-SMARTINPUT-SHOPPING-UPLOAD-20260904-01`
- Baseline: `d44bbda357268289269574aa8f7b36333e013be5`
- Source: synthetic 17-column XLS only; no real customer/address/phone data is included.
- Browser profile/database: temporary and deleted after the run.
- Viewports: 1920×1080, 1440×1000, 390×844 in light and dark themes.
- Assertions: page horizontal overflow 0, panel/card horizontal clipping 0, candidate owner-button focus accepted, console errors 0, runtime exceptions 0, external/local HTTP mutations 0.
- Storage scenario: four normal candidates saved while one amount-mismatch candidate remained 0-write; corrected retry saved only that surplus candidate; final identical retry excluded all five actual-ledger duplicates with 0 writes.

See `browser-evidence.json` for the compact machine-readable result and `screenshots/` for the six captures.
