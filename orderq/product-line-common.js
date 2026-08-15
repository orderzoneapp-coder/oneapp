import { searchProductCatalog } from './product-master-search.js?v=0.8.0';

export const PRODUCT_LINE_CONTEXT = Object.freeze({
  ORDER: 'ORDER',
  DISPATCH: 'DISPATCH',
  PURCHASE: 'PURCHASE',
  SMARTPARSER: 'SMARTPARSER'
});

const EDITABLE_FIELDS = Object.freeze({
  ORDER: Object.freeze([
    'productId', 'itemCode', 'itemName', 'specification', 'boxQuantity', 'rawQuantity', 'quantity',
    'finalQuantity', 'rawUnit', 'finalUnit', 'price', 'priceType', 'supplyAmount', 'vatAmount', 'memo',
    'rawText', 'matchSource', 'matchStatus'
  ]),
  DISPATCH: Object.freeze([
    'actualProductId', 'actualProductCode', 'actualProductName', 'actualUnit', 'fulfillmentType',
    'plannedActualQuantity', 'plannedBaseQuantity', 'plannedRecognizedOrderQuantity', 'conversionType',
    'conversionRuleId', 'conversionRuleVersion', 'conversionRuleSnapshot', 'measurementRequired',
    'priceSource', 'actualProductUnitPriceWon', 'manualUnitPriceWon', 'priceChangeReason',
    'customerNoticeRequired', 'customerNoticeStatus'
  ]),
  PURCHASE: Object.freeze([
    'productId', 'productCode', 'productName', 'quantity', 'unit', 'baseQuantity', 'baseUnit',
    'unitCostWon', 'warehouseId', 'warehouseCode', 'warehouseName', 'sourceOrderItemId',
    'sourceDispatchId', 'sourceDispatchLineId'
  ]),
  SMARTPARSER: Object.freeze([
    'confirmedProductId', 'productId', 'itemCode', 'itemName', 'specification', 'finalUnit',
    'matchStatus', 'matchSource', 'candidateProducts'
  ])
});

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function contextCode(value) {
  const code = text(value).toUpperCase();
  if (!Object.values(PRODUCT_LINE_CONTEXT).includes(code)) throw new Error(`ORDERQ_PRODUCT_LINE_CONTEXT_INVALID:${code}`);
  return code;
}

export function searchLineProducts(query, catalog = [], limit = 8) {
  return searchProductCatalog(query, catalog, limit);
}

export function editProductLine(context, current = {}, patch = {}) {
  const code = contextCode(context);
  const next = { ...current };
  for (const field of EDITABLE_FIELDS[code]) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) next[field] = patch[field];
  }
  return next;
}

export function applyProductSelection(context, current = {}, product = {}, options = {}) {
  const code = contextCode(context);
  const productId = text(product.productId);
  const itemCode = text(product.itemCode || product.productCode);
  const itemName = text(product.itemName || product.productName);
  const specification = text(options.specification || product.specification);
  const unit = text(product.finalUnit || product.unit || options.unit);
  if (!productId) throw new Error('ORDERQ_PRODUCT_SELECTION_ID_REQUIRED');

  if (code === PRODUCT_LINE_CONTEXT.DISPATCH) {
    return editProductLine(code, current, {
      actualProductId: productId,
      actualProductCode: itemCode,
      actualProductName: itemName,
      actualUnit: unit || current.actualUnit || ''
    });
  }
  if (code === PRODUCT_LINE_CONTEXT.PURCHASE) {
    return editProductLine(code, current, {
      productId,
      productCode: itemCode,
      productName: itemName,
      unit: current.unit || unit,
      baseUnit: current.baseUnit || unit
    });
  }
  if (code === PRODUCT_LINE_CONTEXT.SMARTPARSER) {
    return editProductLine(code, current, {
      confirmedProductId: productId,
      productId,
      itemCode,
      itemName,
      specification,
      finalUnit: unit || text(options.rawUnit),
      matchStatus: 'MATCHED',
      matchSource: text(options.matchSource || product.source)
    });
  }
  return editProductLine(code, current, {
    productId,
    itemCode,
    itemName,
    specification,
    boxQuantity: product.boxQuantity ?? current.boxQuantity ?? null,
    finalUnit: unit,
    rawUnit: unit,
    matchStatus: 'MATCHED',
    matchSource: text(options.matchSource || product.source)
  });
}
