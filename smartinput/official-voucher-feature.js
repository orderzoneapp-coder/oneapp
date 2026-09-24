// SmartInput role consolidation. No data migration or business-policy change.
// Edit implementations in the named sections below; former files are removed.
import * as officialCommandAdapterDependency0 from "../orderq/official-command-adapter.js?v=0.6.0";
import * as officialVoucherCoreDependency1 from "../orderq/official-voucher-core.js?v=0.24.0";
import * as officialVoucherV2ContractDependency2 from "../orderq/official-voucher-v2-contract.js?v=0.5.0";
import * as optionalOperationLoaderDependency3 from "./optional-operation-loader.js?v=0.1.0";
import * as legacyIntegrationAdapterDependency4 from "./legacy-integration-adapter.js?v=0.17.0";
import * as stocktakeConflictV2Dependency5 from "../orderq/stocktake-conflict-v2.js?v=0.2.0";

// ============================================================================
// official-voucher-reference-resolver.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const officialVoucherReferenceResolverSection = (() => {


const OFFICIAL_PRODUCT_RESOLUTION_STATUS = Object.freeze({
  MATCHED: 'MATCHED',
  UNRESOLVED: 'UNRESOLVED_PRODUCT'
});

const OFFICIAL_PARTNER_RESOLUTION_STATUS = Object.freeze({
  MATCHED: 'MATCHED',
  NOT_PROVIDED: 'CUSTOMER_NOT_PROVIDED',
  UNRESOLVED: 'UNRESOLVED_CUSTOMER'
});

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const snapshotText = value => String(value ?? '').trim();

function officialProductCodeKey(value) {
  return snapshotText(value);
}

function normalizedCustomerCodeKey(value) {
  return snapshotText(value).normalize('NFKC').toLocaleLowerCase('ko').replace(/\s+/g, ' ');
}

function firstOwnValue(source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) return source[key];
  }
  return undefined;
}

function currentCompanyRow(row, companyId) {
  const rowCompanyId = snapshotText(row?.companyId);
  return !rowCompanyId || rowCompanyId === snapshotText(companyId);
}

function activeProduct(row) {
  return row?.active !== false
    && !['INACTIVE', 'DELETED'].includes(snapshotText(row?.status || 'ACTIVE').toUpperCase())
    && snapshotText(row?.productIdentityType).toUpperCase() !== 'TEMPORARY';
}

function activeCustomer(row) {
  return row?.active !== false
    && !['INACTIVE', 'DELETED'].includes(snapshotText(row?.status || 'ACTIVE').toUpperCase())
    && snapshotText(row?.qualityStatus).toUpperCase() !== 'SUPERSEDED';
}

function productCode(row = {}) {
  return snapshotText(row.itemCode || row.productCode || row['코드'] || row['품목코드'] || row.raw?.['코드'] || row.raw?.['품목코드']);
}

function productId(row = {}) {
  return snapshotText(row?.productId || row?.masterProductId);
}

function customerCode(row = {}) {
  return snapshotText(row.customerCode || row.erpCustomerCode);
}

function scopedExactMatches(rows, companyId, inputCode, codeOf, codeKey, active) {
  const inputKey = codeKey(inputCode);
  if (!inputKey) return [];
  return (rows || []).filter(row => currentCompanyRow(row, companyId)
    && active(row)
    && codeKey(codeOf(row)) === inputKey);
}

function inputProductCode(row = {}) {
  return snapshotText(firstOwnValue(row, [
    'originalProductCode', 'sourceProductCode', 'rawProductCode', 'itemCode', 'productCode'
  ]));
}

function productResolution(companyId, row, products, referenceSnapshotId) {
  const inputCode = inputProductCode(row);
  const matches = scopedExactMatches(
    products,
    companyId,
    inputCode,
    productCode,
    officialProductCodeKey,
    activeProduct
  );
  const matched = matches.length === 1 ? matches[0] : null;
  const matchedId = productId(matched);
  if (matched && matchedId) {
    return {
      status: OFFICIAL_PRODUCT_RESOLUTION_STATUS.MATCHED,
      reason: 'EXACT_COMPANY_PRODUCT_CODE',
      companyId: snapshotText(companyId),
      inputProductCode: inputCode,
      matchedProductCode: productCode(matched),
      matchedProductId: matchedId,
      productMasterRevision: Number(matched.revision || matched.masterRevision || matched.raw?.revision || 0),
      referenceSnapshotId: snapshotText(referenceSnapshotId)
    };
  }
  return {
    status: OFFICIAL_PRODUCT_RESOLUTION_STATUS.UNRESOLVED,
    reason: !inputCode
      ? 'PRODUCT_CODE_NOT_PROVIDED'
      : matches.length > 1
        ? 'PRODUCT_CODE_AMBIGUOUS'
        : matched
          ? 'MATCHED_PRODUCT_TECHNICAL_ID_MISSING'
          : 'PRODUCT_CODE_UNMATCHED',
    companyId: snapshotText(companyId),
    inputProductCode: inputCode,
    matchedProductCode: '',
    matchedProductId: '',
    productMasterRevision: 0,
    referenceSnapshotId: snapshotText(referenceSnapshotId)
  };
}

function resolveProductRow(companyId, row, products, referenceSnapshotId) {
  const next = clone(row || {});
  const resolution = productResolution(companyId, next, products, referenceSnapshotId);
  next.officialProductResolution = resolution;
  next.matchStatus = resolution.status;
  next.productIdentityStatus = resolution.status;
  next.matchSource = resolution.status === OFFICIAL_PRODUCT_RESOLUTION_STATUS.MATCHED
    ? resolution.reason
    : '';
  next.referenceResolution = resolution.reason;
  next.referenceSnapshotId = resolution.referenceSnapshotId;
  next.productMasterRevision = resolution.productMasterRevision;
  if (resolution.status === OFFICIAL_PRODUCT_RESOLUTION_STATUS.MATCHED) {
    next.productId = resolution.matchedProductId;
    next.masterProductId = resolution.matchedProductId;
    next.unresolvedProductId = '';
  } else {
    next.productId = '';
    next.masterProductId = '';
    next.unresolvedProductId = '';
  }
  return next;
}

function partnerInput(kind, group = {}) {
  if (kind === 'PURCHASE') return {
    role: 'SUPPLIER',
    code: snapshotText(group.supplierCustomerCode),
    name: snapshotText(group.supplierCustomerName)
  };
  const billingCode = snapshotText(group.billingCustomerCode);
  return billingCode
    ? { role: 'BILLING', code: billingCode, name: snapshotText(group.billingCustomerName) }
    : {
      role: 'SALES',
      code: snapshotText(group.salesCustomerCode),
      name: snapshotText(group.salesCustomerName)
    };
}

function resolvePartner(kind, companyId, group, customers, referenceSnapshotId) {
  const input = partnerInput(kind, group);
  const matches = scopedExactMatches(
    customers,
    companyId,
    input.code,
    customerCode,
    normalizedCustomerCodeKey,
    activeCustomer
  );
  const matched = matches.length === 1 ? matches[0] : null;
  const matchedCustomerId = snapshotText(matched?.customerId);
  if (matched && matchedCustomerId) {
    return {
      status: OFFICIAL_PARTNER_RESOLUTION_STATUS.MATCHED,
      reason: 'EXACT_COMPANY_CUSTOMER_CODE',
      companyId: snapshotText(companyId),
      partnerRole: input.role,
      inputCustomerCode: input.code,
      inputCustomerName: input.name,
      matchedCustomerCode: customerCode(matched),
      matchedCustomerName: snapshotText(matched.customerName || matched.name),
      matchedCustomerId,
      customerMasterRevision: Number(matched.revision || 0),
      referenceSnapshotId: snapshotText(referenceSnapshotId)
    };
  }
  return {
    status: input.code
      ? OFFICIAL_PARTNER_RESOLUTION_STATUS.UNRESOLVED
      : OFFICIAL_PARTNER_RESOLUTION_STATUS.NOT_PROVIDED,
    reason: !input.code
      ? 'CUSTOMER_CODE_NOT_PROVIDED'
      : matches.length > 1
        ? 'CUSTOMER_CODE_AMBIGUOUS'
        : matched
          ? 'MATCHED_CUSTOMER_ID_MISSING'
          : 'CUSTOMER_CODE_UNMATCHED',
    companyId: snapshotText(companyId),
    partnerRole: input.role,
    inputCustomerCode: input.code,
    inputCustomerName: input.name,
    matchedCustomerCode: '',
    matchedCustomerName: '',
    matchedCustomerId: '',
    customerMasterRevision: 0,
    referenceSnapshotId: snapshotText(referenceSnapshotId)
  };
}

function resolveOfficialVoucherReferencesV2({
  kind,
  companyId,
  group = {},
  products = [],
  customers = [],
  productReferenceSnapshotId = '',
  customerReferenceSnapshotId = ''
} = {}) {
  const normalizedKind = snapshotText(kind).toUpperCase();
  if (!['PURCHASE', 'SALE'].includes(normalizedKind)) throw new Error('SMARTINPUT_OFFICIAL_REFERENCE_KIND_INVALID');
  const company = snapshotText(companyId || group.companyId);
  if (!company) throw new Error('ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  const officialPartnerResolution = resolvePartner(
    normalizedKind,
    company,
    group,
    customers,
    customerReferenceSnapshotId
  );
  const resolved = {
    ...clone(group),
    companyId: company,
    officialPartnerResolution,
    rows: (group.rows || []).map(row => resolveProductRow(company, row, products, productReferenceSnapshotId))
  };
  if (normalizedKind === 'PURCHASE') {
    resolved.supplierCustomerId = officialPartnerResolution.matchedCustomerId;
    resolved.supplierCustomerRevision = officialPartnerResolution.customerMasterRevision;
  } else if (officialPartnerResolution.partnerRole === 'BILLING') {
    resolved.salesCustomerId = '';
    resolved.billingCustomerId = officialPartnerResolution.matchedCustomerId;
    resolved.billingCustomerRevision = officialPartnerResolution.customerMasterRevision;
  } else {
    resolved.salesCustomerId = officialPartnerResolution.matchedCustomerId;
    resolved.salesCustomerRevision = officialPartnerResolution.customerMasterRevision;
    resolved.billingCustomerId = '';
    resolved.billingCustomerRevision = 0;
  }
  return resolved;
}

return { OFFICIAL_PRODUCT_RESOLUTION_STATUS, OFFICIAL_PARTNER_RESOLUTION_STATUS, officialProductCodeKey, normalizedCustomerCodeKey, resolveOfficialVoucherReferencesV2 };
})();

// ============================================================================
// purchase-official-stage3.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const purchaseOfficialStage3Section = (() => {
const { beginPurchaseCommand, commitPurchaseCommand, findPurchaseCommandContext, freezePurchaseCommandIntent, inspectOfficialStocktakeConflicts, loadPurchaseCommandAggregate } = officialCommandAdapterDependency0;
const { canonicalSha256, unresolvedProductStableId } = officialVoucherCoreDependency1;
const { createOfficialDocumentIdentityV2, createOfficialLineIdentityV2, normalizeOfficialBusinessDate, OFFICIAL_VOUCHER_IDENTITY_VERSION_V2, preflightOfficialVoucherV2, withOfficialCommandIdentityV2 } = officialVoucherV2ContractDependency2;
const { createWriteResultTracker, OPTIONAL_OPERATION_TIMEOUT_MS } = optionalOperationLoaderDependency3;

const PURCHASE_STAGE3_CAPABILITY = Object.freeze({
  officialPurchaseStage3: 'V1',
  normalizedOriginVersion: 'PURCHASE_V2',
  commandContract: 'VOUCHER_CORE_V1',
  officialSyncContract: 'ONEAPP_ORDERQ_OFFICIAL_SYNC_V1',
  metaSchema: 'ORDERQ_PURCHASE_META_V2',
  cutoverMode: 'LOCAL_FIRST_BACKGROUND_SYNC',
  localRepositoryReady: 'YES'
});
// Filled only by the immutable Apps Script deployment release commit. Empty
// values intentionally keep production writes disabled.
const PURCHASE_STAGE3_EXPECTED_DEPLOYMENT = Object.freeze({
  deploymentId: 'AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw',
  deploymentVersion: '26',
  gitCommit: 'c84b7962313b5c266e7466045c9623f5c149d50c'
});

// SmartInput currently has no authenticated actor/session provider. Keep the
// established application actor explicit until that shared provider exists.
const SMARTINPUT_PURCHASE_ACTOR_ID = 'SMART_INPUT_ADMIN';

const purchaseWriteResults = createWriteResultTracker();

function text(value) { return String(value ?? '').trim(); }
function copy(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
function finiteRequired(value, code) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) throw new Error(code);
  return Object.is(Number(value), -0) ? 0 : Number(value);
}
function roundWon(value) { return Math.sign(value) * Math.floor(Math.abs(value) + 0.5); }
function masterRevision(row) { return Number(row?.revision ?? row?.masterRevision ?? row?.raw?.revision ?? row?.raw?.masterRevision ?? 0); }
function usesIdentityV2(context = {}) { return text(context.identityVersion) === OFFICIAL_VOUCHER_IDENTITY_VERSION_V2; }

function evaluatePurchaseStage3Capability(ping = PURCHASE_STAGE3_CAPABILITY) {
  const mismatch = Object.entries(PURCHASE_STAGE3_CAPABILITY).find(([key, expected]) => text(ping[key]) !== expected);
  return mismatch
    ? { ready: false, code: 'ORDERQ_PURCHASE_STAGE3_CAPABILITY_UNAVAILABLE', detail: mismatch[0] }
    : { ready: true, code: '', authority: 'LOCAL_FIRST' };
}

async function loadPurchaseStage3Capability() {
  return evaluatePurchaseStage3Capability();
}

function validatePurchaseGroup(group = {}, masters = {}) {
  const supplierId = text(group.supplierCustomerId);
  const supplier = (masters.customers || []).find(row => text(row.customerId) === supplierId);
  if (!supplier || text(supplier.status || 'ACTIVE').toUpperCase() !== 'ACTIVE' || text(supplier.qualityStatus).toUpperCase() === 'SUPERSEDED') {
    throw new Error(`ORDERQ_PURCHASE_SUPPLIER_MASTER_INVALID:${supplierId}`);
  }
  if (!text(group.voucherDate)) throw new Error('ORDERQ_PURCHASE_DATE_REQUIRED');
  const productById = new Map((masters.products || []).map(row => [text(row.productId), row]));
  const warehouseById = new Map((masters.warehouses || []).map(row => [text(row.warehouseId), row]));
  if (!(group.rows || []).length) throw new Error('ORDERQ_OFFICIAL_LINES_REQUIRED');
  for (const row of group.rows) {
    const productId = text(row.productId);
    const unresolvedProductId = text(row.unresolvedProductId);
    const product = productById.get(productId);
    if (!productId && !unresolvedProductId && !text(row.productCode || row.itemCode || row.productName || row.itemName || row.unregisteredProductQuery)) {
      throw new Error('ORDERQ_OFFICIAL_PRODUCT_IDENTITY_REQUIRED');
    }
    if (productId && unresolvedProductId) throw new Error('ORDERQ_OFFICIAL_PRODUCT_IDENTITY_CONFLICT');
    if (productId && (!product || text(product.status || 'ACTIVE').toUpperCase() !== 'ACTIVE' || product.active === false || text(product.productIdentityType).toUpperCase() === 'TEMPORARY')) {
      throw new Error(`ORDERQ_PURCHASE_PRODUCT_MASTER_INVALID:${productId}`);
    }
    if (product && text(row.sourceType).toUpperCase() === 'ORDER_Q') {
      const linkedId = text(row.metaProductId);
      const linkedCode = text(row.metaProductCode).toUpperCase();
      const currentCode = text(product.productCode || row.itemCode || row.productCode).toUpperCase();
      if ((linkedId && linkedId !== text(product.productId)) || (linkedCode && linkedCode !== currentCode)) {
        throw new Error(`ORDERQ_PURCHASE_PRODUCT_LINK_MISMATCH:${text(row.sourceLineKey)}`);
      }
    }
    const warehouseId = text(row.warehouseId || group.warehouseId);
    const warehouse = warehouseById.get(warehouseId);
    if (!warehouse || text(warehouse.status || 'ACTIVE').toUpperCase() !== 'ACTIVE' || warehouse.active === false) {
      throw new Error(`ORDERQ_PURCHASE_WAREHOUSE_MASTER_INVALID:${warehouseId}`);
    }
    const productRevision = Number(row.productMasterRevision || 0);
    const warehouseRevision = Number(row.warehouseMasterRevision || 0);
    if ((product && (!Number.isSafeInteger(productRevision) || productRevision <= 0 || productRevision < masterRevision(product)))
      || !Number.isSafeInteger(warehouseRevision) || warehouseRevision <= 0 || warehouseRevision < masterRevision(warehouse)) {
      throw new Error(`ORDERQ_PURCHASE_MASTER_REVISION_STALE:${text(row.sourceLineKey)}`);
    }
    finiteRequired(row.actualQuantity ?? row.quantity, 'ORDERQ_PURCHASE_QUANTITY_REQUIRED');
    finiteRequired(row.unitPrice, 'ORDERQ_PURCHASE_UNIT_PRICE_REQUIRED');
    if (!text(row.unit)) throw new Error('ORDERQ_PURCHASE_UNIT_REQUIRED');
    if (row.metaStatus === 'MUTATED' || row.unitConversionStatus === 'REVIEW_REQUIRED') throw new Error('ORDERQ_PURCHASE_META_REVIEW_REQUIRED');
  }
  return true;
}

function derivePurchaseDraftIdentity(group = {}, context = {}) {
  const identityV2 = usesIdentityV2(context);
  const sourceType = text(group.sourceType || group.rows?.[0]?.sourceType || 'DIRECT').toUpperCase();
  const originSystem = text(group.originSystem || group.rows?.[0]?.originSystem || context.originSystem || 'SMARTINPUT_MANUAL').toUpperCase();
  const originTransactionId = text(group.originTransactionId || group.rows?.[0]?.originTransactionId || context.manualSessionId);
  const externalDocumentNo = text(group.externalVoucherNo);
  const sourceVoucherIndex = Number(group.sourceVoucherIndex || group.rows?.[0]?.sourceVoucherIndex || 1);
  const sourceRunKey = text(group.sourceRunKey || group.rows?.[0]?.sourceRunKey)
    || `RUN:${originSystem}:${originTransactionId}`;
  const roleSupplierKey = text(group.supplierCustomerId || group.supplierCustomerCode)
    || `NAME:${text(group.supplierCustomerName).normalize('NFKC').toLowerCase().replace(/\s+/g, '')}`;
  const documentSuffix = externalDocumentNo ? `NO:${externalDocumentNo}` : `VOUCHER:${sourceVoucherIndex}`;
  const purchaseDate = identityV2 ? normalizeOfficialBusinessDate(group).businessDate : text(group.voucherDate);
  const sourceDocumentKey = sourceType === 'ORDER_Q'
    ? text(group.sourceDocumentKey || group.rows?.[0]?.sourceDocumentKey)
    : `PURCHASE:${canonicalSha256({ contractKind: 'PURCHASE_STAGE3_V1', sourceRunKey, documentSuffix, roleSupplierKey, purchaseDate, externalDocumentNo })}`;
  if (!sourceDocumentKey) throw new Error('ORDERQ_OFFICIAL_SOURCE_DOCUMENT_KEY_REQUIRED');
  const voucherGroupKey = text(group.voucherGroupKey);
  const v2Identity = identityV2 ? createOfficialDocumentIdentityV2({
    kind: 'PURCHASE',
    companyId: text(context.companyId || group.companyId),
    voucherGroupKey,
    stableInput: {
      sourceType,
      sourceDocumentKey,
      originSystem,
      originTransactionId,
      externalDocumentNo,
      sourceVoucherIndex
    }
  }) : null;
  const purchaseDocumentId = v2Identity?.purchaseDocumentId
    || `PD-${canonicalSha256(['VOUCHER_CORE_V1', sourceType, sourceDocumentKey]).slice(0, 32)}`;
  return { sourceType, originSystem, originTransactionId, externalDocumentNo, sourceVoucherIndex,
    sourceRunKey, roleSupplierKey, documentSuffix, sourceDocumentKey, purchaseDocumentId,
    ...(identityV2 ? { purchaseDate, voucherGroupKey, ...v2Identity } : {}),
    contractKind: 'PURCHASE_STAGE3_V1', purchasePlanId: text(group.purchasePlanId || group.rows?.[0]?.purchasePlanId),
    sourceShortageKey: text(group.sourceShortageKey || group.rows?.[0]?.sourceShortageKey) };
}

function buildPurchasePostDraft(group = {}, context = {}) {
  const identityV2 = usesIdentityV2(context);
  const identity = derivePurchaseDraftIdentity(group, context);
  const { sourceType, originSystem, originTransactionId, externalDocumentNo, sourceVoucherIndex,
    sourceRunKey, documentSuffix, sourceDocumentKey, purchaseDocumentId } = identity;
  const occurredAt = text(context.occurredAt || new Date().toISOString());
  const companyId = text(context.companyId || group.companyId);
  if (!companyId) throw new Error('ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  const preflight = identityV2 ? preflightOfficialVoucherV2({
    ...group,
    kind: 'PURCHASE',
    companyId,
    voucherGroupKey: identity.voucherGroupKey,
    warehouseId: group.warehouseId,
    rows: group.rows
  }) : null;
  const sourceRows = preflight?.rows || group.rows || [];
  const lines = sourceRows.map((row, index) => {
    const actualQuantity = finiteRequired(row.actualQuantity ?? row.quantity, 'ORDERQ_PURCHASE_QUANTITY_REQUIRED');
    const unitPrice = finiteRequired(row.unitPrice, 'ORDERQ_PURCHASE_UNIT_PRICE_REQUIRED');
    const conversionFactor = identityV2
      ? 1
      : finiteRequired(row.conversionFactor ?? 1, 'ORDERQ_PURCHASE_CONVERSION_REQUIRED');
    const sourceRowKey = canonicalSha256({ sourceSheetName: text(row.sourceSheetName), sourceRowNo: Number(row.sourceRowNo || index + 1), sourceVoucherIndex });
    const sourceLineKey = sourceType === 'ORDER_Q' && text(row.sourceLineKey)
      ? text(row.sourceLineKey)
      : identityV2
        ? (text(row.sourceLineKey || row.rowId || row.sourceRowKey || row.sourceFingerprint)
          ? `${sourceDocumentKey}:LINE:${text(row.sourceLineKey || row.rowId || row.sourceRowKey || row.sourceFingerprint)}`
          : `${sourceDocumentKey}:LINE:${canonicalSha256({ sourceRowKey, productIdentity: text(row.productId || row.itemCode), warehouseIdentity: text(row.warehouseId || group.warehouseId || row.warehouseCode || group.warehouseCode), sourceOccurrence: Number(row.sourceOccurrence || index + 1), productSnapshot: row.productSnapshot })}`)
        : `${sourceDocumentKey}:LINE:${canonicalSha256({ sourceRowKey, productIdentity: text(row.productId || row.itemCode), warehouseIdentity: text(row.warehouseId || group.warehouseId || row.warehouseCode || group.warehouseCode), sourceOccurrence: index + 1 })}`;
    const calculatedSupplyAmount = roundWon(actualQuantity * unitPrice);
    const supplyAmount = row.supplyAmount ?? row.supplyAmountWon ?? calculatedSupplyAmount;
    const vatAmount = row.vatAmount ?? row.vatAmountWon ?? null;
    const totalAmount = row.totalAmount ?? row.totalAmountWon ?? row.amountWon ?? supplyAmount;
    const officialProductResolution = identityV2 ? row.officialProductResolution : null;
    if (identityV2 && !officialProductResolution) throw new Error('ORDERQ_OFFICIAL_V2_PRODUCT_RESOLUTION_REQUIRED');
    const productId = identityV2
      ? (text(officialProductResolution.status) === 'MATCHED' ? text(officialProductResolution.matchedProductId) : '')
      : text(row.productId);
    const unresolvedProductId = text(row.unresolvedProductId)
      || (!productId ? unresolvedProductStableId(companyId, row) : '');
    const productSnapshot = identityV2 ? {
      ...row.productSnapshot,
      matchEvidence: {
        ...row.productSnapshot.matchEvidence,
        status: text(row.matchStatus || row.productIdentityStatus || (productId ? 'MATCHED' : 'UNRESOLVED_PRODUCT')).toUpperCase(),
        source: text(row.matchSource || row.referenceResolution),
        productId,
        unresolvedProductId,
        productMasterRevision: Number(row.productMasterRevision || 0),
        referenceSnapshotId: text(row.referenceSnapshotId || row.productSnapshotId),
        officialProductResolution
      }
    } : null;
    const lineIdentity = identityV2 ? createOfficialLineIdentityV2({
      kind: 'PURCHASE', companyId, documentId: purchaseDocumentId,
      voucherGroupKey: identity.voucherGroupKey, sourceLineKey
    }) : null;
    const purchaseLineId = lineIdentity?.purchaseLineId
      || text(row.purchaseLineId) || `PL-${canonicalSha256([purchaseDocumentId, sourceLineKey]).slice(0, 32)}`;
    return {
      ...(identityV2 ? { ...lineIdentity, purchaseDocumentId, companyId, voucherGroupKey: identity.voucherGroupKey } : {}),
      purchaseLineId,
      sourceLineKey,
      lineIdentityId: identityV2 ? purchaseLineId : `LI-${canonicalSha256([purchaseDocumentId, sourceLineKey]).slice(0, 32)}`,
      lineSequence: index + 1,
      productId, unresolvedProductId,
      productCode: identityV2 ? productSnapshot.productCode : text(row.itemCode || row.productCode),
      productName: identityV2 ? productSnapshot.productName : text(row.itemName || row.productName),
      ...(identityV2 ? {
        originalProductCode: productSnapshot.originalProductCode,
        originalProductName: productSnapshot.originalProductName,
        matchStatus: text(row.matchStatus || row.productIdentityStatus || (productId ? 'MATCHED' : 'UNRESOLVED_PRODUCT')).toUpperCase(),
        matchSource: text(row.matchSource || row.referenceResolution),
        referenceSnapshotId: text(row.referenceSnapshotId || row.productSnapshotId),
        officialProductResolution,
        inventoryEffectFactor: 1,
        productSnapshot
      } : {}),
      specification: text(row.specification), warehouseId: text(row.warehouseId || group.warehouseId),
      warehouseCode: text(row.warehouseCode || group.warehouseCode), actualQuantity,
      unit: identityV2 ? productSnapshot.unit : text(row.unit).toUpperCase(),
      suggestedQuantity: row.suggestedQuantity === null || row.suggestedQuantity === undefined ? null : Number(row.suggestedQuantity),
      suggestedBaseQuantity: row.suggestedBaseQuantity === null || row.suggestedBaseQuantity === undefined ? null : Number(row.suggestedBaseQuantity),
      conversionFactor, baseQuantity: identityV2
        ? actualQuantity
        : finiteRequired(row.baseQuantity ?? actualQuantity * conversionFactor, 'ORDERQ_PURCHASE_BASE_QUANTITY_REQUIRED'),
      baseUnit: text(row.baseUnit || row.unit).toUpperCase(), unitPrice, supplyAmount, vatAmount,
      totalAmount: identityV2 ? productSnapshot.amount : totalAmount,
      taxType: 'VAT_INCLUDED_IN_SUPPLY', currency: 'KRW', productMasterRevision: Number(row.productMasterRevision || 0),
      warehouseMasterRevision: Number(row.warehouseMasterRevision || 0)
    };
  });
  const commandSeed = canonicalSha256({ purchaseDocumentId, sourceDocumentKey, originSystem, originTransactionId, lines: lines.map(row => row.sourceLineKey) });
  const commandId = `POST_PURCHASE:${commandSeed}`;
  const document = {
    companyId, purchaseDocumentId, supplierCustomerId: text(group.supplierCustomerId), supplierCustomerCode: text(group.supplierCustomerCode),
    supplierCustomerName: text(group.supplierCustomerName),
    ...(identityV2 ? { supplierCustomerRevision: Number(group.supplierCustomerRevision || 0) } : {}),
    purchaseDate: identityV2 ? preflight.businessDate : text(group.voucherDate),
    warehouseId: text(group.warehouseId), warehouseCode: text(group.warehouseCode), warehouseName: text(group.warehouseName || group.warehouseCode),
    taxType: 'VAT_INCLUDED_IN_SUPPLY', currency: 'KRW', sourceType, contractKind: 'PURCHASE_STAGE3_V1', sourceDocumentKey,
    normalizedOriginVersion: 'PURCHASE_V2', originSystem, originTransactionId, externalDocumentNo,
    purchasePlanId: text(group.purchasePlanId || group.rows?.[0]?.purchasePlanId),
    sourceShortageKey: text(group.sourceShortageKey || group.rows?.[0]?.sourceShortageKey), sourceRunKey, sourceVoucherIndex, documentSuffix,
    ...(identityV2 ? {
      voucherGroupKey: identity.voucherGroupKey,
      schemaVersion: identity.schemaVersion,
      identityVersion: identity.identityVersion,
      entityType: identity.entityType,
      identitySeed: identity.identitySeed,
      businessDate: preflight.businessDate,
      businessDateDayDefaulted: preflight.dayDefaulted,
      ...(text(group.businessOccurredAt) ? { businessOccurredAt: text(group.businessOccurredAt) } : {}),
      officialPartnerResolution: group.officialPartnerResolution
    } : {})
  };
  const commandBase = {
    commandType: 'POST_PURCHASE', aggregateId: purchaseDocumentId, expectedRevision: 1, commandId, idempotencyKey: commandId,
    actor: text(context.actor || SMARTINPUT_PURCHASE_ACTOR_ID), actorId: text(context.actor || SMARTINPUT_PURCHASE_ACTOR_ID), reason: 'PURCHASE_POST', occurredAt,
    commandContract: 'VOUCHER_CORE_V1', ...document, document, lines,
    ...(identityV2 && Array.isArray(context.stocktakeDecisions) && context.stocktakeDecisions.length
      ? { stocktakeDecisions: copy(context.stocktakeDecisions) }
      : {})
  };
  const commandSource = identityV2 ? withOfficialCommandIdentityV2(commandBase) : commandBase;
  return { ...document, ...freezePurchaseCommandIntent(commandSource), lines, commandSource };
}

function resolvePersistedPurchaseRetry(group = {}, context = {}, aggregate = null) {
  const storedEnvelope = aggregate?.document?.commandEnvelope || null;
  const draft = buildPurchasePostDraft(group, storedEnvelope
    ? {
      ...context,
      actor: storedEnvelope.actorId,
      occurredAt: storedEnvelope.occurredAt,
      stocktakeDecisions: storedEnvelope.stocktakeDecisions
    }
    : context);
  if (aggregate && storedEnvelope
    && text(aggregate.document.draftIntentDigest) !== text(draft.draftIntentDigest)) {
    throw new Error('ORDERQ_PURCHASE_DRAFT_IDENTITY_CONFLICT');
  }
  return { draft, envelope: storedEnvelope || draft.commandEnvelope };
}

async function inspectPurchaseGroupStocktake(group = {}, context = {}) {
  const draft = buildPurchasePostDraft(group, context);
  return inspectOfficialStocktakeConflicts({ kind: 'PURCHASE', ...draft });
}

function purchaseCommandReceipt(aggregate, commandId) {
  return (aggregate?.commands || []).find(receipt => text(receipt.commandId) === text(commandId)
    && text(receipt.status).toUpperCase() === 'COMMITTED') || null;
}

async function lookupPurchaseCommandResult(purchaseDocumentId, commandId) {
  let timer = null;
  try {
    const aggregate = await Promise.race([
      loadPurchaseCommandAggregate(purchaseDocumentId),
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(() => reject(new Error('구매 저장 결과 조회 시간이 초과되었습니다.')), OPTIONAL_OPERATION_TIMEOUT_MS.capability);
      })
    ]);
    const receipt = purchaseCommandReceipt(aggregate, commandId);
    return receipt
      ? { known: true, result: receipt.result }
      : { known: false, safeToRetry: true };
  } finally {
    if (timer !== null) globalThis.clearTimeout(timer);
  }
}

async function postPurchaseGroup(group, context = {}) {
  const source = derivePurchaseDraftIdentity(group, context);
  const identity = {
    companyId: text(context.companyId || group.companyId), contractKind: source.contractKind, sourceDocumentKey: source.sourceDocumentKey,
    originSystem: source.originSystem, originTransactionId: source.originTransactionId,
    purchasePlanId: source.purchasePlanId, externalDocumentNo: source.externalDocumentNo,
    sourceVoucherIndex: source.sourceVoucherIndex,
    ...(source.identityVersion ? { identityVersion: source.identityVersion, voucherGroupKey: source.voucherGroupKey } : {})
  };
  const commandContext = await findPurchaseCommandContext(identity);
  const existing = commandContext.document;
  if (existing && text(existing.purchaseDocumentId) !== text(source.purchaseDocumentId)) throw new Error(`ORDERQ_PURCHASE_ORIGIN_DUPLICATE:${source.sourceDocumentKey}`);
  let aggregate = commandContext.aggregate;
  const retry = resolvePersistedPurchaseRetry(group, context, aggregate);
  const draft = retry.draft;
  if (!aggregate) {
    try { aggregate = await beginPurchaseCommand(draft, context.actor || SMARTINPUT_PURCHASE_ACTOR_ID); }
    catch (error) {
      if (!text(error?.message).startsWith('ORDERQ_OFFICIAL_DRAFT_EXISTS:')) throw error;
      aggregate = await loadPurchaseCommandAggregate(draft.purchaseDocumentId);
      if (!aggregate || text(aggregate.document.draftIntentDigest) !== text(draft.draftIntentDigest)) throw new Error('ORDERQ_PURCHASE_DRAFT_IDENTITY_CONFLICT');
    }
  }
  // Retrying a lost response must resend the byte-identical persisted command;
  // wall-clock time and current UI state can never replace this envelope.
  const envelope = aggregate.document?.commandEnvelope || retry.envelope;
  const command = {
    ...envelope,
    intent: envelope,
    actor: envelope.actorId,
    purchaseDocumentId: draft.purchaseDocumentId,
    document: envelope.document,
    lines: envelope.lines,
    sourceType: envelope.sourceType,
    commandContract: 'VOUCHER_CORE_V1'
  };
  const resolved = await purchaseWriteResults.resolveUnknown({
    feature: 'purchase-official-command',
    commandId: envelope.commandId,
    lookup: () => lookupPurchaseCommandResult(draft.purchaseDocumentId, envelope.commandId)
  });
  const result = resolved === undefined
    ? await purchaseWriteResults.submit({
      feature: 'purchase-official-command',
      commandId: envelope.commandId,
      timeoutMs: OPTIONAL_OPERATION_TIMEOUT_MS.capability,
      execute: () => commitPurchaseCommand(command)
    })
    : resolved;
  return { ...result, purchaseDocumentId: draft.purchaseDocumentId, commandId: envelope.commandId };
}

return { PURCHASE_STAGE3_CAPABILITY, PURCHASE_STAGE3_EXPECTED_DEPLOYMENT, SMARTINPUT_PURCHASE_ACTOR_ID, evaluatePurchaseStage3Capability, loadPurchaseStage3Capability, validatePurchaseGroup, derivePurchaseDraftIdentity, buildPurchasePostDraft, resolvePersistedPurchaseRetry, inspectPurchaseGroupStocktake, postPurchaseGroup };
})();

// ============================================================================
// sale-official-stage4.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const saleOfficialStage4Section = (() => {
const { beginSaleCommand, commitSaleCommand, findSaleCommandContext, freezeSaleCommandIntent, inspectOfficialStocktakeConflicts, loadSaleCommandAggregate } = officialCommandAdapterDependency0;
const { canonicalSha256, unresolvedProductStableId } = officialVoucherCoreDependency1;
const { createOfficialDocumentIdentityV2, createOfficialLineIdentityV2, normalizeOfficialBusinessDate, OFFICIAL_VOUCHER_IDENTITY_VERSION_V2, preflightOfficialVoucherV2, withOfficialCommandIdentityV2 } = officialVoucherV2ContractDependency2;
const { createWriteResultTracker, OPTIONAL_OPERATION_TIMEOUT_MS } = optionalOperationLoaderDependency3;

const SALE_STAGE4_CAPABILITY = Object.freeze({
  officialPurchaseStage3: 'V1', officialSaleStage4: 'V1', normalizedSaleOriginVersion: 'SALE_V2',
  commandContract: 'VOUCHER_CORE_V1', officialSyncContract: 'ONEAPP_ORDERQ_OFFICIAL_SYNC_V1',
  salesMetaSchema: 'ORDERQ_SALES_META_V1', dbSchemaVersion: '7',
  cutoverMode: 'LOCAL_FIRST_BACKGROUND_SYNC', localRepositoryReady: 'YES'
});
// Cloud-first immutable deployment evidence required before production sale writes.
const SALE_STAGE4_EXPECTED_DEPLOYMENT = Object.freeze({
  deploymentId: 'AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw',
  deploymentVersion: '27',
  gitCommit: 'ae120131a3890438ef5fadfa14f3c3905f872e69'
});
const SMARTINPUT_SALE_ACTOR_ID = 'SMART_INPUT_ADMIN';

const saleWriteResults = createWriteResultTracker();

const text = value => String(value ?? '').trim();
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function finite(value, code) {
  if (value === '' || value === null || value === undefined || !Number.isFinite(Number(value))) throw new Error(code);
  return Object.is(Number(value), -0) ? 0 : Number(value);
}
function won(value) { return Math.sign(value) * Math.floor(Math.abs(value) + 0.5); }
function revision(value) { return Number(value?.revision ?? value?.masterRevision ?? value?.raw?.revision ?? 0); }
function usesIdentityV2(context = {}) { return text(context.identityVersion) === OFFICIAL_VOUCHER_IDENTITY_VERSION_V2; }

function evaluateSaleStage4Capability(ping = SALE_STAGE4_CAPABILITY) {
  const mismatch = Object.entries(SALE_STAGE4_CAPABILITY).find(([key, expectedValue]) => text(ping[key]) !== expectedValue);
  return mismatch
    ? { ready: false, code: 'ORDERQ_SALE_STAGE4_CAPABILITY_UNAVAILABLE', detail: mismatch[0] }
    : { ready: true, code: '', authority: 'LOCAL_FIRST' };
}

async function loadSaleStage4Capability() {
  return evaluateSaleStage4Capability();
}

function validateSaleGroup(group = {}, masters = {}) {
  const customers = new Map((masters.customers || []).map(row => [text(row.customerId), row]));
  ['salesCustomerId', 'deliveryCustomerId', 'billingCustomerId'].forEach(field => {
    const id = text(group[field]); const customer = customers.get(id);
    if (!customer || text(customer.status || 'ACTIVE').toUpperCase() !== 'ACTIVE' || text(customer.qualityStatus).toUpperCase() === 'SUPERSEDED') {
      throw new Error(`ORDERQ_SALE_CUSTOMER_MASTER_INVALID:${id}`);
    }
    if (!(Number(group[field.replace('Id', 'Revision')]) >= revision(customer))) throw new Error('ORDERQ_SALE_SOURCE_REVISION_STALE');
  });
  if (!text(group.voucherDate || group.saleDate)) throw new Error('ORDERQ_SALE_DATE_REQUIRED');
  const products = new Map((masters.products || []).map(row => [text(row.productId), row]));
  const warehouses = new Map((masters.warehouses || []).map(row => [text(row.warehouseId), row]));
  const orders = new Map((masters.orders || []).map(row => [text(row.orderId), row]));
  const orderItems = new Map((masters.orderItems || []).map(row => [text(row.orderItemId), row]));
  for (const row of group.rows || []) {
    const productId = text(row.productId);
    const unresolvedProductId = text(row.unresolvedProductId);
    const product = products.get(productId);
    const warehouse = warehouses.get(text(row.warehouseId || group.warehouseId));
    if (!productId && !unresolvedProductId && !text(row.productCode || row.itemCode || row.productName || row.itemName || row.unregisteredProductQuery)) {
      throw new Error('ORDERQ_OFFICIAL_PRODUCT_IDENTITY_REQUIRED');
    }
    if (productId && unresolvedProductId) throw new Error('ORDERQ_OFFICIAL_PRODUCT_IDENTITY_CONFLICT');
    if (productId && (!product || product.active === false || text(product.status || 'ACTIVE').toUpperCase() !== 'ACTIVE')) throw new Error('ORDERQ_SALE_PRODUCT_MASTER_INVALID');
    if (!warehouse || warehouse.active === false || text(warehouse.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') throw new Error('ORDERQ_SALE_WAREHOUSE_MASTER_INVALID');
    if ((product && !(Number(row.productMasterRevision) >= revision(product))) || !(Number(row.warehouseMasterRevision) >= revision(warehouse))) throw new Error('ORDERQ_SALE_SOURCE_REVISION_STALE');
    const actual = finite(row.actualQuantity ?? row.quantity, 'ORDERQ_SALE_QUANTITY_REQUIRED');
    finite(row.unitPrice, 'ORDERQ_SALE_UNIT_PRICE_REQUIRED');
    const baseFactor = finite(row.actualToBaseFactor, 'ORDERQ_SALE_CONVERSION_REQUIRED');
    const mode = text(row.orderLinkMode || group.orderLinkMode || 'DIRECT').toUpperCase();
    const recognizedFactor = mode === 'DIRECT' ? 0 : finite(row.actualToRecognizedFactor, 'ORDERQ_SALE_CONVERSION_REQUIRED');
    if (!(baseFactor > 0) || (mode !== 'DIRECT' && !(recognizedFactor > 0))) throw new Error('ORDERQ_SALE_CONVERSION_REQUIRED');
    if (mode === 'DIRECT') {
      if (text(row.sourceOrderId || row.sourceOrderItemId || row.sourceDispatchId || row.sourceDispatchLineId) || actual * recognizedFactor !== 0) {
        throw new Error('ORDERQ_SALE_DIRECT_ORDER_LINK_FORBIDDEN');
      }
      const actualUnit = text(row.actualUnit || row.unit).toUpperCase();
      if (baseFactor !== 1 || text(row.baseUnit || actualUnit).toUpperCase() !== actualUnit
        || text(row.conversionSource).toUpperCase() !== 'DIRECT_SAME_UNIT'
        || !text(row.conversionRuleVersion)) throw new Error('ORDERQ_SALE_DIRECT_CONVERSION_PROVENANCE_REQUIRED');
    } else {
      const order = orders.get(text(row.sourceOrderId)); const item = orderItems.get(text(row.sourceOrderItemId));
      if (!order || !item || text(item.orderId) !== text(order.orderId) || text(item.productId || item.productCode) !== text(row.productId || row.productCode)) {
        throw new Error('ORDERQ_SALE_ORDER_LINK_INVALID');
      }
      if (text(order.customerId) !== text(group.deliveryCustomerId)) throw new Error('ORDERQ_SALE_DELIVERY_ORDER_CUSTOMER_MISMATCH');
      if (Number(row.sourceOrderRevision) !== revision(order) || Number(row.sourceOrderItemRevision) !== revision(item)) throw new Error('ORDERQ_SALE_SOURCE_REVISION_STALE');
      if (!!text(row.sourceDispatchId) !== !!text(row.sourceDispatchLineId)) throw new Error('ORDERQ_SALE_DISPATCH_LINK_INVALID');
    }
  }
  return true;
}

function deriveSaleDraftIdentity(group = {}, context = {}) {
  const identityV2 = usesIdentityV2(context);
  const sourceType = text(group.sourceType || group.rows?.[0]?.sourceType || 'DIRECT').toUpperCase();
  const originSystem = text(group.originSystem || group.rows?.[0]?.originSystem || context.originSystem).toUpperCase();
  const originTransactionId = text(group.originTransactionId || group.rows?.[0]?.originTransactionId || context.manualSessionId);
  const sourceVoucherIndex = Number(group.sourceVoucherIndex || group.rows?.[0]?.sourceVoucherIndex || 1);
  if (!originSystem || !originTransactionId || !Number.isInteger(sourceVoucherIndex) || sourceVoucherIndex < 1) throw new Error('ORDERQ_SALE_ORIGIN_IDENTITY_REQUIRED');
  const saleDate = identityV2 ? normalizeOfficialBusinessDate(group).businessDate : text(group.voucherDate || group.saleDate);
  const sourceDocumentKey = text(group.sourceDocumentKey || group.rows?.[0]?.sourceDocumentKey)
    || `SALE:${canonicalSha256({ contractKind: 'SALE_STAGE4_V1', originSystem, originTransactionId, sourceVoucherIndex,
      billingCustomerId: text(group.billingCustomerId), saleDate, externalDocumentNo: text(group.externalVoucherNo) })}`;
  const voucherGroupKey = text(group.voucherGroupKey);
  const v2Identity = identityV2 ? createOfficialDocumentIdentityV2({
    kind: 'SALE',
    companyId: text(context.companyId || group.companyId),
    voucherGroupKey,
    stableInput: {
      sourceType,
      sourceDocumentKey,
      originSystem,
      originTransactionId,
      externalDocumentNo: text(group.externalVoucherNo),
      sourceVoucherIndex
    }
  }) : null;
  const salesDocumentId = v2Identity?.salesDocumentId
    || `SD-${canonicalSha256(['VOUCHER_CORE_V1', sourceType, sourceDocumentKey]).slice(0, 32)}`;
  return { sourceType, originSystem, originTransactionId, sourceVoucherIndex, sourceDocumentKey,
    externalDocumentNo: text(group.externalVoucherNo), salesDocumentId,
    ...(identityV2 ? { saleDate, voucherGroupKey, ...v2Identity } : {}), contractKind: 'SALE_STAGE4_V1' };
}

function buildSalePostDraft(group = {}, context = {}) {
  const identityV2 = usesIdentityV2(context);
  const identity = deriveSaleDraftIdentity(group, context);
  const occurredAt = text(context.occurredAt || new Date().toISOString());
  const companyId = text(context.companyId || group.companyId);
  if (!companyId) throw new Error('ORDERQ_OFFICIAL_COMPANY_REQUIRED');
  const preflight = identityV2 ? preflightOfficialVoucherV2({
    ...group,
    kind: 'SALE',
    companyId,
    voucherGroupKey: identity.voucherGroupKey,
    warehouseId: group.warehouseId,
    rows: group.rows
  }) : null;
  const sourceRows = preflight?.rows || group.rows || [];
  const lines = sourceRows.map((row, index) => {
    const actualQuantity = finite(row.actualQuantity ?? row.quantity, 'ORDERQ_SALE_QUANTITY_REQUIRED');
    const unitPrice = finite(row.unitPrice, 'ORDERQ_SALE_UNIT_PRICE_REQUIRED');
    const orderLinkMode = text(row.orderLinkMode || group.orderLinkMode || 'DIRECT').toUpperCase();
    const direct = orderLinkMode === 'DIRECT';
    const actualToBaseFactor = identityV2
      ? 1
      : finite(row.actualToBaseFactor ?? (direct ? 1 : undefined), 'ORDERQ_SALE_CONVERSION_REQUIRED');
    const actualToRecognizedFactor = orderLinkMode === 'DIRECT' ? 0 : finite(row.actualToRecognizedFactor, 'ORDERQ_SALE_CONVERSION_REQUIRED');
    const actualUnit = text(row.actualUnit || row.unit).toUpperCase();
    const conversionSource = text(row.conversionSource || (direct ? 'DIRECT_SAME_UNIT' : '')).toUpperCase();
    const conversionRuleId = text(row.conversionRuleId || (direct ? 'DIRECT_1_TO_1' : ''));
    const conversionRuleVersion = text(row.conversionRuleVersion || (direct ? 'DIRECT_1_TO_1_V1' : ''));
    if (!identityV2 && direct && (actualToBaseFactor !== 1 || text(row.baseUnit || actualUnit).toUpperCase() !== actualUnit
      || conversionSource !== 'DIRECT_SAME_UNIT' || !conversionRuleVersion)) {
      throw new Error('ORDERQ_SALE_DIRECT_CONVERSION_PROVENANCE_REQUIRED');
    }
    const stableRowKey = text(row.sourceLineKey || row.rowId || row.sourceRowKey || row.sourceFingerprint);
    const sourceLineKey = identityV2
      ? (stableRowKey
        ? `${identity.sourceDocumentKey}:LINE:${stableRowKey}`
        : `${identity.sourceDocumentKey}:LINE:${canonicalSha256({ sourceRowKey: text(row.sourceRowKey || row.sourceRowNo || index + 1),
          sourceOccurrence: Number(row.sourceOccurrence || 1), productId: text(row.productId || row.productCode), warehouseId: text(row.warehouseId || group.warehouseId),
          sourceOrderId: text(row.sourceOrderId), sourceOrderItemId: text(row.sourceOrderItemId), sourceDispatchId: text(row.sourceDispatchId), sourceDispatchLineId: text(row.sourceDispatchLineId),
          productSnapshot: row.productSnapshot })}`)
      : text(row.sourceLineKey) || `${identity.sourceDocumentKey}:LINE:${canonicalSha256({ sourceRowKey: text(row.sourceRowKey || index + 1),
        sourceOccurrence: Number(row.sourceOccurrence || 1), productId: text(row.productId || row.productCode), warehouseId: text(row.warehouseId || group.warehouseId),
        sourceOrderId: text(row.sourceOrderId), sourceOrderItemId: text(row.sourceOrderItemId), sourceDispatchId: text(row.sourceDispatchId), sourceDispatchLineId: text(row.sourceDispatchLineId) })}`;
    const calculatedSupplyAmount = won(actualQuantity * unitPrice);
    const supplyAmount = row.supplyAmount ?? row.supplyAmountWon ?? calculatedSupplyAmount;
    const vatAmount = row.vatAmount ?? row.vatAmountWon ?? null;
    const totalAmount = row.totalAmount ?? row.totalAmountWon ?? row.amountWon ?? supplyAmount;
    const officialProductResolution = identityV2 ? row.officialProductResolution : null;
    if (identityV2 && !officialProductResolution) throw new Error('ORDERQ_OFFICIAL_V2_PRODUCT_RESOLUTION_REQUIRED');
    const productId = identityV2
      ? (text(officialProductResolution.status) === 'MATCHED' ? text(officialProductResolution.matchedProductId) : '')
      : text(row.productId);
    const unresolvedProductId = text(row.unresolvedProductId)
      || (!productId ? unresolvedProductStableId(companyId, row) : '');
    const productSnapshot = identityV2 ? {
      ...row.productSnapshot,
      matchEvidence: {
        ...row.productSnapshot.matchEvidence,
        status: text(row.matchStatus || row.productIdentityStatus || (productId ? 'MATCHED' : 'UNRESOLVED_PRODUCT')).toUpperCase(),
        source: text(row.matchSource || row.referenceResolution),
        productId,
        unresolvedProductId,
        productMasterRevision: Number(row.productMasterRevision || 0),
        referenceSnapshotId: text(row.referenceSnapshotId || row.productSnapshotId),
        officialProductResolution
      }
    } : null;
    const lineIdentity = identityV2 ? createOfficialLineIdentityV2({
      kind: 'SALE', companyId, documentId: identity.salesDocumentId,
      voucherGroupKey: identity.voucherGroupKey, sourceLineKey
    }) : null;
    const salesLineId = lineIdentity?.salesLineId
      || text(row.salesLineId) || `SL-${canonicalSha256([identity.salesDocumentId, sourceLineKey]).slice(0, 32)}`;
    return { ...row, ...(identityV2 ? { ...lineIdentity, salesDocumentId: identity.salesDocumentId,
      companyId, voucherGroupKey: identity.voucherGroupKey } : {}), salesLineId,
      sourceLineKey, lineIdentityId: identityV2 ? salesLineId : text(row.lineIdentityId) || `LI-${canonicalSha256([identity.salesDocumentId, sourceLineKey]).slice(0, 32)}`,
      lineSequence: index + 1, actualQuantity, actualUnit,
      ...(identityV2 ? { unit: productSnapshot.unit } : {}),
      actualToBaseFactor,
      baseQuantity: identityV2 ? actualQuantity : actualQuantity * actualToBaseFactor,
      baseUnit: text(row.baseUnit || row.unit).toUpperCase(),
      actualToRecognizedFactor, recognizedOrderQuantity: orderLinkMode === 'DIRECT' ? 0 : actualQuantity * actualToRecognizedFactor,
      recognizedUnit: text(row.recognizedUnit || row.unit).toUpperCase(), unitPrice,
      productId, unresolvedProductId,
      ...(identityV2 ? {
        productCode: productSnapshot.productCode,
        productName: productSnapshot.productName,
        originalProductCode: productSnapshot.originalProductCode,
        originalProductName: productSnapshot.originalProductName,
        matchStatus: text(row.matchStatus || row.productIdentityStatus || (productId ? 'MATCHED' : 'UNRESOLVED_PRODUCT')).toUpperCase(),
        matchSource: text(row.matchSource || row.referenceResolution),
        officialProductResolution,
        inventoryEffectFactor: 1,
        productSnapshot
      } : {}),
      supplyAmount, vatAmount, totalAmount: identityV2 ? productSnapshot.amount : totalAmount,
      taxType: 'VAT_INCLUDED_IN_SUPPLY', currency: 'KRW', orderLinkMode, conversionSource, conversionRuleId, conversionRuleVersion };
  });
  const commandId = `POST_SALE:${canonicalSha256({ salesDocumentId: identity.salesDocumentId, sourceDocumentKey: identity.sourceDocumentKey, lines: lines.map(row => row.sourceLineKey) })}`;
  const document = { companyId, ...identity, salesCustomerId: text(group.salesCustomerId), salesCustomerCode: text(group.salesCustomerCode),
    salesCustomerName: text(group.salesCustomerName),
    salesCustomerRevision: identityV2 ? Number(group.salesCustomerRevision || 0) : finite(group.salesCustomerRevision ?? group.rows?.[0]?.salesCustomerRevision, 'ORDERQ_SALE_SOURCE_REVISION_STALE'),
    deliveryCustomerId: text(group.deliveryCustomerId), deliveryCustomerCode: text(group.deliveryCustomerCode),
    deliveryCustomerName: text(group.deliveryCustomerName),
    deliveryCustomerRevision: identityV2 ? Number(group.deliveryCustomerRevision || 0) : finite(group.deliveryCustomerRevision ?? group.rows?.[0]?.deliveryCustomerRevision, 'ORDERQ_SALE_SOURCE_REVISION_STALE'),
    billingCustomerId: text(group.billingCustomerId), billingCustomerCode: text(group.billingCustomerCode),
    billingCustomerName: text(group.billingCustomerName),
    billingCustomerRevision: identityV2 ? Number(group.billingCustomerRevision || 0) : finite(group.billingCustomerRevision ?? group.rows?.[0]?.billingCustomerRevision, 'ORDERQ_SALE_SOURCE_REVISION_STALE'),
    saleDate: identityV2 ? preflight.businessDate : text(group.voucherDate || group.saleDate),
    warehouseId: text(group.warehouseId), warehouseCode: text(group.warehouseCode), taxType: 'VAT_INCLUDED_IN_SUPPLY', currency: 'KRW',
    normalizedOriginVersion: 'SALE_V2',
    ...(identityV2 ? {
      businessDate: preflight.businessDate,
      businessDateDayDefaulted: preflight.dayDefaulted,
      ...(text(group.businessOccurredAt) ? { businessOccurredAt: text(group.businessOccurredAt) } : {}),
      officialPartnerResolution: group.officialPartnerResolution
    } : {}) };
  const commandBase = { ...document, document, lines, commandType: 'POST_SALE', aggregateId: identity.salesDocumentId,
    expectedRevision: 1, commandId, idempotencyKey: commandId, actor: text(context.actor || SMARTINPUT_SALE_ACTOR_ID),
    actorId: text(context.actor || SMARTINPUT_SALE_ACTOR_ID), reason: 'SALE_POST', occurredAt,
    ...(identityV2 && Array.isArray(context.stocktakeDecisions) && context.stocktakeDecisions.length
      ? { stocktakeDecisions: copy(context.stocktakeDecisions) }
      : {}) };
  const commandSource = identityV2 ? withOfficialCommandIdentityV2(commandBase) : commandBase;
  return { ...document, ...freezeSaleCommandIntent(commandSource), lines, commandSource };
}

async function inspectSaleGroupStocktake(group = {}, context = {}) {
  const draft = buildSalePostDraft(group, context);
  return inspectOfficialStocktakeConflicts({ kind: 'SALE', ...draft });
}

function saleCommandReceipt(aggregate, commandId) {
  return (aggregate?.commands || []).find(receipt => text(receipt.commandId) === text(commandId)
    && text(receipt.status).toUpperCase() === 'COMMITTED') || null;
}

async function lookupSaleCommandResult(salesDocumentId, commandId) {
  let timer = null;
  try {
    const aggregate = await Promise.race([
      loadSaleCommandAggregate(salesDocumentId),
      new Promise((_, reject) => {
        timer = globalThis.setTimeout(() => reject(new Error('판매 저장 결과 조회 시간이 초과되었습니다.')), OPTIONAL_OPERATION_TIMEOUT_MS.capability);
      })
    ]);
    const receipt = saleCommandReceipt(aggregate, commandId);
    return receipt
      ? { known: true, result: receipt.result }
      : { known: false, safeToRetry: true };
  } finally {
    if (timer !== null) globalThis.clearTimeout(timer);
  }
}

async function postSaleGroup(group, context = {}) {
  if (context.masters) validateSaleGroup(group, context.masters);
  const identity = deriveSaleDraftIdentity(group, context);
  const commandContext = await findSaleCommandContext({ ...identity, companyId: text(context.companyId || group.companyId),
    ...(identity.identityVersion ? { identityVersion: identity.identityVersion, voucherGroupKey: identity.voucherGroupKey } : {}) });
  let aggregate = commandContext.aggregate;
  const storedEnvelope = aggregate?.document?.commandEnvelope || null;
  const draft = buildSalePostDraft(group, storedEnvelope ? {
    ...context,
    occurredAt: storedEnvelope.occurredAt,
    actor: storedEnvelope.actorId,
    stocktakeDecisions: storedEnvelope.stocktakeDecisions
  } : context);
  if (aggregate && storedEnvelope && text(aggregate.document.draftIntentDigest) !== text(draft.draftIntentDigest)) throw new Error('ORDERQ_SALE_DRAFT_IDENTITY_CONFLICT');
  if (!aggregate) aggregate = await beginSaleCommand(draft, context.actor || SMARTINPUT_SALE_ACTOR_ID);
  const envelope = aggregate.document?.commandEnvelope || draft.commandEnvelope;
  const command = { ...envelope, intent: envelope, actor: envelope.actorId,
    salesDocumentId: draft.salesDocumentId, document: envelope.document, lines: envelope.lines, commandContract: 'VOUCHER_CORE_V1' };
  const resolved = await saleWriteResults.resolveUnknown({
    feature: 'sale-official-command',
    commandId: envelope.commandId,
    lookup: () => lookupSaleCommandResult(draft.salesDocumentId, envelope.commandId)
  });
  const result = resolved === undefined
    ? await saleWriteResults.submit({
      feature: 'sale-official-command',
      commandId: envelope.commandId,
      timeoutMs: OPTIONAL_OPERATION_TIMEOUT_MS.capability,
      execute: () => commitSaleCommand(command)
    })
    : resolved;
  return { ...result, salesDocumentId: draft.salesDocumentId, commandId: envelope.commandId };
}

return { SALE_STAGE4_CAPABILITY, SALE_STAGE4_EXPECTED_DEPLOYMENT, SMARTINPUT_SALE_ACTOR_ID, evaluateSaleStage4Capability, loadSaleStage4Capability, validateSaleGroup, deriveSaleDraftIdentity, buildSalePostDraft, inspectSaleGroupStocktake, postSaleGroup };
})();

// ============================================================================
// purchase-finalize-service.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const purchaseFinalizeServiceSection = (() => {
const { validatePurchaseGroup } = legacyIntegrationAdapterDependency4;
const { inspectPurchaseGroupStocktake, postPurchaseGroup, SMARTINPUT_PURCHASE_ACTOR_ID } = purchaseOfficialStage3Section;
const { OFFICIAL_VOUCHER_IDENTITY_VERSION_V2, preflightOfficialVoucherV2 } = officialVoucherV2ContractDependency2;
const { resolveOfficialVoucherReferencesV2 } = officialVoucherReferenceResolverSection;
const { createOfficialStocktakeDecisionsV2, OfficialStocktakeConflictRequiredError, OfficialStocktakeInspectionUnavailableError, officialStocktakeConflictKeyV2 } = stocktakeConflictV2Dependency5;

const PURCHASE_FINALIZE_SERVICE_CONTRACT = Object.freeze({
  version: 'ONEAPP_SMARTINPUT_PURCHASE_FINALIZE_SERVICE_V1',
  input: 'prepared SmartInput purchase groups and current reference snapshots',
  validatorPort: 'V1 legacy-integration-adapter.validatePurchaseGroup / V2 official-voucher-v2-contract.preflightOfficialVoucherV2',
  commandPort: 'purchase-official-stage3 builder/orchestrator to ORDER Q official command Adapter',
  inventoryPlannerPort: 'ORDER Q Repository current planOfficialVoucherCommand path'
});

function createPurchaseFinalizeService(ports = {}) {
  const validateGroup = ports.validateGroup || validatePurchaseGroup;
  const submitGroup = ports.submitGroup || postPurchaseGroup;
  const inspectGroup = ports.inspectGroup || (ports.submitGroup ? null : inspectPurchaseGroupStocktake);
  const now = ports.now || (() => new Date().toISOString());
  return Object.freeze({
    contract: PURCHASE_FINALIZE_SERVICE_CONTRACT,
    async finalize(request = {}) {
      const groups = request.groups || [];
      const outcomes = new Map();
      const prepared = [];
      for (const group of groups) {
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
          prepared.push({ group, identityV2, submitSource, context: {
            companyId: request.companyId,
            actor: request.actor || SMARTINPUT_PURCHASE_ACTOR_ID,
            originSystem: producer,
            manualSessionId: request.manualSessionId,
            occurredAt: now(),
            ...(request.identityVersion ? { identityVersion: request.identityVersion } : {})
          } });
        } catch (error) {
          outcomes.set(group, { ok: false, group, error });
        }
      }

      const v2Prepared = prepared.filter(row => row.identityV2);
      if (v2Prepared.length) {
        if (typeof inspectGroup !== 'function') {
          const error = new OfficialStocktakeInspectionUnavailableError();
          prepared.forEach(row => outcomes.set(row.group, { ok: false, group: row.group, error }));
          return groups.map(group => outcomes.get(group));
        }
        const assessments = [];
        try {
          for (const row of v2Prepared) {
            assessments.push({ row, assessment: await inspectGroup(row.submitSource, row.context) });
          }
        } catch (error) {
          prepared.forEach(row => outcomes.set(row.group, { ok: false, group: row.group, error }));
          return groups.map(group => outcomes.get(group));
        }
        const conflicts = assessments.flatMap(row => row.assessment.conflicts || []);
        if (conflicts.length && !Array.isArray(request.stocktakeDecisions)) {
          const error = new OfficialStocktakeConflictRequiredError(conflicts);
          prepared.forEach(row => outcomes.set(row.group, { ok: false, group: row.group, error }));
          return groups.map(group => outcomes.get(group));
        }
        if (conflicts.length || request.stocktakeDecisions !== undefined) {
          try {
            const decisions = createOfficialStocktakeDecisionsV2({
              conflicts,
              selections: request.stocktakeDecisions,
              actor: v2Prepared[0].context.actor
            });
            const decisionByConflict = new Map(conflicts.map((conflict, index) => [
              officialStocktakeConflictKeyV2(conflict), decisions[index]
            ]));
            for (const { row, assessment } of assessments) {
              row.context.stocktakeDecisions = (assessment.conflicts || [])
                .map(conflict => decisionByConflict.get(officialStocktakeConflictKeyV2(conflict)));
            }
            // Re-read every affected checkpoint before the first write. The
            // Repository repeats this inside each write transaction.
            for (const row of v2Prepared) await inspectGroup(row.submitSource, row.context);
          } catch (error) {
            prepared.forEach(row => outcomes.set(row.group, { ok: false, group: row.group, error }));
            return groups.map(group => outcomes.get(group));
          }
        }
      }

      for (const row of prepared) {
        try {
          const result = await submitGroup(row.submitSource, row.context);
          outcomes.set(row.group, { ok: true, group: row.group, result });
        } catch (error) {
          outcomes.set(row.group, { ok: false, group: row.group, error });
        }
      }
      return groups.map(group => outcomes.get(group));
    }
  });
}

const PurchaseFinalizeService = createPurchaseFinalizeService();

return { PURCHASE_FINALIZE_SERVICE_CONTRACT, createPurchaseFinalizeService, PurchaseFinalizeService };
})();

// ============================================================================
// sale-finalize-service.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const saleFinalizeServiceSection = (() => {
const { inspectSaleGroupStocktake, postSaleGroup, SMARTINPUT_SALE_ACTOR_ID } = saleOfficialStage4Section;
const { OFFICIAL_VOUCHER_IDENTITY_VERSION_V2 } = officialVoucherV2ContractDependency2;
const { resolveOfficialVoucherReferencesV2 } = officialVoucherReferenceResolverSection;
const { createOfficialStocktakeDecisionsV2, OfficialStocktakeConflictRequiredError, OfficialStocktakeInspectionUnavailableError, officialStocktakeConflictKeyV2 } = stocktakeConflictV2Dependency5;

const SALE_FINALIZE_SERVICE_CONTRACT = Object.freeze({
  version: 'ONEAPP_SMARTINPUT_SALE_FINALIZE_SERVICE_V1',
  input: 'prepared SmartInput sale groups and current reference snapshots',
  validatorPort: 'current sale handler bypass preserved; sale-official-stage4 validates only when masters are supplied',
  productResolverPort: 'prepared group rows from the existing SmartInput reference resolver',
  commandPort: 'sale-official-stage4 builder/orchestrator to ORDER Q official command Adapter',
  inventoryPlannerPort: 'ORDER Q Repository current planOfficialVoucherCommand path'
});

const value = input => String(input);

function createSaleFinalizeService(ports = {}) {
  const submitGroup = ports.submitGroup || postSaleGroup;
  const inspectGroup = ports.inspectGroup || (ports.submitGroup ? null : inspectSaleGroupStocktake);
  const now = ports.now || (() => new Date().toISOString());
  return Object.freeze({
    contract: SALE_FINALIZE_SERVICE_CONTRACT,
    async finalize(request = {}) {
      const groups = request.groups || [];
      const outcomes = new Map();
      const prepared = [];
      for (const group of groups) {
        try {
          const identityV2 = value(request.identityVersion || '').trim() === OFFICIAL_VOUCHER_IDENTITY_VERSION_V2;
          const producer = value(group.originSystem || group.rows?.[0]?.originSystem
            || (request.activeMethod === 'paste' ? 'SMARTINPUT_CLIPBOARD' : request.activeMethod === 'excel' ? 'SMARTINPUT_FILE' : 'SMARTINPUT_MANUAL')).toUpperCase();
          const producerTransactionId = value(group.originTransactionId || group.rows?.[0]?.originTransactionId
            || request.lastBatchContentHash || request.manualSessionId);
          const customerRevision = customerId => Number((request.customers || [])
            .find(row => value(row.customerId) === value(customerId))?.revision || 0);
          const hydratedGroup = {
            ...group,
            salesCustomerRevision: Number(group.salesCustomerRevision || group.rows?.[0]?.salesCustomerRevision || customerRevision(group.salesCustomerId)),
            deliveryCustomerRevision: Number(group.deliveryCustomerRevision || group.rows?.[0]?.deliveryCustomerRevision || customerRevision(group.deliveryCustomerId)),
            billingCustomerRevision: Number(group.billingCustomerRevision || group.rows?.[0]?.billingCustomerRevision || customerRevision(group.billingCustomerId)),
            rows: (group.rows || []).map(row => {
              const product = (request.products || []).find(item => value(item.productId || item.itemCode) === value(row.productId || row.itemCode));
              const warehouse = (request.warehouses || []).find(item => value(item.warehouseId || item.warehouseCode)
                === value(row.warehouseId || group.warehouseId || row.rowWarehouseCode));
              const sourceType = value(row.sourceType || group.sourceType || 'DIRECT').toUpperCase();
              return {
                ...row,
                sourceType,
                orderLinkMode: sourceType === 'ORDER_Q' ? 'ORDER_Q' : 'DIRECT',
                productId: row.productId || product?.productId || '',
                productMasterRevision: Number(row.productMasterRevision || product?.revision || 0),
                warehouseId: row.warehouseId || group.warehouseId || warehouse?.warehouseId || '',
                warehouseMasterRevision: Number(row.warehouseMasterRevision || warehouse?.revision || 0),
                actualToBaseFactor: sourceType === 'ORDER_Q' ? Number(row.actualToBaseFactor) : 1,
                actualToRecognizedFactor: sourceType === 'ORDER_Q' ? Number(row.actualToRecognizedFactor) : 0,
                actualUnit: row.actualUnit || row.unit || '',
                baseUnit: sourceType === 'ORDER_Q' ? row.baseUnit : (row.actualUnit || row.unit || ''),
                recognizedUnit: row.recognizedUnit || row.unit || '',
                conversionSource: sourceType === 'ORDER_Q' ? row.conversionSource : 'DIRECT_SAME_UNIT',
                conversionRuleId: sourceType === 'ORDER_Q' ? row.conversionRuleId : 'DIRECT_1_TO_1',
                conversionRuleVersion: sourceType === 'ORDER_Q' ? row.conversionRuleVersion : 'DIRECT_1_TO_1_V1'
              };
            })
          };
          const submitSource = identityV2 ? resolveOfficialVoucherReferencesV2({
            kind: 'SALE',
            companyId: request.companyId || hydratedGroup.companyId,
            group: hydratedGroup,
            products: request.products || [],
            customers: request.customers || [],
            productReferenceSnapshotId: request.productReferenceSnapshotId,
            customerReferenceSnapshotId: request.customerReferenceSnapshotId
          }) : hydratedGroup;
          prepared.push({ group, identityV2, submitSource, context: {
            companyId: request.companyId,
            actor: request.actor || SMARTINPUT_SALE_ACTOR_ID,
            originSystem: producer,
            manualSessionId: producerTransactionId,
            occurredAt: now(),
            ...(request.identityVersion ? { identityVersion: request.identityVersion } : {})
          } });
        } catch (error) {
          outcomes.set(group, { ok: false, group, error });
        }
      }

      const v2Prepared = prepared.filter(row => row.identityV2);
      if (v2Prepared.length) {
        if (typeof inspectGroup !== 'function') {
          const error = new OfficialStocktakeInspectionUnavailableError();
          prepared.forEach(row => outcomes.set(row.group, { ok: false, group: row.group, error }));
          return groups.map(group => outcomes.get(group));
        }
        const assessments = [];
        try {
          for (const row of v2Prepared) {
            assessments.push({ row, assessment: await inspectGroup(row.submitSource, row.context) });
          }
        } catch (error) {
          prepared.forEach(row => outcomes.set(row.group, { ok: false, group: row.group, error }));
          return groups.map(group => outcomes.get(group));
        }
        const conflicts = assessments.flatMap(row => row.assessment.conflicts || []);
        if (conflicts.length && !Array.isArray(request.stocktakeDecisions)) {
          const error = new OfficialStocktakeConflictRequiredError(conflicts);
          prepared.forEach(row => outcomes.set(row.group, { ok: false, group: row.group, error }));
          return groups.map(group => outcomes.get(group));
        }
        if (conflicts.length || request.stocktakeDecisions !== undefined) {
          try {
            const decisions = createOfficialStocktakeDecisionsV2({
              conflicts,
              selections: request.stocktakeDecisions,
              actor: v2Prepared[0].context.actor
            });
            const decisionByConflict = new Map(conflicts.map((conflict, index) => [
              officialStocktakeConflictKeyV2(conflict), decisions[index]
            ]));
            for (const { row, assessment } of assessments) {
              row.context.stocktakeDecisions = (assessment.conflicts || [])
                .map(conflict => decisionByConflict.get(officialStocktakeConflictKeyV2(conflict)));
            }
            for (const row of v2Prepared) await inspectGroup(row.submitSource, row.context);
          } catch (error) {
            prepared.forEach(row => outcomes.set(row.group, { ok: false, group: row.group, error }));
            return groups.map(group => outcomes.get(group));
          }
        }
      }

      for (const row of prepared) {
        try {
          const result = await submitGroup(row.submitSource, row.context);
          outcomes.set(row.group, { ok: true, group: row.group, result });
        } catch (error) {
          outcomes.set(row.group, { ok: false, group: row.group, error });
        }
      }
      return groups.map(group => outcomes.get(group));
    }
  });
}

const SaleFinalizeService = createSaleFinalizeService();

return { SALE_FINALIZE_SERVICE_CONTRACT, createSaleFinalizeService, SaleFinalizeService };
})();

// ============================================================================
// stocktake-conflict-dialog.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const stocktakeConflictDialogSection = (() => {
const { OFFICIAL_STOCKTAKE_DECISION, officialStocktakeConflictKeyV2 } = stocktakeConflictV2Dependency5;

const text = value => String(value ?? '').trim();

function preservedUiState() {
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = activeElement && 'selectionStart' in activeElement
    ? { start: activeElement.selectionStart, end: activeElement.selectionEnd, direction: activeElement.selectionDirection }
    : null;
  const tableScroll = document.getElementById('tableScroll');
  return {
    activeElement,
    selection,
    windowX: window.scrollX,
    windowY: window.scrollY,
    tableScroll,
    tableTop: tableScroll?.scrollTop || 0,
    tableLeft: tableScroll?.scrollLeft || 0
  };
}

function restoreUiState(saved) {
  window.scrollTo(saved.windowX, saved.windowY);
  if (saved.tableScroll?.isConnected) {
    saved.tableScroll.scrollTop = saved.tableTop;
    saved.tableScroll.scrollLeft = saved.tableLeft;
  }
  if (!saved.activeElement?.isConnected) return;
  saved.activeElement.focus({ preventScroll: true });
  if (saved.selection && typeof saved.activeElement.setSelectionRange === 'function') {
    saved.activeElement.setSelectionRange(saved.selection.start, saved.selection.end, saved.selection.direction || 'none');
  }
}

function conflictLabel(conflict = {}) {
  const product = [text(conflict.productCode), text(conflict.productName)].filter(Boolean).join(' / ') || '상품 정보 없음';
  const warehouse = text(conflict.warehouseName || conflict.warehouseCode || conflict.warehouseId) || '창고 정보 없음';
  const quantity = Number(conflict.quantity);
  return { product, warehouse, quantity: Number.isFinite(quantity) ? String(quantity) : text(conflict.quantity) };
}

function showStocktakeConflictDialog(conflicts = []) {
  if (!Array.isArray(conflicts) || !conflicts.length) return Promise.resolve([]);
  const saved = preservedUiState();
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'smart-dialog stocktake-conflict-dialog';
    dialog.setAttribute('aria-labelledby', 'stocktakeConflictTitle');
    dialog.setAttribute('aria-describedby', 'stocktakeConflictMessage');
    dialog.innerHTML = `<div class="smart-dialog__shell">
      <header><div><small>Stocktake Conflict</small><h2 id="stocktakeConflictTitle">재고실사 확인</h2></div><button type="button" data-stocktake-cancel aria-label="닫기">×</button></header>
      <p id="stocktakeConflictMessage" class="smart-dialog__message stocktake-conflict-dialog__message">이 전표는 최근 재고실사 이전의 거래입니다.</p>
      <div class="stocktake-conflict-dialog__rows" role="list" aria-label="재고실사 충돌 상품"></div>
      <p class="smart-dialog__message stocktake-conflict-dialog__question">이 수량이 실사 결과에 이미 포함되어 있습니까?</p>
      <footer>
        <button type="button" class="button button--primary" data-stocktake-decision="INCLUDED_IN_CHECKPOINT">실사수량에 포함됨</button>
        <button type="button" class="button button--quiet" data-stocktake-decision="NOT_INCLUDED_IN_CHECKPOINT">실사수량에 포함되지 않음</button>
        <button type="button" class="button button--danger" data-stocktake-cancel>확정 취소</button>
      </footer>
    </div>`;
    const rows = dialog.querySelector('.stocktake-conflict-dialog__rows');
    let conflictIndex = 0;
    const selections = [];
    const renderConflict = () => {
      const conflict = conflicts[conflictIndex];
      const label = conflictLabel(conflict);
      const row = document.createElement('div');
      row.className = 'stocktake-conflict-dialog__row';
      row.setAttribute('role', 'listitem');
      const product = document.createElement('strong');
      product.textContent = label.product;
      const details = document.createElement('span');
      details.textContent = `창고 ${label.warehouse}`;
      const quantity = document.createElement('em');
      quantity.textContent = `수량 ${label.quantity}`;
      row.append(product, details, quantity);
      rows.replaceChildren(row);
    };
    renderConflict();
    document.body.append(dialog);
    let settled = false;
    const finish = decisionType => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      window.setTimeout(() => {
        try { restoreUiState(saved); }
        finally { resolve(decisionType); }
      }, 0);
    };
    dialog.querySelectorAll('[data-stocktake-cancel]').forEach(button => button.addEventListener('click', () => finish(null)));
    dialog.querySelectorAll('[data-stocktake-decision]').forEach(button => button.addEventListener('click', () => {
      const decisionType = text(button.dataset.stocktakeDecision);
      selections.push({
        conflictKey: officialStocktakeConflictKeyV2(conflicts[conflictIndex]),
        decisionType: decisionType === OFFICIAL_STOCKTAKE_DECISION.INCLUDED
          ? OFFICIAL_STOCKTAKE_DECISION.INCLUDED
          : OFFICIAL_STOCKTAKE_DECISION.NOT_INCLUDED,
        judgedAt: new Date().toISOString()
      });
      conflictIndex += 1;
      if (conflictIndex >= conflicts.length) {
        finish(selections);
        return;
      }
      renderConflict();
      dialog.querySelector('[data-stocktake-decision="INCLUDED_IN_CHECKPOINT"]')?.focus({ preventScroll: true });
    }));
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      finish(null);
    });
    dialog.showModal();
    dialog.querySelector('[data-stocktake-decision="INCLUDED_IN_CHECKPOINT"]')?.focus({ preventScroll: true });
  });
}

return { showStocktakeConflictDialog };
})();

// ============================================================================
// official-voucher-feature.js — implementation moved here; private helpers remain scoped.
// ============================================================================
const officialVoucherFeatureSection = (() => {




return { PurchaseFinalizeService: purchaseFinalizeServiceSection.PurchaseFinalizeService, SaleFinalizeService: saleFinalizeServiceSection.SaleFinalizeService, showStocktakeConflictDialog: stocktakeConflictDialogSection.showStocktakeConflictDialog };
})();

// Public API (same functions and constants; no additional command layer).
export const OFFICIAL_PRODUCT_RESOLUTION_STATUS = officialVoucherReferenceResolverSection.OFFICIAL_PRODUCT_RESOLUTION_STATUS;
export const OFFICIAL_PARTNER_RESOLUTION_STATUS = officialVoucherReferenceResolverSection.OFFICIAL_PARTNER_RESOLUTION_STATUS;
export const officialProductCodeKey = officialVoucherReferenceResolverSection.officialProductCodeKey;
export const normalizedCustomerCodeKey = officialVoucherReferenceResolverSection.normalizedCustomerCodeKey;
export const resolveOfficialVoucherReferencesV2 = officialVoucherReferenceResolverSection.resolveOfficialVoucherReferencesV2;
export const PURCHASE_STAGE3_CAPABILITY = purchaseOfficialStage3Section.PURCHASE_STAGE3_CAPABILITY;
export const PURCHASE_STAGE3_EXPECTED_DEPLOYMENT = purchaseOfficialStage3Section.PURCHASE_STAGE3_EXPECTED_DEPLOYMENT;
export const SMARTINPUT_PURCHASE_ACTOR_ID = purchaseOfficialStage3Section.SMARTINPUT_PURCHASE_ACTOR_ID;
export const evaluatePurchaseStage3Capability = purchaseOfficialStage3Section.evaluatePurchaseStage3Capability;
export const loadPurchaseStage3Capability = purchaseOfficialStage3Section.loadPurchaseStage3Capability;
export const validatePurchaseGroup = purchaseOfficialStage3Section.validatePurchaseGroup;
export const derivePurchaseDraftIdentity = purchaseOfficialStage3Section.derivePurchaseDraftIdentity;
export const buildPurchasePostDraft = purchaseOfficialStage3Section.buildPurchasePostDraft;
export const resolvePersistedPurchaseRetry = purchaseOfficialStage3Section.resolvePersistedPurchaseRetry;
export const inspectPurchaseGroupStocktake = purchaseOfficialStage3Section.inspectPurchaseGroupStocktake;
export const postPurchaseGroup = purchaseOfficialStage3Section.postPurchaseGroup;
export const SALE_STAGE4_CAPABILITY = saleOfficialStage4Section.SALE_STAGE4_CAPABILITY;
export const SALE_STAGE4_EXPECTED_DEPLOYMENT = saleOfficialStage4Section.SALE_STAGE4_EXPECTED_DEPLOYMENT;
export const SMARTINPUT_SALE_ACTOR_ID = saleOfficialStage4Section.SMARTINPUT_SALE_ACTOR_ID;
export const evaluateSaleStage4Capability = saleOfficialStage4Section.evaluateSaleStage4Capability;
export const loadSaleStage4Capability = saleOfficialStage4Section.loadSaleStage4Capability;
export const validateSaleGroup = saleOfficialStage4Section.validateSaleGroup;
export const deriveSaleDraftIdentity = saleOfficialStage4Section.deriveSaleDraftIdentity;
export const buildSalePostDraft = saleOfficialStage4Section.buildSalePostDraft;
export const inspectSaleGroupStocktake = saleOfficialStage4Section.inspectSaleGroupStocktake;
export const postSaleGroup = saleOfficialStage4Section.postSaleGroup;
export const PURCHASE_FINALIZE_SERVICE_CONTRACT = purchaseFinalizeServiceSection.PURCHASE_FINALIZE_SERVICE_CONTRACT;
export const createPurchaseFinalizeService = purchaseFinalizeServiceSection.createPurchaseFinalizeService;
export const PurchaseFinalizeService = purchaseFinalizeServiceSection.PurchaseFinalizeService;
export const SALE_FINALIZE_SERVICE_CONTRACT = saleFinalizeServiceSection.SALE_FINALIZE_SERVICE_CONTRACT;
export const createSaleFinalizeService = saleFinalizeServiceSection.createSaleFinalizeService;
export const SaleFinalizeService = saleFinalizeServiceSection.SaleFinalizeService;
export const showStocktakeConflictDialog = stocktakeConflictDialogSection.showStocktakeConflictDialog;
