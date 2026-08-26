import assert from 'node:assert/strict';
import { planOfficialVoucherCommand } from '../orderq/official-voucher-core.js';
import { deriveFinancialCloseRows, reconcileOfficialDocument, validateOfficialChain } from '../orderq/dataops-close-core.js';

const at=index=>`2026-08-25T0${index}:00:00Z`;
function command(type,id,revision,document,lines){return {commandType:type,commandContract:'VOUCHER_CORE_V1',commandId:id,idempotencyKey:id,expectedRevision:revision,actor:'ADMIN',occurredAt:at(revision),reason:'close fixture',document,lines};}
const baseDocument={purchaseDocumentId:'P1',supplierCustomerId:'SUP',warehouseId:'W1',documentContract:'VOUCHER_CORE_V1',sourceDocumentKey:'DIRECT:P1',sourceType:'DIRECT',businessStatus:'DRAFT',status:'DRAFT',revision:1,purchaseDate:'2026-08-25'};
const line={purchaseLineId:'PL1',lineIdentityId:'PLI1',sourceLineKey:'1',productId:'SKU',warehouseId:'W1',quantity:10,baseQuantity:10,unitPrice:100,baseUnit:'EA'};
const post=planOfficialVoucherCommand({document:baseDocument,lines:[line],command:command('POST_PURCHASE','PC1',1,baseDocument,[line])});
const nextLine={...post.lines[0],quantity:7,actualQuantity:7,baseQuantity:7,supplyAmount:700,totalAmount:700};
const corrected=planOfficialVoucherCommand({document:post.document,lines:post.lines,movements:post.movements,entries:post.entries,command:command('CORRECT_PURCHASE','PC2',2,post.document,[nextLine])});
const purchaseChain={voucherEvents:[post.voucherEvent,corrected.voucherEvent],movements:[...post.movements,...corrected.movements],orderEvents:[],entries:[...post.entries,...corrected.entries]};
const purchaseRow=reconcileOfficialDocument({kind:'PURCHASE',document:corrected.document,lines:corrected.lines,...purchaseChain,closeRevisionId:'CR1'});
assert.equal(purchaseRow.documentNetAmount,700);assert.equal(purchaseRow.financialNet,700);assert.equal(Object.values(purchaseRow.movementNetBaseByKey)[0],7);
const wrongPartnerEntries=purchaseChain.entries.map((row,index)=>index===purchaseChain.entries.length-1?{...row,partnerId:'WRONG'}:row);assert.throws(()=>reconcileOfficialDocument({kind:'PURCHASE',document:corrected.document,lines:corrected.lines,...purchaseChain,entries:wrongPartnerEntries}),/FINANCIAL_PARTNER_NET_MISMATCH/);
const postedEntries=post.entries.map((row,index)=>({...row,ledgerSequence:index+1}));const postedFinancial=deriveFinancialCloseRows({entries:postedEntries,voucherEvents:[post.voucherEvent],customers:[{customerId:'SUP',customerCode:'S',customerName:'공급처'}]},'PAYABLE','CR1');assert.equal(postedFinancial[0].documentBusinessDate,'2026-08-25');assert.equal(postedFinancial[0].partnerName,'공급처');
assert.throws(()=>reconcileOfficialDocument({kind:'PURCHASE',document:corrected.document,lines:corrected.lines,...purchaseChain,movements:purchaseChain.movements.slice(1)}),/CARDINALITY/);

const zeroEffects=[{lineEffects:[]}];
assert.equal(validateOfficialChain({voucherEvents:zeroEffects,movements:[],orderEvents:[],entries:[]}),true);
assert.throws(()=>validateOfficialChain({voucherEvents:[{lineEffects:[{entityType:'INVENTORY_MOVEMENT',entityId:'M'}]}],movements:[],orderEvents:[],entries:[]}),/CARDINALITY/);
console.log('PASS stage6 official purchase revision chain exact net');
