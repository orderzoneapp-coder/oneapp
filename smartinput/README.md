# SmartInput

`smartinput/index.html` is the independently runnable pilot entry for order, purchase, sale, and estimate drafting.

## Runtime boundary

- The shell, mode switching, direct/text/clipboard input, work-table editing, draft recovery, and estimate catalog are `LOCAL_OPERATION` features.
- Order delivery calls the ORDER Q public writer first and treats cloud synchronization as `BACKGROUND_SYNC`. A sync failure cannot undo a successful local write.
- Excel, CSV, TSV, text, paste, and verified OCR results are held as `추가 예정` rows. Existing work rows are not changed until the user explicitly applies the staging result or runs the continuous template/order action.
- Order grouping uses customer + voucher date + warehouse code. Each group is written independently through the existing ORDER Q public writer, so successful groups can finish while failed groups remain available for retry.
- A normalized source SHA-256 identifies a parsed source. The business key is the ORDER Q idempotency key: the same business key and source hash is an idempotent success; the same business key with a different source hash is blocked as a conflict.
- Purchase and sale delivery are `SERVER_FINALIZE` operations. Missing capability, authentication, permission, revision, or server failures keep the affected draft rows unchanged.
- Customer, product, and warehouse reads are independent optional adapters. Error is rendered as error, never as a normal empty result.
- SheetJS and Tesseract are loaded only when their feature is invoked. Their failure does not affect the app shell or other input methods.

## Preserved local contracts

- Draft: `oneapp.smartinput.draft.v1`
- Recent drafts: `oneapp.smartinput.drafts.v1`
- Delivery history: `oneapp.smartinput.delivery-history.v1`
- Settings: `oneapp.smartinput.settings.v1`
- IndexedDB: `oneapp-smartinput`, version `3`
- Stores: `settings`, `customerLinkGroups`, `temporaryCustomers`, `customerAliasMappings`, `estimates`, `sourceImages`

The recovery does not clear storage, bump the database version, or run a destructive migration. Merely opening the page reads existing data and does not rewrite it.

Input templates are stored inside the existing settings record under `inputTemplates`; unrelated settings are merged and preserved. A new template saves its detected header mapping and display-column order before order creation. An existing template applies its saved structure without rewriting it.

## Intentionally excluded

- Removed legacy NEXUS header/auth modules and legacy customer CSS
- Global reference-readiness blocking and the former long customer bootstrap wait
- Static imports of optional ORDER Q/server modules
- General CRUD table engines, Excel-style range selection, and column insertion/deletion
- Voucher-number keyboard shortcuts and their visual/accessibility hints
