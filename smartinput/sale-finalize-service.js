import {
  inspectSaleGroupStocktake,
  postSaleGroup,
  SMARTINPUT_SALE_ACTOR_ID
} from './sale-official-stage4.js?v=1.0.0';
import { OFFICIAL_VOUCHER_IDENTITY_VERSION_V2 } from '../orderq/official-voucher-v2-contract.js?v=0.5.0';
import { resolveOfficialVoucherReferencesV2 } from './official-voucher-reference-resolver.js?v=0.2.0';
import {
  createOfficialStocktakeDecisionsV2,
  OfficialStocktakeConflictRequiredError,
  OfficialStocktakeInspectionUnavailableError,
  officialStocktakeConflictKeyV2
} from '../orderq/stocktake-conflict-v2.js?v=0.2.0';

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
  const inspectGroup = ports.inspectGroup || (ports.submitGroup ? null : inspectSaleGroupStocktake);
  const now = ports.now || (() => new Date().toISOString());
  return Object.freeze({
    contract: SALE_FINALIZE_SERVICE_CONTRACT,
    async finalize(request = {}) {
      const groups = request.groups || [];
      const outcomes = new Map();
      const prepared = [];
      for (const group of groups) {
        try {
          const identityV2 = value(request.identityVersion || '').trim() === OFFICIAL_VOUCHER_IDENTITY_VERSION_V2;
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
          const submitSource = identityV2 ? resolveOfficialVoucherReferencesV2({
            kind: 'SALE',
            companyId: request.companyId || hydratedGroup.companyId,
            group: hydratedGroup,
            products: request.products || [],
            customers: request.customers || [],
            productReferenceSnapshotId: request.productReferenceSnapshotId,
            customerReferenceSnapshotId: request.customerReferenceSnapshotId
          }) : hydratedGroup;
          prepared.push({ group, identityV2, submitSource, context: {
            companyId: request.companyId,
            actor: request.actor || SMARTINPUT_SALE_ACTOR_ID,
            originSystem: producer,
            manualSessionId: producerTransactionId,
            occurredAt: now(),
            ...(request.identityVersion ? { identityVersion: request.identityVersion } : {})
          } });
        } catch (error) {
          outcomes.set(group, { ok: false, group, error });
        }
      }

      const v2Prepared = prepared.filter(row => row.identityV2);
      if (v2Prepared.length) {
        if (typeof inspectGroup !== 'function') {
          const error = new OfficialStocktakeInspectionUnavailableError();
          prepared.forEach(row => outcomes.set(row.group, { ok: false, group: row.group, error }));
          return groups.map(group => outcomes.get(group));
        }
        const assessments = [];
        try {
          for (const row of v2Prepared) {
            assessments.push({ row, assessment: await inspectGroup(row.submitSource, row.context) });
          }
        } catch (error) {
          prepared.forEach(row => outcomes.set(row.group, { ok: false, group: row.group, error }));
          return groups.map(group => outcomes.get(group));
        }
        const conflicts = assessments.flatMap(row => row.assessment.conflicts || []);
        if (conflicts.length && !Array.isArray(request.stocktakeDecisions)) {
          const error = new OfficialStocktakeConflictRequiredError(conflicts);
          prepared.forEach(row => outcomes.set(row.group, { ok: false, group: row.group, error }));
          return groups.map(group => outcomes.get(group));
        }
        if (conflicts.length || request.stocktakeDecisions !== undefined) {
          try {
            const decisions = createOfficialStocktakeDecisionsV2({
              conflicts,
              selections: request.stocktakeDecisions,
              actor: v2Prepared[0].context.actor
            });
            const decisionByConflict = new Map(conflicts.map((conflict, index) => [
              officialStocktakeConflictKeyV2(conflict), decisions[index]
            ]));
            for (const { row, assessment } of assessments) {
              row.context.stocktakeDecisions = (assessment.conflicts || [])
                .map(conflict => decisionByConflict.get(officialStocktakeConflictKeyV2(conflict)));
            }
            for (const row of v2Prepared) await inspectGroup(row.submitSource, row.context);
          } catch (error) {
            prepared.forEach(row => outcomes.set(row.group, { ok: false, group: row.group, error }));
            return groups.map(group => outcomes.get(group));
          }
        }
      }

      for (const row of prepared) {
        try {
          const result = await submitGroup(row.submitSource, row.context);
          outcomes.set(row.group, { ok: true, group: row.group, result });
        } catch (error) {
          outcomes.set(row.group, { ok: false, group: row.group, error });
        }
      }
      return groups.map(group => outcomes.get(group));
    }
  });
}

export const SaleFinalizeService = createSaleFinalizeService();
