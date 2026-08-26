import { isAdminTestRuntime } from './admin-test-runtime.js?v=0.10.2';

export const ORDERQ_SYNC_SCHEMA = 'ONEAPP_ORDERQ_SYNC_V1';
export const CLOUD_URL_KEY = 'oneapp_cloud_sync_url_v1';
export const LEGACY_CLOUD_URL_KEY = 'merchCloudUrl_v870';
export const ADMIN_TEST_CLOUD_URL_KEY = '';

export class OrderQCloudError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'OrderQCloudError';
    Object.assign(this, details);
  }
}

export function getCloudUrl() {
  return 'NEXUS_GATEWAY';
}

export function setCloudUrl(url, remember = true) {
  return 'NEXUS_GATEWAY';
}

const OPERATION_BY_ACTION = Object.freeze({
  orderq_sync_push: 'orderq.sync.push', orderq_sync_pull: 'orderq.sync.pull',
  orderq_customer_reset_preview: 'orderq.customer.reset_preview', orderq_customer_reset_execute: 'orderq.customer.reset_execute',
  orderq_order_head: 'orderq.order.head', orderq_m9_migrate: 'orderq.central.migrate',
  orderq_m9_command_prepare: 'orderq.central.prepare', orderq_m9_command_commit: 'orderq.central.commit',
  orderq_m9_command_abort: 'orderq.central.abort', orderq_m9_pull: 'orderq.central.pull', orderq_m9_ping: 'orderq.central.ping',
  situation_orderq_begin: 'orderq.situation.begin', situation_orderq_page: 'orderq.situation.page', situation_orderq_head: 'orderq.situation.head'
});

function operationForAction(action) {
  if (globalThis.ONEAPP_AUTH?.appId === 'customer-manager') {
    if (action === 'orderq_sync_push') return 'customer.master.push';
    if (action === 'orderq_sync_pull') return 'customer.master.pull';
  }
  return OPERATION_BY_ACTION[action];
}

async function post(action, body = {}) {
  const operationId = operationForAction(action);
  if (!operationId) throw new OrderQCloudError('허용되지 않은 Gateway 작업입니다.', { code: 'GATEWAY_OPERATION_DENIED' });
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 60000);
  try {
    await globalThis.ONEAPP_AUTH?.ready;
    if (!globalThis.ONEAPP_AUTH?.gateway) throw new Error('NEXUS_AUTH_SESSION_REQUIRED');
    return await globalThis.ONEAPP_AUTH.gateway(operationId, body, { signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new OrderQCloudError('클라우드 응답 시간이 초과되었습니다. 로컬 저장값은 유지되며 다시 동기화할 수 있습니다.', { code: 'CLOUD_TIMEOUT', cause: error });
    if (error instanceof OrderQCloudError) throw error;
    throw new OrderQCloudError(error?.message || 'Gateway에 연결할 수 없습니다.', { code: 'GATEWAY_REQUEST_FAILED', cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

export function pushCloudChanges(deviceId, changes, requestId = '', customerResetGeneration = 0) {
  return post('orderq_sync_push', {
    schemaVersion: ORDERQ_SYNC_SCHEMA,
    deviceId,
    changes,
    customerResetGeneration: Number(customerResetGeneration || 0)
  });
}

export function pullCloudChanges(afterSequence = 0, limit = 200) {
  return post('orderq_sync_pull', {
    schemaVersion: ORDERQ_SYNC_SCHEMA,
    afterSequence,
    limit
  });
}

export function previewCustomerMasterReset() {
  return post('orderq_customer_reset_preview');
}

export function executeCustomerMasterReset(confirmation = '') {
  return post('orderq_customer_reset_execute', { confirmation });
}

export function getCloudOrderHead(orderId) {
  return post('orderq_order_head', {
    schemaVersion: ORDERQ_SYNC_SCHEMA,
    orderId
  });
}

export function migrateCentralDraftEntities(deviceId, idempotencyKey, entities) {
  return post('orderq_m9_migrate', {
    schemaVersion: 'ONEAPP_ORDERQ_CENTRAL_V1',
    deviceId,
    idempotencyKey,
    entities
  });
}

export function prepareCentralOfficialCommand(command) {
  return post('orderq_m9_command_prepare', {
    schemaVersion: 'ONEAPP_ORDERQ_CENTRAL_V1',
    ...command
  });
}

export function commitCentralOfficialCommand(command) {
  return post('orderq_m9_command_commit', {
    schemaVersion: 'ONEAPP_ORDERQ_CENTRAL_V1',
    ...command
  });
}

export function abortCentralOfficialCommand(command) {
  return post('orderq_m9_command_abort', {
    schemaVersion: 'ONEAPP_ORDERQ_CENTRAL_V1',
    ...command
  });
}

export function pullCentralOfficialChanges(afterSequence = 0, limit = 500) {
  return post('orderq_m9_pull', {
    schemaVersion: 'ONEAPP_ORDERQ_CENTRAL_V1',
    afterSequence,
    limit
  });
}

export function pingCentralAuthority() {
  return post('orderq_m9_ping', { schemaVersion: 'ONEAPP_ORDERQ_CENTRAL_V1' });
}

export function beginOrderQSituationRead(request = {}) {
  return post('situation_orderq_begin', { schemaVersion: 'ONEAPP_ORDERQ_CENTRAL_V1', ...request });
}

export function readOrderQSituationPage(request = {}) {
  return post('situation_orderq_page', { schemaVersion: 'ONEAPP_ORDERQ_CENTRAL_V1', ...request });
}

export function readOrderQSituationHead(request = {}) {
  return post('situation_orderq_head', { schemaVersion: 'ONEAPP_ORDERQ_CENTRAL_V1', ...request });
}
