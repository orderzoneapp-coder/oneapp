import { connectSaleStage4Workspace } from '../orderq/sale-stage4-source-adapter.js?v=0.2.0';

const text = value => String(value ?? '').trim();

export function isDeferredOrderQAccessError(error) {
  const message = text(error?.message || error);
  const code = text(error?.code);
  return /ORDERQ_ACCESS_(?:DENIED|NOT_CONFIGURED)/.test(message)
    || ['CLOUD_URL_MISSING', 'CLOUD_TIMEOUT', 'CLOUD_NETWORK_ERROR', 'CLOUD_HTTP_ERROR',
      'CLOUD_RESPONSE_INVALID', 'CLOUD_ACTION_FAILED'].includes(code);
}

export async function connectSaleStage4ForAnalysis(workspace = {}, options = {}) {
  const connect = options.connect || connectSaleStage4Workspace;
  try {
    const linked = await connect(workspace, {
      reviews: options.reviews || workspace.saleStage4Reviews || {},
      actor: options.actor || 'ORDER_Q_ADMIN'
    });
    const result = { ...linked };
    delete result.saleStage4ConnectionError;
    return result;
  } catch (error) {
    if (options.allowDeferredAuth !== true || !isDeferredOrderQAccessError(error)) throw error;
    return {
      ...workspace,
      saleStage4ConnectionError: {
        code: text(error?.code) || (text(error?.message || error).includes('NOT_CONFIGURED')
          ? 'ORDERQ_ACCESS_NOT_CONFIGURED' : 'ORDERQ_ACCESS_DENIED'),
        retryable: true,
        action: 'orderq_m9_pull'
      }
    };
  }
}

if (typeof window !== 'undefined') {
  window.ORDERQ_STAGE4_SALE_BRIDGE = Object.freeze({ connectSaleStage4Workspace: connectSaleStage4ForAnalysis });
}

export default Object.freeze({ connectSaleStage4ForAnalysis, isDeferredOrderQAccessError });
