# SmartInput

`smartinput/index.html` is the independently runnable pilot entry for order, purchase, sale, and estimate drafting.

## Runtime boundary

- The shell, mode switching, direct/text/clipboard input, work-table editing, draft recovery, and estimate catalog are `LOCAL_OPERATION` features.
- Order delivery calls the ORDER Q public writer first and treats cloud synchronization as `BACKGROUND_SYNC`. A sync failure cannot undo a successful local write.
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

## Intentionally excluded

- Removed legacy NEXUS header/auth modules and legacy customer CSS
- Global reference-readiness blocking and the former long customer bootstrap wait
- Static imports of optional ORDER Q/server modules
- Template mapping, explicit staging state machines, and new range/column engines
- Voucher-number keyboard shortcuts and their visual/accessibility hints
