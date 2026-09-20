import {
  buildEstimateF8Data,
  buildEstimateDuplicateGroups,
  validateEstimateRows
} from './estimate-output.js?v=0.2.9';
import { buildPurchaseSalesUploadData } from './purchase-sales-output.js?v=0.1.2';

const now = () => globalThis.performance?.now?.() ?? Date.now();

self.onmessage = event => {
  const message = event.data || {};
  const startedAt = now();
  try {
    let payload;
    if (message.phase === 'ESTIMATE_F8_PREPARE') {
      const rows = message.payload?.rows || [];
      const outputConfig = message.payload?.outputConfig || {};
      payload = {
        rawValidation: validateEstimateRows(rows),
        duplicateGroups: buildEstimateDuplicateGroups(rows, outputConfig)
      };
    } else if (message.phase === 'ESTIMATE_F8_BUILD') {
      const rows = message.payload?.rows || [];
      const options = message.payload?.options || {};
      payload = buildEstimateF8Data(rows, {
        ...options,
        duplicateResolutions: new Map(message.payload?.duplicateResolutionEntries || [])
      });
    } else if (message.phase === 'PURCHASE_SALES_BUILD') {
      payload = buildPurchaseSalesUploadData(message.payload?.rows || []);
    } else {
      throw new Error(`지원하지 않는 계산 단계입니다: ${message.phase || ''}`);
    }
    self.postMessage({ jobId: message.jobId, status: 'READY', payload, metrics: { computeMs: now() - startedAt } });
  } catch (error) {
    self.postMessage({ jobId: message.jobId, status: 'ERROR', code: error?.code || 'STAGE5_COMPUTE_FAILED', message: error?.message || String(error) });
  }
};
