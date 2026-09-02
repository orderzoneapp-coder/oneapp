import { validatePurchaseGroup } from './legacy-integration-adapter.js?v=0.3.0';
import {
  postPurchaseGroup,
  SMARTINPUT_PURCHASE_ACTOR_ID
} from './purchase-official-stage3.js?v=0.4.0';

export const PURCHASE_FINALIZE_SERVICE_CONTRACT = Object.freeze({
  version: 'ONEAPP_SMARTINPUT_PURCHASE_FINALIZE_SERVICE_V1',
  input: 'prepared SmartInput purchase groups and current reference snapshots',
  validatorPort: 'legacy-integration-adapter.validatePurchaseGroup',
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
          validateGroup(group, request.masters || {});
          const producer = request.activeMethod === 'paste' ? 'SMARTINPUT_CLIPBOARD' : 'SMARTINPUT_MANUAL';
          const result = await submitGroup(group, {
            companyId: request.companyId,
            actor: request.actor || SMARTINPUT_PURCHASE_ACTOR_ID,
            originSystem: producer,
            manualSessionId: request.manualSessionId,
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

export const PurchaseFinalizeService = createPurchaseFinalizeService();
