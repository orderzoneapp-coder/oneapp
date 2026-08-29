const timeout = (promise, timeoutMs, code) => new Promise((resolve, reject) => {
  const timer = globalThis.setTimeout(() => reject(Object.assign(new Error(code), { code })), timeoutMs);
  Promise.resolve(promise).then(
    value => { globalThis.clearTimeout(timer); resolve(value); },
    error => { globalThis.clearTimeout(timer); reject(error); }
  );
});

function bridge() {
  return globalThis.__SMARTINPUT_INTEGRATION_BRIDGE__ || {};
}

async function optionalImport(path, code) {
  try {
    return await import(path);
  } catch (error) {
    throw Object.assign(new Error(code), { code, cause: error });
  }
}

export async function loadCustomerReferences() {
  if (bridge().loadCustomers) return bridge().loadCustomers();
  const module = await optionalImport('../orderq/customer-master.js?v=0.19.0', 'CUSTOMER_REFERENCE_UNAVAILABLE');
  const rows = await timeout(module.listCustomers?.({ includeInactive: false }), 5000, 'CUSTOMER_REFERENCE_TIMEOUT');
  if (!Array.isArray(rows)) throw Object.assign(new Error('CUSTOMER_REFERENCE_INVALID'), { code: 'CUSTOMER_REFERENCE_INVALID' });
  return rows;
}

export async function loadProductReferences() {
  if (bridge().loadProducts) return bridge().loadProducts();
  const module = await optionalImport('../orderq/product-master-search.js?v=0.7.1', 'PRODUCT_REFERENCE_UNAVAILABLE');
  const result = await timeout(module.loadProductCatalog?.(), 5000, 'PRODUCT_REFERENCE_TIMEOUT');
  if (!result || !Array.isArray(result.products)) throw Object.assign(new Error('PRODUCT_REFERENCE_INVALID'), { code: 'PRODUCT_REFERENCE_INVALID' });
  if (Array.isArray(result.errors) && result.errors.length) {
    throw Object.assign(new Error(result.errors.join(' · ')), { code: 'PRODUCT_REFERENCE_FAILED', causes: [...result.errors] });
  }
  return result;
}

export async function loadWarehouseReferences() {
  if (bridge().loadWarehouses) return bridge().loadWarehouses();
  const module = await optionalImport('../orderq/warehouse-master.js?v=0.8.0', 'WAREHOUSE_REFERENCE_UNAVAILABLE');
  const result = await timeout(module.loadWarehouseCatalog?.(), 5000, 'WAREHOUSE_REFERENCE_TIMEOUT');
  if (!result || !Array.isArray(result.warehouses)) throw Object.assign(new Error('WAREHOUSE_REFERENCE_INVALID'), { code: 'WAREHOUSE_REFERENCE_INVALID' });
  if (Array.isArray(result.errors) && result.errors.length) {
    throw Object.assign(new Error(result.errors.join(' · ')), { code: 'WAREHOUSE_REFERENCE_FAILED', causes: [...result.errors] });
  }
  return result;
}

export async function saveOrderLocal(payload) {
  if (bridge().createOrder) return bridge().createOrder(payload);
  const module = await optionalImport('../orderq/order-intake-engine.js?v=0.7.1', 'ORDER_LOCAL_WRITER_UNAVAILABLE');
  if (typeof module.createOrder !== 'function') throw Object.assign(new Error('ORDER_LOCAL_WRITER_UNAVAILABLE'), { code: 'ORDER_LOCAL_WRITER_UNAVAILABLE' });
  return module.createOrder(payload);
}

export async function syncOrderInBackground(orderId) {
  if (bridge().syncOrder) return bridge().syncOrder(orderId);
  const module = await optionalImport('../orderq/orderq-sync-engine.js?v=0.7.1', 'ORDER_SYNC_UNAVAILABLE');
  if (typeof module.syncAfterLocalMutation !== 'function') throw Object.assign(new Error('ORDER_SYNC_UNAVAILABLE'), { code: 'ORDER_SYNC_UNAVAILABLE' });
  return module.syncAfterLocalMutation(orderId);
}

export async function finalizePurchase(group) {
  if (bridge().finalizePurchase) return bridge().finalizePurchase(group);
  const module = await optionalImport('../orderq/purchase-official-editor.js?v=0.1.0', 'PURCHASE_FINALIZE_UNAVAILABLE');
  if (typeof module.postPurchaseGroup !== 'function') throw Object.assign(new Error('PURCHASE_FINALIZE_UNAVAILABLE'), { code: 'PURCHASE_FINALIZE_UNAVAILABLE' });
  return module.postPurchaseGroup(group);
}

export async function finalizeSale(group) {
  if (bridge().finalizeSale) return bridge().finalizeSale(group);
  const module = await optionalImport('../orderq/sale-official-editor.js?v=0.1.0', 'SALE_FINALIZE_UNAVAILABLE');
  if (typeof module.postSaleGroup !== 'function') throw Object.assign(new Error('SALE_FINALIZE_UNAVAILABLE'), { code: 'SALE_FINALIZE_UNAVAILABLE' });
  return module.postSaleGroup(group);
}

export const INTEGRATION_KIND = Object.freeze({
  LOCAL: 'LOCAL_OPERATION',
  BACKGROUND: 'BACKGROUND_SYNC',
  SERVER: 'SERVER_FINALIZE'
});
