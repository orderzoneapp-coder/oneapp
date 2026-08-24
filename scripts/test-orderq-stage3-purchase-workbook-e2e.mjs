import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const workbookApi=require('../orderFulfillmentWorkbook.js');
const encodeCell=({r,c})=>String.fromCharCode(65+c)+(r+1);
const aoa_to_sheet=matrix=>{const sheet={};matrix.forEach((row,r)=>row.forEach((v,c)=>{sheet[encodeCell({r,c})]={v,t:typeof v==='number'?'n':'s'};}));sheet['!ref']=`A1:${encodeCell({r:matrix.length-1,c:Math.max(...matrix.map(r=>r.length))-1})}`;return sheet;};
const XLSX={utils:{aoa_to_sheet,encode_cell:encodeCell,book_new:()=>({SheetNames:[],Sheets:{}}),book_append_sheet:(book,sheet,name)=>{book.SheetNames.push(name);book.Sheets[name]=sheet;}},write:book=>Buffer.from(JSON.stringify(book))};
const workspace={schemaVersion:'shipping-workspace/v2',basisDateStatus:'valid',uploadDate:'20260825',basisDate:'2026-08-25',basisDates:['2026-08-25'],createdAt:'2026-08-25T00:00:00.000Z',planId:'PLAN1',sourceFingerprint:'FP1',purchaseManagement:[
  {rowType:'main',inventoryMatched:true,productCode:'A',productName:'상품A',specification:'',purchaseNeed:2,purchase:'남경',unit:'EA',productId:'P1',supplierCustomerId:'C1',supplierCustomerCode:'S1',warehouseId:'W1',warehouseCode:'01',externalDocumentNo:'EXT-1'},
  {rowType:'main',inventoryMatched:true,productCode:'B',productName:'상품B',specification:'',purchaseNeed:3,purchase:'남경',unit:'EA',productId:'P2',supplierCustomerId:'C1',supplierCustomerCode:'S1',warehouseId:'W1',warehouseCode:'01',externalDocumentNo:'EXT-2'}
]};
const book=workbookApi.buildPurchaseUploadWorkbook(workspace,XLSX);
assert.deepEqual(book.SheetNames,['구매입력','_NEXUS_META']);
assert.equal(book.Workbook.Sheets.find(row=>row.name==='_NEXUS_META').Hidden,2);
assert.equal(workbookApi.PURCHASE_UPLOAD_HEADERS.length,20);
const reopened=JSON.parse(XLSX.write(book).toString());
assert.equal(reopened.Workbook.Sheets[1].Hidden,2);
assert.equal(book.Sheets['구매입력'].T2.v,'EXT-1');
assert.equal(book.Sheets['구매입력'].T3.v,'EXT-2');
const meta=workbookApi.buildPurchaseMetaRows(workspace,workbookApi.getPurchaseUploadRows(workspace));
assert.equal(meta.length,2); assert.notEqual(meta[0].sourceDocumentKey,meta[1].sourceDocumentKey);
assert.deepEqual(meta.map(row=>row.externalDocumentNo),['EXT-1','EXT-2']);
assert.equal(meta[0].rowDigest,workbookApi.purchaseMetaRowDigest(meta[0]));
console.log('ORDER Q stage3 purchase workbook e2e tests passed');
