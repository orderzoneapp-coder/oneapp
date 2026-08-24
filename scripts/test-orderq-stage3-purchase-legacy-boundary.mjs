import assert from 'node:assert/strict';
import { createCentralAuthorityState, migrateCentralDrafts } from '../orderq/central-authority.js';
import { readFileSync } from 'node:fs';
import { buildLegacyPurchaseStage3Snapshot } from '../orderq/purchase-decision-repository.js';
const docs=[
  {entityType:'PURCHASE_DOCUMENT',entityId:'LEG',revision:1,payload:{purchaseDocumentId:'LEG',status:'DRAFT',purchaseOriginId:'SHORT1',sourceDocumentKey:'LEGKEY'}},
  {entityType:'PURCHASE_DOCUMENT',entityId:'NEW',revision:1,payload:{purchaseDocumentId:'NEW',status:'DRAFT',documentContract:'VOUCHER_CORE_V1',contractKind:'PURCHASE_STAGE3_V1',legacySourceShortageKey:'SHORT1',sourceDocumentKey:'NEWKEY'}}];
assert.throws(()=>migrateCentralDrafts(createCentralAuthorityState(),{deviceId:'D',idempotencyKey:'M',entities:docs}),/ORDERQ_CENTRAL_SOURCE_ALREADY_POSTED/);
const source=readFileSync(new URL('../orderq/purchase-ui.js',import.meta.url),'utf8');
assert.ok(source.includes("contractKind: 'LEGACY_PURCHASE_V1'"));
assert.ok(source.includes("current.document.contractKind !== 'PURCHASE_STAGE3_V1'"));
assert.ok(source.includes('reconcilePurchaseExternal'));
assert.deepEqual(buildLegacyPurchaseStage3Snapshot({document:{purchaseDocumentId:'LEG',sourceShortageKey:'SHORT',supplierId:'C1',supplierName:'남경'},lines:[{purchaseLineId:'L1',quantity:-2,baseQuantity:-20,baseUnit:'EA',unitCostWon:100}]}),{
  contractKind:'LEGACY_PURCHASE_V1',originSystem:'ORDERQ_LEGACY_PURCHASE',originTransactionId:'LEG',legacyPurchaseDocumentId:'LEG',externalDocumentNo:'',purchasePlanId:'SHORT',legacySourceShortageKey:'SHORT',supplierCustomerId:'C1',supplierCustomerName:'남경',lines:[{purchaseLineId:'L1',productId:'',productCode:'',warehouseId:'',actualQuantity:-2,unit:'',baseQuantity:-20,baseUnit:'EA',unitPrice:100}]
});
console.log('ORDER Q stage3 purchase legacy boundary tests passed');
