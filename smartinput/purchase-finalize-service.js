import { validatePurchaseGroup } from './legacy-integration-adapter.js?v=0.3.0';
import {
  postPurchaseGroup,
  SMARTINPUT_PURCHASE_ACTOR_ID
} from './purchase-official-stage3.js?v=0.6.0';
import {
  OFFICIAL_VOUCHER_IDENTITY_VERSION_V2,
  preflightOfficialVoucherV2
} from '../orderq/official-voucher-v2-contract.js?v=0.3.0';
import { resolveOfficialVoucherReferencesV2 } from './official-voucher-reference-resolver.js?v=0.2.0';

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
  const now = ports.now || (() => new Date().toISOString());
  return Object.freeze({
    contract: PURCHASE_FINALIZE_SERVICE_CONTRACT,
    async finalize(request = {}) {
      const results = [];
      for (const group of request.groups || []) {
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
          const result = await submitGroup(submitSource, {
            companyId: request.companyId,
            actor: request.actor || SMARTINPUT_PURCHASE_ACTOR_ID,
            originSystem: producer,
            manualSessionId: request.manualSessionId,
            occurredAt: now(),
            ...(request.identityVersion ? { identityVersion: request.identityVersion } : {})
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

export const PurchaseFinalizeService = createPurchaseFinalizeService();
