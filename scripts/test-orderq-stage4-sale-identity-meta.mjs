import assert from 'node:assert/strict';
import { buildSaleStage4Sidecar, classifySaleAllocation } from '../orderq/sale-stage4-source-adapter.js';
import { isSalesMetaSheet, joinSalesMeta, readSalesMeta, salesMetaRowDigest } from '../smartinput/sale-stage4.js';
import { parseStructuredSheet } from '../smartinput/structured-sheet-parser.js';
const customers=['C1','D1','B1'].map((customerId,index)=>({customerId,revision:index+2,status:'ACTIVE'}));
const source={customers,products:[{productId:'P1',productCode:'A',revision:3,status:'ACTIVE'}],warehouses:[{warehouseId:'W1',revision:4,status:'ACTIVE'}],
 orders:[{orderId:'O1',orderNo:'N1',customerId:'D1',revision:5,status:'OPEN'}],orderItems:[{orderItemId:'OI1',orderId:'O1',productId:'P1',sourceRowNumber:2,revision:6,status:'OPEN'}],dispatches:[],dispatchLines:[]};
const allocation={sourceRowNumber:2,orderNumber:'N1',productId:'P1',warehouseId:'W1',salesCustomerId:'C1',deliveryCustomerId:'D1',billingCustomerId:'B1',productCode:'A',quantity:0,unit:'EA',unitPrice:10};
assert.equal(classifySaleAllocation(allocation,source).linkStatus,'ORDER_Q_LINKED');
const sidecar=buildSaleStage4Sidecar({planId:'PLAN',sourceFingerprint:'FP',basisDate:'2026-08-25',allocations:[allocation]},source,{},'A');
assert.equal(sidecar.rows[0].salesCustomerRevision,2); assert.equal(sidecar.rows[0].deliveryCustomerRevision,3); assert.equal(sidecar.rows[0].billingCustomerRevision,4);
const meta={schemaVersion:'ORDERQ_SALES_META_V1',ruleVersion:'SALE_QUANTITY_RULE_V1',planId:'PLAN',sourceFingerprint:'FP',basisDate:'2026-08-25',sourceRowKey:'R1',sourceRowNumber:2,sourceOccurrence:1,visibleSheetName:'판매업로드',visibleRowNo:2,sourceVoucherIndex:1,originSystem:'ORDER_Q',originTransactionId:'PLAN',sourceDocumentKey:'SALE:X',sourceLineKey:'SALE:X:LINE:1',stableGroupKey:'G',salesCustomerId:'C1',salesCustomerRevision:2,deliveryCustomerId:'D1',deliveryCustomerRevision:3,billingCustomerId:'B1',billingCustomerRevision:4,productId:'P1',productCode:'A',productMasterRevision:3,warehouseId:'W1',warehouseCode:'01',warehouseMasterRevision:4,sourceOrderId:'O1',sourceOrderRevision:5,sourceOrderItemId:'OI1',sourceOrderItemRevision:6,sourceDispatchId:'',sourceDispatchRevision:'',sourceDispatchLineId:'',sourceDispatchLineRevision:'',suggestedActualQuantity:0,suggestedActualUnit:'EA',suggestedBaseQuantity:0,suggestedBaseUnit:'EA',suggestedRecognizedOrderQuantity:0,suggestedRecognizedUnit:'EA',suggestedActualToBaseFactor:1,suggestedActualToRecognizedFactor:1,conversionSource:'ORDER_Q',conversionRuleId:'R',conversionRuleVersion:'1',priorAllocationRefs:'[]'};
meta.rowDigest=salesMetaRowDigest(meta);const matrix=[Object.keys(meta),Object.keys(meta).map(key=>meta[key])];
assert.equal(isSalesMetaSheet('_NEXUS_SALES_META',matrix),true);assert.equal(parseStructuredSheet(matrix,{sheetName:'_NEXUS_SALES_META'}).excluded,true);
const joined=joinSalesMeta({visibleSheetName:'판매업로드',visibleRows:[{sourceLineNo:2,itemCode:'A',quantity:0,unit:'EA',unitPrice:10}],metaRows:readSalesMeta(matrix)});
assert.equal(joined[0].quantity,0);assert.equal(joined[0].recognizedOrderQuantity,0);
assert.throws(()=>joinSalesMeta({visibleSheetName:'판매업로드',visibleRows:[{sourceLineNo:2,itemCode:'A',quantity:1,unit:'BOX',unitPrice:10}],metaRows:readSalesMeta(matrix)}),/META_MUTATED.*UNIT/);
console.log('ORDER Q stage4 sale identity/meta tests passed');
