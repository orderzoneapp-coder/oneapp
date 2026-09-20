import {
  OPTIONAL_OPERATION_ERROR_CODE,
  OPTIONAL_OPERATION_TIMEOUT_MS,
  createOptionalOperationLoader
} from './optional-operation-loader.js?v=0.1.0';

const text = value => String(value ?? '').normalize('NFKC').trim();
const normalize = value => text(value).toLowerCase().replace(/\s+/g, '');
const optionalModuleLoader = createOptionalOperationLoader({ importModule: path => import(path) });

async function load(path) {
  const resolved = new URL(path, import.meta.url);
  return optionalModuleLoader.loadModule({
    feature: `legacy-integration:${resolved.pathname}`,
    assetVersion: resolved.searchParams.get('v') || 'unversioned',
    specifier: path,
    timeoutMs: OPTIONAL_OPERATION_TIMEOUT_MS.localModule
  });
}

function unavailable(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

export async function loadProductCatalog() {
  const module = await load('../orderq/product-master-search.js');
  const result = await module.loadProductCatalog();
  return {
    ...result,
    products: (result.products || []).map(product => ({
      ...product,
      masterProductId: product.masterProductId || product.productId || ''
    }))
  };
}

export function warehouseDisplayName(input = {}) {
  return text(input.warehouseName || input.warehouse || input.warehouseCode);
}

function warehouseCode(value) {
  const raw = text(value);
  if (/^\d+$/.test(raw)) return raw.padStart(2, '0');
  return raw.replace(/\s+/g, '').toUpperCase();
}

export function matchWarehouseInput(input, warehouses = [], aliases = []) {
  const raw = typeof input === 'object' ? input : { warehouse: input };
  const name = warehouseDisplayName(raw);
  const code = warehouseCode(raw.warehouseCode || (/^0*\d+/.test(name) ? name.match(/^0*(\d+)/)?.[1] : ''));
  const id = text(raw.warehouseId);
  const normalizedName = normalize(name);
  return warehouses.find(row => id && text(row.warehouseId) === id)
    || warehouses.find(row => code && warehouseCode(row.warehouseCode) === code)
    || warehouses.find(row => normalize(row.warehouseName) === normalizedName)
    || warehouses.find(row => aliases.some(alias => normalize(alias.rawText || alias.normalizedText) === normalizedName && text(alias.warehouseId) === text(row.warehouseId)))
    || null;
}

export async function loadWarehouseCatalog() {
  const module = await load('../orderq/warehouse-master.js');
  return module.loadWarehouseCatalog();
}

export async function listCustomers() {
  const module = await load('../customer-master/read-adapter.js');
  const snapshot = await module.getCustomerSnapshot({ includeInactive: true });
  return snapshot?.data?.customers || [];
}

export async function ensureCustomerMasterReady() {
  const customers = await listCustomers();
  return { source: 'CUSTOMER_MASTER_SNAPSHOT', customers, sync: null };
}

export async function createLiveCustomer() {
  throw unavailable('CUSTOMER_CREATE_UNAVAILABLE', '거래처 등록 연결을 사용할 수 없습니다. 직접 입력과 초안 저장은 계속할 수 있습니다.');
}

export async function createOrder(payload) {
  const module = await load('../orderq/order-intake-engine.js?v=0.8.0');
  return module.createOrder(payload);
}

export async function syncAfterLocalMutation(orderId) {
  const module = await load('../orderq/orderq-sync-engine.js');
  return module.syncAfterLocalMutation(orderId);
}

export async function syncOfficialAfterLocalMutation(companyId) {
  const module = await load('../orderq/official-voucher-sync.js?v=0.1.0');
  return module.syncOfficialAfterLocalMutation(companyId);
}

export async function syncOfficialVouchers(companyId) {
  const module = await load('../orderq/official-voucher-sync.js?v=0.1.0');
  return module.syncOfficialVouchers(companyId);
}

export const SMARTINPUT_PURCHASE_ACTOR_ID = 'SMART_INPUT_ADMIN';
export const SMARTINPUT_SALE_ACTOR_ID = 'SMART_INPUT_ADMIN';

export async function loadPurchaseStage3Capability() {
  try {
    const module = await load('./purchase-official-stage3.js?v=0.9.1');
    return await module.loadPurchaseStage3Capability();
  } catch (error) {
    return { ready: false, code: 'PURCHASE_FINALIZE_UNAVAILABLE', detail: text(error?.message || error) };
  }
}

export async function loadSaleStage4Capability() {
  try {
    const module = await load('./sale-official-stage4.js?v=1.1.1');
    return await module.loadSaleStage4Capability();
  } catch (error) {
    return { ready: false, code: 'SALE_FINALIZE_UNAVAILABLE', detail: text(error?.message || error) };
  }
}

export function validatePurchaseGroup(group = {}) {
  if (!text(group.supplierCustomerId || group.supplierCustomerName)) throw unavailable('PURCHASE_SUPPLIER_REQUIRED', '구매처를 확인하세요.');
  if (!text(group.voucherDate)) throw unavailable('PURCHASE_DATE_REQUIRED', '구매일자를 확인하세요.');
  if (!Array.isArray(group.rows) || !group.rows.length) throw unavailable('PURCHASE_ROWS_REQUIRED', '구매 상품을 입력하세요.');
  group.rows.forEach((row, index) => {
    if (!text(row.productId || row.itemCode || row.itemName)) throw unavailable('PURCHASE_ITEM_REQUIRED', `${index + 1}행 상품을 확인하세요.`);
    if (!Number.isFinite(Number(row.actualQuantity ?? row.quantity))) throw unavailable('PURCHASE_QUANTITY_REQUIRED', `${index + 1}행 수량을 확인하세요.`);
  });
  return true;
}

export async function postPurchaseGroup(group, context = {}) {
  try {
    const module = await load('./purchase-official-stage3.js?v=0.9.1');
    return await module.postPurchaseGroup(group, context);
  } catch (error) {
    if ([OPTIONAL_OPERATION_ERROR_CODE.RESULT_UNKNOWN, OPTIONAL_OPERATION_ERROR_CODE.RESULT_LOOKUP_FAILED].includes(error?.code)) throw error;
    throw unavailable('PURCHASE_FINALIZE_UNAVAILABLE', '구매 원장 연결을 사용할 수 없습니다. 현재 작업과 초안은 유지됩니다.', error);
  }
}

export async function postSaleGroup(group, context = {}) {
  try {
    const module = await load('./sale-official-stage4.js?v=1.1.1');
    return await module.postSaleGroup(group, context);
  } catch (error) {
    if ([OPTIONAL_OPERATION_ERROR_CODE.RESULT_UNKNOWN, OPTIONAL_OPERATION_ERROR_CODE.RESULT_LOOKUP_FAILED].includes(error?.code)) throw error;
    throw unavailable('SALE_FINALIZE_UNAVAILABLE', '판매 원장 연결을 사용할 수 없습니다. 현재 작업과 초안은 유지됩니다.', error);
  }
}
