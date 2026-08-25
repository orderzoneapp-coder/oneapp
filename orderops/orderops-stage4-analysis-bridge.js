import { connectSaleStage4Workspace } from '../orderq/sale-stage4-source-adapter.js?v=0.2.0';
import { setCloudUrl, setCloudAccessToken } from '../orderq/orderq-cloud-adapter.js?v=0.16.0';

const text = value => String(value ?? '').trim();

export function isDeferredOrderQAccessError(error) {
  const message = text(error?.message || error);
  return /ORDERQ_ACCESS_(?:DENIED|NOT_CONFIGURED)/.test(message);
}

export async function connectSaleStage4ForAnalysis(workspace = {}, options = {}) {
  const cloudUrl = text(options.cloudUrl);
  const accessToken = text(options.accessToken);
  if (cloudUrl) (options.setCloudUrl || setCloudUrl)(cloudUrl, true);
  if (accessToken) (options.setCloudAccessToken || setCloudAccessToken)(accessToken, false);
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
        code: text(error?.message || error).includes('NOT_CONFIGURED') ? 'ORDERQ_ACCESS_NOT_CONFIGURED' : 'ORDERQ_ACCESS_DENIED',
        retryable: true,
        action: 'orderq_m9_pull'
      }
    };
  }
}

export default Object.freeze({ connectSaleStage4ForAnalysis, isDeferredOrderQAccessError });
