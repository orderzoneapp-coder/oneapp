export const OFFICIAL_PRODUCT_RESOLUTION_STATUS = Object.freeze({
  MATCHED: 'MATCHED',
  UNRESOLVED: 'UNRESOLVED_PRODUCT'
});

export const OFFICIAL_PARTNER_RESOLUTION_STATUS = Object.freeze({
  MATCHED: 'MATCHED',
  NOT_PROVIDED: 'CUSTOMER_NOT_PROVIDED',
  UNRESOLVED: 'UNRESOLVED_CUSTOMER'
});

const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const snapshotText = value => String(value ?? '').trim();

export function normalizeOfficialReferenceCode(value) {
  return snapshotText(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

function firstOwnValue(source, keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source || {}, key)) return source[key];
  }
  return undefined;
}

function currentCompanyRow(row, companyId) {
  const rowCompanyId = normalizeOfficialReferenceCode(row?.companyId);
  return !rowCompanyId || rowCompanyId === normalizeOfficialReferenceCode(companyId);
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

function scopedExactMatches(rows, companyId, inputCode, codeOf, active) {
  const normalized = normalizeOfficialReferenceCode(inputCode);
  if (!normalized) return [];
  return (rows || []).filter(row => currentCompanyRow(row, companyId)
    && active(row)
    && normalizeOfficialReferenceCode(codeOf(row)) === normalized);
}

function inputProductCode(row = {}) {
  return snapshotText(firstOwnValue(row, [
    'originalProductCode', 'sourceProductCode', 'rawProductCode', 'itemCode', 'productCode'
  ]));
}

function productResolution(companyId, row, products, referenceSnapshotId) {
  const inputCode = inputProductCode(row);
  const matches = scopedExactMatches(products, companyId, inputCode, productCode, activeProduct);
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
  const matches = scopedExactMatches(customers, companyId, input.code, customerCode, activeCustomer);
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

export function resolveOfficialVoucherReferencesV2({
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
