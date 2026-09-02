import {
  postSaleGroup,
  SMARTINPUT_SALE_ACTOR_ID
} from './sale-official-stage4.js?v=0.6.0';

export const SALE_FINALIZE_SERVICE_CONTRACT = Object.freeze({
  version: 'ONEAPP_SMARTINPUT_SALE_FINALIZE_SERVICE_V1',
  input: 'prepared SmartInput sale groups and current reference snapshots',
  validatorPort: 'current sale handler bypass preserved; sale-official-stage4 validates only when masters are supplied',
  productResolverPort: 'prepared group rows from the existing SmartInput reference resolver',
  commandPort: 'sale-official-stage4 builder/orchestrator to ORDER Q official command Adapter',
  inventoryPlannerPort: 'ORDER Q Repository current planOfficialVoucherCommand path'
});

const value = input => String(input);

export function createSaleFinalizeService(ports = {}) {
  const submitGroup = ports.submitGroup || postSaleGroup;
  const now = ports.now || (() => new Date().toISOString());
  return Object.freeze({
    contract: SALE_FINALIZE_SERVICE_CONTRACT,
    async finalize(request = {}) {
      const results = [];
      for (const group of request.groups || []) {
        try {
          const producer = value(group.originSystem || group.rows?.[0]?.originSystem
            || (request.activeMethod === 'paste' ? 'SMARTINPUT_CLIPBOARD' : request.activeMethod === 'excel' ? 'SMARTINPUT_FILE' : 'SMARTINPUT_MANUAL')).toUpperCase();
          const producerTransactionId = value(group.originTransactionId || group.rows?.[0]?.originTransactionId
            || request.lastBatchContentHash || request.manualSessionId);
          const customerRevision = customerId => Number((request.customers || [])
            .find(row => value(row.customerId) === value(customerId))?.revision || 0);
          const hydratedGroup = {
            ...group,
            salesCustomerRevision: Number(group.salesCustomerRevision || group.rows?.[0]?.salesCustomerRevision || customerRevision(group.salesCustomerId)),
            deliveryCustomerRevision: Number(group.deliveryCustomerRevision || group.rows?.[0]?.deliveryCustomerRevision || customerRevision(group.deliveryCustomerId)),
            billingCustomerRevision: Number(group.billingCustomerRevision || group.rows?.[0]?.billingCustomerRevision || customerRevision(group.billingCustomerId)),
            rows: (group.rows || []).map(row => {
              const product = (request.products || []).find(item => value(item.productId || item.itemCode) === value(row.productId || row.itemCode));
              const warehouse = (request.warehouses || []).find(item => value(item.warehouseId || item.warehouseCode)
                === value(row.warehouseId || group.warehouseId || row.rowWarehouseCode));
              const sourceType = value(row.sourceType || group.sourceType || 'DIRECT').toUpperCase();
              return {
                ...row,
                sourceType,
                orderLinkMode: sourceType === 'ORDER_Q' ? 'ORDER_Q' : 'DIRECT',
                productId: row.productId || product?.productId || '',
                productMasterRevision: Number(row.productMasterRevision || product?.revision || 0),
                warehouseId: row.warehouseId || group.warehouseId || warehouse?.warehouseId || '',
                warehouseMasterRevision: Number(row.warehouseMasterRevision || warehouse?.revision || 0),
                actualToBaseFactor: sourceType === 'ORDER_Q' ? Number(row.actualToBaseFactor) : 1,
                actualToRecognizedFactor: sourceType === 'ORDER_Q' ? Number(row.actualToRecognizedFactor) : 0,
                actualUnit: row.actualUnit || row.unit || '',
                baseUnit: sourceType === 'ORDER_Q' ? row.baseUnit : (row.actualUnit || row.unit || ''),
                recognizedUnit: row.recognizedUnit || row.unit || '',
                conversionSource: sourceType === 'ORDER_Q' ? row.conversionSource : 'DIRECT_SAME_UNIT',
                conversionRuleId: sourceType === 'ORDER_Q' ? row.conversionRuleId : 'DIRECT_1_TO_1',
                conversionRuleVersion: sourceType === 'ORDER_Q' ? row.conversionRuleVersion : 'DIRECT_1_TO_1_V1'
              };
            })
          };
          const result = await submitGroup(hydratedGroup, {
            companyId: request.companyId,
            actor: request.actor || SMARTINPUT_SALE_ACTOR_ID,
            originSystem: producer,
            manualSessionId: producerTransactionId,
            occurredAt: now()
          });
          results.push({ ok: true, group, result });
        } catch (error) {
          results.push({ ok: false, group, error });
        }
      }
      return results;
    }
  });
}

export const SaleFinalizeService = createSaleFinalizeService();
