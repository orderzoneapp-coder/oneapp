import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connectSaleStage4Workspace } from '../orderq/sale-stage4-source-adapter.js';
import { readSalesMeta, joinSalesMeta, detachOrderQSaleLink, recomputeSaleLine } from '../smartinput/sale-stage4.js';
import { groupVoucherRows } from '../smartinput/multivoucher-stage1.js';
import { buildSalePostDraft } from '../smartinput/sale-official-stage4.js';
import { buildOfficialSaleEditCommand } from '../orderq/sale-official-editor.js';

const require = createRequire(import.meta.url);
const workbookApi = require('../orderFulfillmentWorkbook.js');
const sheetJsUrl = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
const sheetJsSha256 = 'c9506197caf809a075b6dee1da0d36fb19da7158ffe8a88e7b0c96c5d8623c99';
const response = await fetch(sheetJsUrl);
assert.equal(response.ok, true, `SheetJS download failed: ${response.status}`);
const sheetJsSource = Buffer.from(await response.arrayBuffer());
assert.equal(crypto.createHash('sha256').update(sheetJsSource).digest('hex'), sheetJsSha256);
const sheetContext = vm.createContext({ console, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, setTimeout, clearTimeout });
vm.runInContext(sheetJsSource.toString('utf8'), sheetContext);
const XLSX = sheetContext.XLSX;

const customer = (customerId, revision) => ({ customerId, customerCode:customerId, revision, status:'ACTIVE' });
const source = {
  customers:[customer('S1', 11), customer('D1', 12), customer('B1', 13), customer('S2', 14), customer('D2', 15), customer('B2', 16)],
  products:[{ productId:'P1', productCode:'P1', revision:21, status:'ACTIVE' }],
  warehouses:[{ warehouseId:'W1', warehouseCode:'01', revision:31, status:'ACTIVE' }],
  orders:[
    { orderId:'O1', orderNo:'N1', customerId:'D1', revision:41, status:'OPEN' },
    { orderId:'O2', orderNo:'N2', customerId:'D2', revision:42, status:'OPEN' }
  ],
  orderItems:[
    { orderItemId:'OI1-A', orderId:'O1', productId:'P1', sourceRowNumber:2, revision:51, status:'OPEN', baseUnit:'EA', recognizedUnit:'EA', actualToBaseFactor:10, actualToRecognizedFactor:1, conversionSource:'ORDER_Q', conversionRuleId:'BOX10', conversionRuleVersion:'7' },
    { orderItemId:'OI1-B', orderId:'O1', productId:'P1', sourceRowNumber:2, revision:52, status:'OPEN', baseUnit:'EA', recognizedUnit:'EA', actualToBaseFactor:10, actualToRecognizedFactor:1, conversionSource:'ORDER_Q', conversionRuleId:'BOX10', conversionRuleVersion:'7' },
    { orderItemId:'OI2', orderId:'O2', productId:'P1', sourceRowNumber:3, revision:53, status:'OPEN', baseUnit:'EA', recognizedUnit:'EA', actualToBaseFactor:10, actualToRecognizedFactor:1, conversionSource:'ORDER_Q', conversionRuleId:'BOX10', conversionRuleVersion:'7' }
  ], dispatches:[], dispatchLines:[]
};
const allocation = (overrides = {}) => ({ customer:'가', productCode:'P1', productName:'상품', warehouse:'01', warehouseId:'W1', quantity:1, unit:'BOX', unitPrice:100,
  actualUnit:'BOX', baseUnit:'EA', recognizedUnit:'EA', actualToBaseFactor:10, actualToRecognizedFactor:1, conversionSource:'ORDER_Q', conversionRuleId:'BOX10', conversionRuleVersion:'7',
  salesCustomerId:'S1', deliveryCustomerId:'D1', billingCustomerId:'B1', ...overrides });
let workspace = { schemaVersion:'shipping-workspace/v2', planId:'PLAN-1', sourceFingerprint:'FP-1', basisDate:'2026-08-25', basisDateStatus:'valid', basisDates:['2026-08-25'], uploadDate:'20260825',
  allocations:[
    allocation({ sourceRowNumber:2, sourceOccurrence:2, sourceRowKey:'ORDER_ROW:2:ALLOC:B', orderNumber:'N1', quantity:2 }),
    allocation({ sourceRowNumber:2, sourceOccurrence:1, sourceRowKey:'ORDER_ROW:2:ALLOC:A', orderNumber:'N1', quantity:-0.5 }),
    allocation({ sourceRowNumber:3, sourceOccurrence:1, sourceRowKey:'ORDER_ROW:3:ALLOC:A', orderNumber:'N2', customer:'나', salesCustomerId:'S2', deliveryCustomerId:'D2', billingCustomerId:'B2' })
  ] };
workspace = await connectSaleStage4Workspace(workspace, { source, actor:'TEST', reviews:{
  '2:1':{ orderId:'O1', orderItemId:'OI1-A' }, '2:2':{ orderId:'O1', orderItemId:'OI1-B' }, '3:1':{ orderId:'O2', orderItemId:'OI2' }
} });
assert.deepEqual(workspace.saleStage4Sidecar.rows.map(row => [row.sourceRowNumber, row.sourceOccurrence, row.sourceRowKey]), [
  [2,2,'ORDER_ROW:2:ALLOC:B'], [2,1,'ORDER_ROW:2:ALLOC:A'], [3,1,'ORDER_ROW:3:ALLOC:A']
]);
assert.equal(new Set(workspace.saleStage4Sidecar.rows.map(row => row.stableGroupKey)).size, 2, 'confirmed role triples must split voucher groups');

const visibleSheet = workbookApi.buildSalesUploadSheet(workspace, XLSX);
const metaSheet = workbookApi.buildSalesMetaSheet(workspace, workbookApi.getSalesUploadRows(workspace), XLSX, '판매업로드');
const book = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(book, visibleSheet, '판매업로드');
XLSX.utils.book_append_sheet(book, metaSheet, '_NEXUS_SALES_META');
book.Workbook = { Sheets:[{ name:'판매업로드', Hidden:0 }, { name:'_NEXUS_SALES_META', Hidden:2 }] };
const reopened = XLSX.read(XLSX.write(book, { type:'array', bookType:'xlsx' }), { type:'array', raw:true });
assert.equal(reopened.Workbook.Sheets.find(row => row.name === '_NEXUS_SALES_META').Hidden, 2);
const visibleMatrix = XLSX.utils.sheet_to_json(reopened.Sheets['판매업로드'], { header:1, raw:true, defval:'' });
const metaMatrix = XLSX.utils.sheet_to_json(reopened.Sheets['_NEXUS_SALES_META'], { header:1, raw:true, defval:'' });
const itemCodeIndex = visibleMatrix[0].indexOf('품목코드');
const quantityIndex = visibleMatrix[0].indexOf('수량');
const priceIndex = visibleMatrix[0].indexOf('단가');
const visibleRows = visibleMatrix.slice(1).map((row, index) => ({ sourceLineNo:index + 2, itemCode:row[itemCodeIndex], quantity:row[quantityIndex], unit:'BOX', unitPrice:row[priceIndex] }));
const joined = joinSalesMeta({ visibleSheetName:'판매업로드', visibleRows, metaRows:readSalesMeta(metaMatrix) });
assert.equal(JSON.stringify(Array.from(joined, row => [row.sourceRowNumber, row.sourceOccurrence]).sort()), JSON.stringify([[2,1],[2,2],[3,1]]), 'sorting must not infer or change compound occurrence identity');
assert.equal(joined.find(row => row.quantity === -0.5).supplyAmount, -50, 'negative half quantity amount must remain symmetric');
const groups = groupVoucherRows('sale', joined, { voucherDate:'2026-08-25' });
assert.equal(groups.length, 2);
const frozen = groups.map(group => buildSalePostDraft({ ...group, sourceType:'ORDER_Q', originSystem:group.rows[0].originSystem, originTransactionId:group.rows[0].originTransactionId,
  sourceVoucherIndex:group.rows[0].sourceVoucherIndex, sourceDocumentKey:group.rows[0].sourceDocumentKey, saleDate:'2026-08-25' }, { actor:'TEST', occurredAt:'2026-08-25T00:00:00Z' }));
assert.equal(frozen.reduce((sum, draft) => sum + draft.lines.length, 0), 3);
assert.ok(frozen.every(draft => draft.commandSource.sourceDocumentKey && draft.commandSource.originTransactionId));

const linked = joined[0];
const detached = detachOrderQSaleLink(linked, { originSystem:'SMARTINPUT_FILE', originTransactionId:'FILE-DIGEST' });
assert.equal(detached.sourceOrderId, '');
assert.equal(detached.productId, linked.productId);
assert.equal(detached.productMasterRevision, linked.productMasterRevision);
assert.equal(detached.warehouseId, linked.warehouseId);
assert.equal(detached.salesCustomerId, linked.salesCustomerId);
assert.equal(detached.conversionSource, 'DIRECT_SAME_UNIT');
assert.equal(detached.actualToRecognizedFactor, 0);
const directDraft = buildSalePostDraft({ sourceType:'DIRECT', originSystem:'SMARTINPUT_FILE', originTransactionId:'FILE-DIGEST', sourceVoucherIndex:1,
  salesCustomerId:detached.salesCustomerId, deliveryCustomerId:detached.deliveryCustomerId, billingCustomerId:detached.billingCustomerId, saleDate:'2026-08-25', rows:[detached] }, { actor:'TEST', occurredAt:'2026-08-25T00:00:00Z' });
const directDocument = directDraft.commandSource.document;
for (const action of ['correct','reverse']) {
  const command = buildOfficialSaleEditCommand({ action, document:{ ...directDocument, businessStatus:'CONFIRMED', revision:1 }, lines:directDraft.lines,
    reason:`${action} reason`, actor:'TEST', occurredAt:'2026-08-25T01:00:00Z' });
  assert.equal(command.originSystem, 'SMARTINPUT_FILE');
  assert.equal(command.originTransactionId, 'FILE-DIGEST');
  assert.equal(command.lines[0].actualToRecognizedFactor, 0);
}
assert.equal(recomputeSaleLine({ quantity:-0.5, unitPrice:1, orderLinkMode:'DIRECT' }, { suggestedActualToBaseFactor:1, suggestedActualToRecognizedFactor:0 }).supplyAmount, -1);
const ordersProduct=readFileSync(new URL('../orders.html',import.meta.url),'utf8');
assert.match(ordersProduct,/ORDERQ_STAGE4_SALE_BRIDGE/); assert.match(ordersProduct,/connectSaleStage4Workspace\(state\.workspace/);
assert.match(ordersProduct,/saleStage4Reviews/);

console.log('ORDER Q stage4 actual product sale flow and real XLSX reopen tests passed');
