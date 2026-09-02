import { validatePurchaseGroup } from './legacy-integration-adapter.js?v=0.3.0';
import {
  inspectPurchaseGroupStocktake,
  postPurchaseGroup,
  SMARTINPUT_PURCHASE_ACTOR_ID
} from './purchase-official-stage3.js?v=0.7.0';
import {
  OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
  preflightOfficialVoucherV2
} from '../orderq/official-voucher-v2-contract.js?v=0.4.0';
import { resolveOfficialVoucherReferencesV2 } from './official-voucher-reference-resolver.js?v=0.2.0';
import {
  createOfficialStocktakeDecisionsV2,
  OfficialStocktakeConflictRequiredError
} from '../orderq/stocktake-conflict-v2.js?v=0.1.0';

export const PURCHASE_FINALIZE_SERVICE_CONTRACT = Object.freeze({
  version: 'ONEAPP_SMARTINPUT_PURCHASE_FINALIZE_SERVICE_V1',
  input: 'prepared SmartInput purchase groups and current reference snapshots',
  validatorPort: 'V1 legacy-integration-adapter.validatePurchaseGroup / V2 official-voucher-v2-contract.preflightOfficialVoucherV2',
  commandPort: 'purchase-official-stage3 builder/orchestrator to ORDER Q official command Adapter',
  inventoryPlannerPort: 'ORDER Q Repository current planOfficialVoucherCommand path'
});

export function createPurchaseFinalizeService(ports = {}) {
  const validateGroup = ports.validateGroup || validatePurchaseGroup;
  const submitGroup = ports.submitGroup || postPurchaseGroup;
  const inspectGroup = ports.inspectGroup || (ports.submitGroup
    ? (async () => ({ conflicts: [] }))
    : inspectPurchaseGroupStocktake);
  const now = ports.now || (() => new Date().toISOString());
  return Object.freeze({
    contract: PURCHASE_FINALIZE_SERVICE_CONTRACT,
    async finalize(request = {}) {
      const groups = request.groups || [];
      const outcomes = new Map();
      const prepared = [];
      for (const group of groups) {
        try {
          const identityV2 = String(request.identityVersion || '').trim() === OFFICIAL_VOUCHER_IDENTITY_VERSION_V2;
          const resolvedGroup = identityV2 ? resolveOfficialVoucherReferencesV2({
            kind: 'PURCHASE',
            companyId: request.companyId || group.companyId,
            group,
            products: request.masters?.products || request.products || [],
            customers: request.masters?.customers || request.customers || [],
            productReferenceSnapshotId: request.productReferenceSnapshotId,
            customerReferenceSnapshotId: request.customerReferenceSnapshotId
          }) : group;
          const preflight = identityV2 ? preflightOfficialVoucherV2({
            ...resolvedGroup,
            kind: 'PURCHASE',
            companyId: request.companyId || resolvedGroup.companyId,
            warehouseId: resolvedGroup.warehouseId,
            rows: resolvedGroup.rows
          }) : null;
          if (!identityV2) validateGroup(group, request.masters || {});
          const submitSource = preflight
            ? { ...resolvedGroup, companyId: preflight.companyId, rows: preflight.rows }
            : group;
          const producer = request.activeMethod === 'paste' ? 'SMARTINPUT_CLIPBOARD' : 'SMARTINPUT_MANUAL';
          prepared.push({ group, identityV2, submitSource, context: {
            companyId: request.companyId,
            actor: request.actor || SMARTINPUT_PURCHASE_ACTOR_ID,
            originSystem: producer,
            manualSessionId: request.manualSessionId,
            occurredAt: now(),
            ...(request.identityVersion ? { identityVersion: request.identityVersion } : {})
          } });
        } catch (error) {
          outcomes.set(group, { ok: false, group, error });
        }
      }

      const v2Prepared = prepared.filter(row => row.identityV2);
      if (v2Prepared.length) {
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
        if (conflicts.length && !request.stocktakeDecision) {
          const error = new OfficialStocktakeConflictRequiredError(conflicts);
          prepared.forEach(row => outcomes.set(row.group, { ok: false, group: row.group, error }));
          return groups.map(group => outcomes.get(group));
        }
        if (conflicts.length) {
          const judgedAt = request.stocktakeDecision.judgedAt || now();
          try {
            for (const { row, assessment } of assessments) {
              row.context.stocktakeDecisions = createOfficialStocktakeDecisionsV2({
                conflicts: assessment.conflicts || [],
                decisionType: request.stocktakeDecision.decisionType,
                actor: row.context.actor,
                judgedAt
              });
            }
            // Re-read every affected checkpoint before the first write. The
            // Repository repeats this inside each write transaction.
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

export const PurchaseFinalizeService = createPurchaseFinalizeService();
