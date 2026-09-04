import { ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER } from '../orderq/shopping-order-command-adapter.js?v=0.2.0';

export const SMARTINPUT_SHOPPING_ORDER_UPLOAD_SCHEMA = 'ONEAPP_SMARTINPUT_SHOPPING_ORDER_UPLOAD_V1';

const exactText = value => String(value ?? '').trim();
const normalizedKey = value => exactText(value).normalize('NFKC').toLowerCase().replace(/\s+/g, '');

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  return value;
}

function dateText(value) {
  const raw = exactText(value);
  const match = raw.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (!match) return '';
  const normalized = `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
  const date = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized ? '' : normalized;
}

function meaningfulRow(row = []) {
  return row.some(value => value === 0 || exactText(value) !== '');
}

export function isExactShoppingOrderMatrix(matrix = [], adapter = ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER) {
  return Array.isArray(matrix) && matrix.length > 0 && adapter.isExactSource(matrix[0]);
}

export function shoppingCustomerSelectionKey(value) {
  return normalizedKey(value);
}

export function shoppingProductSelectionKey(sourceRowNumber) {
  return String(Number(sourceRowNumber) || 0);
}

export function createShoppingOrderUpload({
  matrix = [], sourceCellMatrix = [], fileName = '', sheetName = '', fileFingerprint = '', uploadedAt = ''
} = {}, adapter = ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER) {
  if (!isExactShoppingOrderMatrix(matrix, adapter)) return null;
  const headers = matrix[0].map(value => String(value ?? ''));
  const rows = matrix.slice(1).map((sourceCells, offset) => ({
    sourceCells: clone(sourceCells),
    sourceCellEvidence: clone(sourceCellMatrix[offset + 1] || []),
    sourceRowNumber: Number(sourceCellMatrix[offset + 1]?.[0]?.rowIndex) + 1 || offset + 2,
    deliveryDate: dateText(sourceCells[0])
  })).filter(row => meaningfulRow(row.sourceCells));
  const validDates = [...new Set(rows.map(row => row.deliveryDate).filter(Boolean))].sort();
  const selectedDeliveryDate = validDates.at(-1) || '';
  const selectedRows = rows.filter(row => !row.deliveryDate || row.deliveryDate === selectedDeliveryDate);
  return {
    schemaVersion: SMARTINPUT_SHOPPING_ORDER_UPLOAD_SCHEMA,
    status: 'LOADED',
    fileName: exactText(fileName),
    sheetName: exactText(sheetName),
    fileFingerprint: exactText(fileFingerprint),
    uploadedAt: exactText(uploadedAt),
    headers,
    fullDataRowCount: rows.length,
    selectedDeliveryDate,
    sourceRows: selectedRows.map(({ sourceCells, sourceCellEvidence, sourceRowNumber }) => ({
      sourceCells, sourceCellEvidence, sourceRowNumber
    })),
    sourceMatrix: [headers, ...selectedRows.map(row => clone(row.sourceCells))],
    sourceCellMatrix: [clone(sourceCellMatrix[0] || []), ...selectedRows.map(row => clone(row.sourceCellEvidence))],
    customerSelections: {},
    productSelections: {},
    inspection: null,
    inspectionError: null,
    inspectedAt: ''
  };
}

function compactCustomer(customer = {}) {
  return {
    customerId: exactText(customer.customerId),
    customerCode: exactText(customer.customerCode || customer.erpCustomerCode),
    customerName: exactText(customer.customerName || customer.name)
  };
}

function compactProduct(product = {}) {
  return {
    productId: exactText(product.productId || product.masterProductId),
    masterProductId: exactText(product.masterProductId || product.productId),
    itemCode: exactText(product.itemCode || product.productCode),
    itemName: exactText(product.itemName || product.productName)
  };
}

export function selectShoppingCustomer(upload, sourceCustomerName, customer) {
  upload.customerSelections ||= {};
  upload.customerSelections[shoppingCustomerSelectionKey(sourceCustomerName)] = compactCustomer(customer);
  upload.inspection = null;
  return upload;
}

export function selectShoppingProduct(upload, sourceRowNumber, product) {
  upload.productSelections ||= {};
  upload.productSelections[shoppingProductSelectionKey(sourceRowNumber)] = compactProduct(product);
  upload.inspection = null;
  return upload;
}

export function buildShoppingOrderUploadRequest(upload, {
  companyId = '', warehouse = {}, actor = 'SMART_INPUT_ADMIN'
} = {}, adapter = ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER) {
  if (!upload || upload.schemaVersion !== SMARTINPUT_SHOPPING_ORDER_UPLOAD_SCHEMA) {
    throw new Error('SMARTINPUT_SHOPPING_ORDER_UPLOAD_INVALID');
  }
  const built = adapter.createCandidates(upload.sourceRows, {
    headers: upload.headers,
    companyId,
    orderDate: upload.selectedDeliveryDate,
    fileName: upload.fileName,
    sheetName: upload.sheetName,
    uploadedAt: upload.uploadedAt,
    resolveCustomer: raw => upload.customerSelections?.[shoppingCustomerSelectionKey(raw['거래처명'])] || {},
    resolveProduct: (_raw, row) => upload.productSelections?.[shoppingProductSelectionKey(row.sourceRowNumber)] || {},
    resolveWarehouse: () => ({
      warehouseId: exactText(warehouse.warehouseId),
      warehouseCode: exactText(warehouse.warehouseCode),
      warehouseName: exactText(warehouse.warehouseName || warehouse.name)
    })
  });
  return {
    built,
    request: {
      schemaVersion: adapter.capability().schemaVersion,
      companyId: exactText(companyId),
      actor: exactText(actor || 'SMART_INPUT_ADMIN'),
      candidates: built.candidates
    }
  };
}

export async function inspectShoppingOrderUpload(upload, context = {}, adapter = ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER) {
  const prepared = buildShoppingOrderUploadRequest(upload, context, adapter);
  if (prepared.built.issues.length) {
    return {
      schemaVersion: adapter.capability().schemaVersion,
      results: [],
      summary: { candidateCount: 0, duplicateCount: 0, newCount: 0, reviewRequiredCount: 0 },
      sourceIssues: prepared.built.issues
    };
  }
  return adapter.inspect(prepared.request);
}

export async function commitShoppingOrderUpload(upload, context = {}, adapter = ONEAPP_ORDERQ_SHOPPING_ORDER_COMMAND_ADAPTER) {
  const prepared = buildShoppingOrderUploadRequest(upload, context, adapter);
  if (prepared.built.issues.length) throw new Error(prepared.built.issues[0].message || prepared.built.issues[0].code);
  return adapter.commit(prepared.request);
}

export function shoppingUploadTotals(upload = {}) {
  const quantityIndex = upload.headers?.indexOf('수량') ?? -1;
  const amountIndex = upload.headers?.indexOf('금액') ?? -1;
  const number = value => {
    if (value === '' || value === null || value === undefined) return 0;
    const parsed = Number(String(value).replace(/[,\s원₩]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return (upload.sourceRows || []).reduce((total, row) => ({
    rowCount: total.rowCount + 1,
    quantity: total.quantity + number(row.sourceCells?.[quantityIndex]),
    amount: total.amount + number(row.sourceCells?.[amountIndex])
  }), { rowCount: 0, quantity: 0, amount: 0 });
}
