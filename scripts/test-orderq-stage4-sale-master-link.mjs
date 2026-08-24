import assert from 'node:assert/strict';
import { validateSaleGroup } from '../smartinput/sale-official-stage4.js';
const customer=id=>({customerId:id,revision:2,status:'ACTIVE'});const product={productId:'P',revision:3,status:'ACTIVE'};const warehouse={warehouseId:'W',revision:4,status:'ACTIVE'};const order={orderId:'O',customerId:'D',revision:5,status:'OPEN'};const item={orderItemId:'OI',orderId:'O',productId:'P',revision:6,status:'OPEN'};
const group={salesCustomerId:'S',salesCustomerRevision:2,deliveryCustomerId:'D',deliveryCustomerRevision:2,billingCustomerId:'B',billingCustomerRevision:2,voucherDate:'2026-08-25',rows:[{sourceLineKey:'L',productId:'P',productMasterRevision:3,warehouseId:'W',warehouseMasterRevision:4,actualQuantity:2,unitPrice:10,actualToBaseFactor:1,actualToRecognizedFactor:1,orderLinkMode:'ORDER_Q',sourceOrderId:'O',sourceOrderRevision:5,sourceOrderItemId:'OI',sourceOrderItemRevision:6}]};
const masters={customers:[customer('S'),customer('D'),customer('B')],products:[product],warehouses:[warehouse],orders:[order],orderItems:[item]};
assert.equal(validateSaleGroup(group,masters),true);
assert.throws(()=>validateSaleGroup({...group,rows:[{...group.rows[0],sourceOrderItemRevision:5}]},masters),/SOURCE_REVISION_STALE/);
assert.throws(()=>validateSaleGroup({...group,deliveryCustomerId:'S'},masters),/DELIVERY_ORDER_CUSTOMER_MISMATCH/);
console.log('ORDER Q stage4 sale master/link tests passed');
