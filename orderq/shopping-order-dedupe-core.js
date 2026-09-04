export const SHOPPING_ORDER_DEDUPE_SCHEMA = 'ONEAPP_ORDERQ_SHOPPING_ORDER_DEDUPE_V1';
export const SHOPPING_ORDER_SOURCE_SCHEMA = 'ONEAPP_SHOPPING_ORDER_SOURCE_EVIDENCE_V1';

export const SHOPPING_ORDER_HEADERS = Object.freeze([
  '배송일자', '거래처명', '그룹', '주문상태', '전하실말씀', '상점메모', '상품코드', '상품명', '규격',
  '수량', '단가', '금액', '복사원코드', '주소', '전화2', '원코드', '유통그룹관리코드'
]);

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const exactText = value => String(value ?? '').trim();
const compareText = value => exactText(value).normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const displayText = value => exactText(value).normalize('NFKC').replace(/\s+/g, ' ');

function codeText(value) {
  return exactText(value);
}

function numberValue(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/[,\s원₩]/g, ''));
  return Number.isFinite(parsed) ? (Object.is(parsed, -0) ? 0 : parsed) : null;
}

function dateText(value) {
  const raw = exactText(value);
  const match = raw.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
  if (!match) return raw;
  return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
}

function deepCopy(value) {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepCopy(entry)]));
  return value;
}

function codePointCompare(left, right) {
  const a = Array.from(String(left), char => char.codePointAt(0));
  const b = Array.from(String(right), char => char.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort(codePointCompare).reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalValue(value[key]);
      return result;
    }, {});
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('SHOPPING_ORDER_CANONICAL_NUMBER_INVALID');
    return Object.is(value, -0) ? 0 : value;
  }
  return value;
}

export function canonicalShoppingJson(value) {
  return JSON.stringify(canonicalValue(value));
}

// Synchronous SHA-256 keeps the signature identical in browsers and Node without a runtime dependency.
export function sha256Text(value) {
  const input = unescape(encodeURIComponent(String(value ?? '')));
  const words = [];
  const bitLength = input.length * 8;
  for (let index = 0; index < input.length; index += 1) {
    words[index >> 2] = (words[index >> 2] || 0) | input.charCodeAt(index) << (24 - (index % 4) * 8);
  }
  words[bitLength >> 5] = (words[bitLength >> 5] || 0) | 0x80 << (24 - bitLength % 32);
  words[((bitLength + 64 >> 9) << 4) + 15] = bitLength;
  const rotateRight = (number, bits) => number >>> bits | number << (32 - bits);
  const primes = [];
  for (let candidate = 2; primes.length < 64; candidate += 1) {
    if (primes.every(prime => candidate % prime)) primes.push(candidate);
  }
  const constants = primes.map(prime => Math.floor((Math.pow(prime, 1 / 3) % 1) * 0x100000000));
  let hash = primes.slice(0, 8).map(prime => Math.floor((Math.sqrt(prime) % 1) * 0x100000000));
  for (let offset = 0; offset < words.length; offset += 16) {
    const schedule = Array.from({ length: 16 }, (_, index) => words[offset + index] || 0);
    const previous = hash.slice();
    for (let index = 16; index < 64; index += 1) {
      const a = schedule[index - 15] || 0;
      const b = schedule[index - 2] || 0;
      schedule[index] = (schedule[index - 16]
        + (rotateRight(a, 7) ^ rotateRight(a, 18) ^ a >>> 3)
        + schedule[index - 7]
        + (rotateRight(b, 17) ^ rotateRight(b, 19) ^ b >>> 10)) | 0;
    }
    for (let index = 0; index < 64; index += 1) {
      const temp1 = (hash[7]
        + (rotateRight(hash[4], 6) ^ rotateRight(hash[4], 11) ^ rotateRight(hash[4], 25))
        + (hash[4] & hash[5] ^ ~hash[4] & hash[6])
        + constants[index] + schedule[index]) | 0;
      const temp2 = ((rotateRight(hash[0], 2) ^ rotateRight(hash[0], 13) ^ rotateRight(hash[0], 22))
        + (hash[0] & hash[1] ^ hash[0] & hash[2] ^ hash[1] & hash[2])) | 0;
      hash = [(temp1 + temp2) | 0, hash[0], hash[1], hash[2], (hash[3] + temp1) | 0, hash[4], hash[5], hash[6]];
    }
    hash = hash.map((number, index) => (number + previous[index]) | 0);
  }
  return hash.map(number => (number >>> 0).toString(16).padStart(8, '0')).join('');
}

export function validateShoppingOrderHeaders(headers = []) {
  const actual = Array.from(headers, value => String(value ?? ''));
  const issues = [];
  if (actual.length !== SHOPPING_ORDER_HEADERS.length) {
    issues.push({
      code: 'SHOPPING_SOURCE_HEADER_COUNT_INVALID',
      message: `쇼핑몰 원본 헤더는 ${SHOPPING_ORDER_HEADERS.length}개여야 합니다.`,
      expected: SHOPPING_ORDER_HEADERS.length,
      actual: actual.length
    });
  }
  SHOPPING_ORDER_HEADERS.forEach((header, index) => {
    if (actual[index] === header) return;
    issues.push({
      code: 'SHOPPING_SOURCE_HEADER_POSITION_INVALID',
      message: `${index + 1}열은 '${header}'이어야 합니다.`,
      column: index + 1,
      expected: header,
      actual: actual[index] ?? ''
    });
  });
  return issues;
}

function rawSourceObject(row, headers) {
  if (row?.sourceValues && typeof row.sourceValues === 'object') return row.sourceValues;
  if (Array.isArray(row?.sourceCells)) {
    return Object.fromEntries(headers.map((header, index) => [header, row.sourceCells[index] ?? '']));
  }
  return row || {};
}

function rowValue(row, raw, canonicalKeys, sourceHeader, fallback = '') {
  for (const key of canonicalKeys) if (own(row, key)) return row[key];
  return own(raw, sourceHeader) ? raw[sourceHeader] : fallback;
}

function itemIdentity(item = {}) {
  const productId = codeText(item.productId || item.masterProductId);
  if (productId) return { kind: 'PRODUCT_ID', value: productId };
  const itemCode = codeText(item.itemCode || item.productCode || item.sourceProductCode);
  if (itemCode) return { kind: 'PRODUCT_CODE', value: itemCode };
  return { kind: 'MISSING', value: '' };
}

function partyIdentity(input = {}) {
  const customerId = codeText(input.customerId);
  if (customerId) return { kind: 'CUSTOMER_ID', value: customerId };
  const customerCode = codeText(input.customerCode || input.erpCustomerCode);
  if (customerCode) return { kind: 'CUSTOMER_CODE', value: customerCode };
  const customerName = compareText(input.customerName);
  return customerName ? { kind: 'CUSTOMER_NAME', value: customerName } : { kind: 'MISSING', value: '' };
}

function warehouseIdentity(input = {}) {
  const warehouseId = codeText(input.warehouseId);
  if (warehouseId) return { kind: 'WAREHOUSE_ID', value: warehouseId };
  const warehouseCode = codeText(input.warehouseCode);
  if (warehouseCode) return { kind: 'WAREHOUSE_CODE', value: warehouseCode };
  const warehouseName = compareText(input.warehouseName || input.warehouse);
  return warehouseName ? { kind: 'WAREHOUSE_NAME', value: warehouseName } : { kind: 'MISSING', value: '' };
}

function canonicalItem(item = {}) {
  return {
    identity: itemIdentity(item),
    specification: displayText(item.specification),
    unit: displayText(item.unit ?? item.finalUnit ?? item.rawUnit),
    quantity: numberValue(item.quantity ?? item.finalQuantity ?? item.rawQuantity),
    unitPrice: numberValue(item.unitPrice ?? item.price),
    amount: numberValue(item.amount ?? item.supplyAmount)
  };
}

function itemSortKey(item) {
  return canonicalShoppingJson(item);
}

export function canonicalShoppingOrderBasis(input = {}) {
  const items = (input.items || []).map(canonicalItem).sort((left, right) => codePointCompare(itemSortKey(left), itemSortKey(right)));
  return {
    schemaVersion: SHOPPING_ORDER_DEDUPE_SCHEMA,
    companyId: codeText(input.companyId || 'ONEAPP'),
    customer: partyIdentity(input),
    deliveryDate: dateText(input.deliveryDate || input.deliveryExpectedDate),
    warehouse: warehouseIdentity(input),
    items
  };
}

export function canonicalShoppingOrderSignature(input = {}) {
  return sha256Text(canonicalShoppingJson(canonicalShoppingOrderBasis(input)));
}

function itemIssues(item, rowNumber) {
  const issues = [];
  if (!codeText(item.productId || item.masterProductId)) {
    issues.push({ code: 'SHOPPING_PRODUCT_OWNER_ID_REQUIRED', message: '상품 owner ID를 확인하세요.', sourceRowNumber: rowNumber });
  }
  if (itemIdentity(item).kind === 'MISSING') {
    issues.push({ code: 'SHOPPING_PRODUCT_IDENTITY_REQUIRED', message: '상품 식별정보가 필요합니다.', sourceRowNumber: rowNumber });
  }
  if (!codeText(item.itemCode || item.productCode || item.sourceProductCode)) {
    issues.push({ code: 'SHOPPING_PRODUCT_CODE_REQUIRED', message: '저장할 상품코드를 확인하세요.', sourceRowNumber: rowNumber });
  }
  if (!exactText(item.itemName || item.productName)) {
    issues.push({ code: 'SHOPPING_PRODUCT_NAME_REQUIRED', message: '저장할 상품명을 확인하세요.', sourceRowNumber: rowNumber });
  }
  const quantity = numberValue(item.quantity ?? item.finalQuantity ?? item.rawQuantity);
  const unitPrice = numberValue(item.unitPrice ?? item.price);
  const amount = numberValue(item.amount ?? item.supplyAmount);
  if (quantity === null) issues.push({ code: 'SHOPPING_QUANTITY_INVALID', message: '수량을 숫자로 확인하세요.', sourceRowNumber: rowNumber });
  if (quantity === 0) issues.push({ code: 'SHOPPING_ZERO_QUANTITY_REVIEW_REQUIRED', message: '수량 0은 자동 저장하지 않습니다.', sourceRowNumber: rowNumber });
  if (unitPrice === null) issues.push({ code: 'SHOPPING_UNIT_PRICE_INVALID', message: '단가를 숫자로 확인하세요.', sourceRowNumber: rowNumber });
  if (amount === null) issues.push({ code: 'SHOPPING_AMOUNT_INVALID', message: '금액을 숫자로 확인하세요.', sourceRowNumber: rowNumber });
  if (quantity !== null && unitPrice !== null && amount !== null
    && Math.abs((quantity * unitPrice) - amount) > 0.000001) {
    issues.push({
      code: 'SHOPPING_AMOUNT_MISMATCH',
      message: '원본 수량 × 단가와 금액이 일치하지 않습니다.',
      sourceRowNumber: rowNumber,
      expectedAmount: quantity * unitPrice,
      actualAmount: amount
    });
  }
  return issues;
}

export function validateShoppingOrderCandidate(candidate = {}) {
  const issues = [...(candidate.issues || [])];
  if (!codeText(candidate.companyId)) issues.push({ code: 'SHOPPING_COMPANY_REQUIRED', message: '회사를 확인하세요.' });
  if (partyIdentity(candidate).kind === 'MISSING') issues.push({ code: 'SHOPPING_CUSTOMER_REQUIRED', message: '거래처를 확인하세요.' });
  if (!codeText(candidate.customerId)) issues.push({ code: 'SHOPPING_CUSTOMER_OWNER_ID_REQUIRED', message: '거래처 owner ID를 확인하세요.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText(candidate.deliveryDate || candidate.deliveryExpectedDate))) {
    issues.push({ code: 'SHOPPING_DELIVERY_DATE_INVALID', message: '배송일자를 확인하세요.' });
  }
  if (warehouseIdentity(candidate).kind === 'MISSING') issues.push({ code: 'SHOPPING_WAREHOUSE_REQUIRED', message: '출하창고를 확인하세요.' });
  if (!codeText(candidate.warehouseId)) issues.push({ code: 'SHOPPING_WAREHOUSE_OWNER_ID_REQUIRED', message: '출하창고 owner ID를 확인하세요.' });
  if (!Array.isArray(candidate.items) || !candidate.items.length) issues.push({ code: 'SHOPPING_ITEMS_REQUIRED', message: '주문 품목이 필요합니다.' });
  (candidate.items || []).forEach((item, index) => issues.push(...itemIssues(item, candidate.sourceRows?.[index]?.sourceRowNumber || index + 1)));
  return issues.filter((issue, index, all) => index === all.findIndex(candidateIssue => canonicalShoppingJson(candidateIssue) === canonicalShoppingJson(issue)));
}

function ambiguousRepeatedSequence(items = []) {
  const values = items.map(item => itemSortKey(canonicalItem(item)));
  for (let start = 0; start < values.length - 1; start += 1) {
    for (let length = 1; start + (length * 2) <= values.length; length += 1) {
      const first = values.slice(start, start + length);
      const second = values.slice(start + length, start + (length * 2));
      if (first.every((value, index) => value === second[index])) return { start, length };
    }
  }
  return null;
}

function normalizeSourceRow(row, index, options) {
  const headers = options.headers || SHOPPING_ORDER_HEADERS;
  const raw = rawSourceObject(row, headers);
  const customerResolved = typeof options.resolveCustomer === 'function' ? (options.resolveCustomer(raw, row, index) || {}) : {};
  const productResolved = typeof options.resolveProduct === 'function' ? (options.resolveProduct(raw, row, index) || {}) : {};
  const warehouseResolved = typeof options.resolveWarehouse === 'function' ? (options.resolveWarehouse(raw, row, index) || {}) : {};
  const sourceCells = Array.isArray(row?.sourceCells)
    ? row.sourceCells.map(deepCopy)
    : headers.map(header => deepCopy(raw[header] ?? ''));
  const quantity = numberValue(rowValue(row, raw, ['quantity', 'finalQuantity', 'rawQuantity'], '수량'));
  const unitPrice = numberValue(rowValue(row, raw, ['unitPrice', 'price'], '단가'));
  const amount = numberValue(rowValue(row, raw, ['amount', 'supplyAmount'], '금액'));
  const specification = rowValue(row, raw, ['specification'], '규격');
  return {
    companyId: codeText(rowValue(row, raw, ['companyId'], '', options.companyId || 'ONEAPP')),
    deliveryDate: dateText(rowValue(row, raw, ['deliveryDate', 'deliveryExpectedDate'], '배송일자')),
    customerId: codeText(customerResolved.customerId || rowValue(row, raw, ['customerId'], '')),
    customerCode: codeText(customerResolved.customerCode || customerResolved.erpCustomerCode || rowValue(row, raw, ['customerCode', 'erpCustomerCode'], '')),
    customerName: displayText(customerResolved.customerName || rowValue(row, raw, ['customerName'], '거래처명')),
    warehouseId: codeText(warehouseResolved.warehouseId || rowValue(row, raw, ['warehouseId'], '', options.warehouseId || '')),
    warehouseCode: codeText(warehouseResolved.warehouseCode || rowValue(row, raw, ['warehouseCode'], '', options.warehouseCode || '')),
    warehouseName: displayText(warehouseResolved.warehouseName || rowValue(row, raw, ['warehouseName', 'warehouse'], '', options.warehouseName || '')),
    // A file/document key identifies the upload, not an order inside this fixed source.
    // Only an explicit upstream order boundary or a reviewed manual split may bypass run ambiguity.
    sourceBoundaryKey: codeText(rowValue(row, raw, ['sourceBoundaryKey', 'manualSplitKey'], '')),
    sourceStatus: exactText(rowValue(row, raw, ['sourceStatus', 'externalOriginalStatus'], '주문상태')),
    item: {
      productId: codeText(productResolved.productId || productResolved.masterProductId || rowValue(row, raw, ['productId', 'masterProductId'], '')),
      sourceProductCode: codeText(rowValue(row, raw, ['sourceProductCode'], '상품코드')),
      itemCode: codeText(productResolved.itemCode || productResolved.productCode || rowValue(row, raw, ['itemCode', 'productCode'], '상품코드')),
      itemName: exactText(productResolved.itemName || productResolved.productName || rowValue(row, raw, ['itemName', 'productName'], '상품명')),
      specification: exactText(specification),
      unit: exactText(rowValue(row, raw, ['unit', 'finalUnit', 'rawUnit'], '', specification)),
      quantity,
      unitPrice,
      amount,
      sourceRowNumber: Number(row?.sourceRowNumber || row?.sourceRowNo || index + 2),
      sourceRelativeRowNumber: index + 1
    },
    evidence: {
      sourceRowNumber: Number(row?.sourceRowNumber || row?.sourceRowNo || index + 2),
      sourceRelativeRowNumber: index + 1,
      sourceCells,
      sourceCellEvidence: deepCopy(Array.isArray(row?.sourceCellEvidence) ? row.sourceCellEvidence : []),
      sourceValues: deepCopy(raw)
    }
  };
}

function sourceScope(row) {
  return canonicalShoppingJson({
    companyId: row.companyId,
    deliveryDate: row.deliveryDate,
    customer: partyIdentity(row),
    warehouse: warehouseIdentity(row)
  });
}

export function buildShoppingOrderCandidates(sourceRows = [], options = {}) {
  const headers = options.headers || SHOPPING_ORDER_HEADERS;
  const headerIssues = validateShoppingOrderHeaders(headers);
  if (headerIssues.length) return { schemaVersion: SHOPPING_ORDER_DEDUPE_SCHEMA, candidates: [], issues: headerIssues };
  const normalized = sourceRows.map((row, index) => normalizeSourceRow(row, index, { ...options, headers }));
  const groups = [];
  normalized.forEach(row => {
    const explicit = row.sourceBoundaryKey;
    const boundary = `${sourceScope(row)}|${explicit ? `EXPLICIT:${explicit}` : 'CUSTOMER_RUN'}`;
    const current = groups[groups.length - 1];
    if (!current || current.boundary !== boundary) groups.push({ boundary, explicit: Boolean(explicit), rows: [row] });
    else current.rows.push(row);
  });

  const candidates = groups.map((group, index) => {
    const first = group.rows[0];
    const items = group.rows.map(row => ({ ...row.item }));
    const issues = [];
    if (!group.explicit) {
      const repeated = ambiguousRepeatedSequence(items);
      if (repeated) {
        issues.push({
          code: 'AMBIGUOUS_SOURCE_ORDER_BOUNDARY',
          message: '같은 거래처의 연속 행에서 동일 주문 반복을 구분할 원본 식별자가 없어 자동 저장할 수 없습니다.',
          sourceRowNumber: group.rows[repeated.start]?.evidence.sourceRowNumber || first.evidence.sourceRowNumber,
          repeatedLineCount: repeated.length
        });
      }
    }
    return {
      schemaVersion: SHOPPING_ORDER_DEDUPE_SCHEMA,
      candidateId: exactText(group.rows[0]?.candidateId) || `SHOPPING-CANDIDATE-${String(index + 1).padStart(4, '0')}`,
      sourceOrder: index + 1,
      boundaryMode: group.explicit ? 'EXPLICIT_SOURCE_KEY' : 'CONTIGUOUS_CUSTOMER_RUN',
      sourceBoundaryKey: first.sourceBoundaryKey,
      companyId: first.companyId,
      customerId: first.customerId,
      customerCode: first.customerCode,
      customerName: first.customerName,
      deliveryDate: first.deliveryDate,
      deliveryExpectedDate: first.deliveryDate,
      warehouseId: first.warehouseId,
      warehouseCode: first.warehouseCode,
      warehouseName: first.warehouseName,
      orderDate: dateText(options.orderDate || first.deliveryDate),
      items,
      sourceStatuses: [...new Set(group.rows.map(row => row.sourceStatus))],
      sourceRows: group.rows.map(row => deepCopy(row.evidence)),
      sourceEvidence: {
        schemaVersion: SHOPPING_ORDER_SOURCE_SCHEMA,
        fileName: exactText(options.fileName),
        sheetName: exactText(options.sheetName),
        uploadedAt: exactText(options.uploadedAt),
        headers: [...headers],
        rows: group.rows.map(row => deepCopy(row.evidence))
      },
      issues
    };
  }).map(candidate => ({ ...candidate, issues: validateShoppingOrderCandidate(candidate) }));

  return { schemaVersion: SHOPPING_ORDER_DEDUPE_SCHEMA, candidates, issues: [] };
}

export function orderBundleToShoppingCandidate(bundle = {}, defaultCompanyId = 'ONEAPP') {
  const order = bundle.order || {};
  return {
    companyId: codeText(order.companyId || defaultCompanyId),
    customerId: codeText(order.customerId),
    customerCode: codeText(order.customerCode || order.erpCustomerCode),
    customerName: exactText(order.customerName),
    deliveryDate: dateText(order.deliveryExpectedDate || order.deliveryDate),
    warehouseId: codeText(order.warehouseId),
    warehouseCode: codeText(order.warehouseCode),
    warehouseName: exactText(order.warehouseName || order.warehouse),
    items: (bundle.items || []).map(item => {
      const quantity = numberValue(item.finalQuantity ?? item.quantity ?? item.rawQuantity);
      const unitPrice = numberValue(item.price ?? item.unitPrice);
      const explicitAmount = numberValue(item.supplyAmount ?? item.amount);
      return {
        productId: codeText(item.productId || item.masterProductId),
        itemCode: codeText(item.itemCode || item.productCode || item.sourceProductCode),
        itemName: exactText(item.itemName || item.productName),
        specification: exactText(item.specification),
        unit: exactText(item.finalUnit ?? item.unit ?? item.rawUnit),
        quantity,
        unitPrice,
        amount: explicitAmount ?? (quantity !== null && unitPrice !== null ? quantity * unitPrice : null)
      };
    })
  };
}

function potentiallySameIdentity(leftIdentity, rightIdentity, leftName = '', rightName = '') {
  if (leftIdentity.kind !== 'MISSING' && rightIdentity.kind !== 'MISSING'
    && canonicalShoppingJson(leftIdentity) === canonicalShoppingJson(rightIdentity)) return true;
  const leftNormalizedName = compareText(leftName);
  const rightNormalizedName = compareText(rightName);
  return Boolean(leftNormalizedName && rightNormalizedName && leftNormalizedName === rightNormalizedName);
}

function potentiallyConflictingHeader(candidate, existing) {
  const candidateCompany = codeText(candidate.companyId || 'ONEAPP');
  const existingCompany = codeText(existing.companyId || 'ONEAPP');
  if (candidateCompany !== existingCompany) return false;
  const candidateDate = dateText(candidate.deliveryDate || candidate.deliveryExpectedDate);
  const existingDate = dateText(existing.deliveryDate || existing.deliveryExpectedDate);
  if (candidateDate && existingDate && candidateDate !== existingDate) return false;
  if (!potentiallySameIdentity(partyIdentity(candidate), partyIdentity(existing), candidate.customerName, existing.customerName)) return false;
  const candidateWarehouse = warehouseIdentity(candidate);
  const existingWarehouse = warehouseIdentity(existing);
  if (candidateWarehouse.kind === 'MISSING' || existingWarehouse.kind === 'MISSING') return true;
  return canonicalShoppingJson(candidateWarehouse) === canonicalShoppingJson(existingWarehouse)
    || Boolean(compareText(candidate.warehouseName || candidate.warehouse)
      && compareText(candidate.warehouseName || candidate.warehouse) === compareText(existing.warehouseName || existing.warehouse));
}

export function findInvalidExistingLedgerConflicts(candidate, existingBundles = [], defaultCompanyId = 'ONEAPP') {
  return existingBundles.flatMap(bundle => {
    const comparable = orderBundleToShoppingCandidate(bundle, defaultCompanyId);
    const issues = validateShoppingOrderCandidate(comparable);
    if (!issues.length || !potentiallyConflictingHeader(candidate, comparable)) return [];
    return [{ orderId: bundle.order?.orderId || '', issues }];
  });
}

function planningEntry(candidate, signature, occurrenceNo, existing = []) {
  const issues = validateShoppingOrderCandidate(candidate);
  const matchedExisting = occurrenceNo > 0 && occurrenceNo <= existing.length ? existing[occurrenceNo - 1] : null;
  if (issues.length) {
    return {
      candidate,
      candidateId: candidate.candidateId,
      status: 'REVIEW_REQUIRED',
      isDuplicate: null,
      canonicalSignature: signature || '',
      occurrenceNo: occurrenceNo || 0,
      existingCount: existing.length,
      existingOrderIds: existing.map(bundle => bundle.order?.orderId).filter(Boolean),
      existingOrderId: '',
      existingOrderNo: '',
      issues
    };
  }
  return {
    candidate,
    candidateId: candidate.candidateId,
    status: occurrenceNo <= existing.length ? 'DUPLICATE' : 'NEW',
    isDuplicate: occurrenceNo <= existing.length,
    canonicalSignature: signature,
    occurrenceNo,
    existingCount: existing.length,
    existingOrderIds: existing.map(bundle => bundle.order?.orderId).filter(Boolean),
    existingOrderId: matchedExisting?.order?.orderId || '',
    existingOrderNo: matchedExisting?.order?.orderNo || '',
    issues: []
  };
}

export function planShoppingOrderDuplicates(candidates = [], existingBundles = [], options = {}) {
  const defaultCompanyId = codeText(options.defaultCompanyId || 'ONEAPP');
  const existingBySignature = new Map();
  const invalidExisting = [];
  existingBundles.forEach(bundle => {
    const comparable = orderBundleToShoppingCandidate(bundle, defaultCompanyId);
    const issues = validateShoppingOrderCandidate(comparable);
    if (issues.length) {
      invalidExisting.push({ orderId: bundle.order?.orderId || '', issues });
      return;
    }
    const signature = canonicalShoppingOrderSignature(comparable);
    const rows = existingBySignature.get(signature) || [];
    rows.push(bundle);
    existingBySignature.set(signature, rows);
  });
  existingBySignature.forEach(rows => rows.sort((left, right) =>
    String(left.order?.createdAt || '').localeCompare(String(right.order?.createdAt || ''))
    || String(left.order?.orderId || '').localeCompare(String(right.order?.orderId || ''))));

  const occurrenceBySignature = new Map();
  const results = candidates.map(candidate => {
    const preliminaryIssues = validateShoppingOrderCandidate(candidate);
    const signature = preliminaryIssues.length ? '' : canonicalShoppingOrderSignature(candidate);
    const occurrenceNo = signature ? (occurrenceBySignature.get(signature) || 0) + 1 : 0;
    if (signature) occurrenceBySignature.set(signature, occurrenceNo);
    const ledgerConflicts = preliminaryIssues.length ? []
      : findInvalidExistingLedgerConflicts(candidate, existingBundles, defaultCompanyId);
    const effectiveCandidate = ledgerConflicts.length ? {
      ...candidate,
      issues: [...(candidate.issues || []), {
        code: 'EXISTING_LEDGER_BUNDLE_INVALID',
        message: '같은 주문일 가능성이 있는 기존 ORDER Q 주문·품목을 안전하게 판정할 수 없습니다.',
        existingOrderIds: ledgerConflicts.map(conflict => conflict.orderId).filter(Boolean)
      }]
    } : candidate;
    return planningEntry(effectiveCandidate, signature, occurrenceNo, existingBySignature.get(signature) || []);
  });
  return {
    schemaVersion: SHOPPING_ORDER_DEDUPE_SCHEMA,
    results,
    summary: {
      candidateCount: results.length,
      duplicateCount: results.filter(result => result.isDuplicate === true).length,
      newCount: results.filter(result => result.isDuplicate === false).length,
      reviewRequiredCount: results.filter(result => result.isDuplicate === null).length,
      invalidExistingCount: invalidExisting.length
    },
    invalidExisting
  };
}

export function shoppingSourceMessageKey(signature, occurrenceNo) {
  const clean = exactText(signature);
  const occurrence = Number(occurrenceNo);
  if (!/^[a-f0-9]{64}$/.test(clean) || !Number.isInteger(occurrence) || occurrence < 1) {
    throw new Error('SHOPPING_SOURCE_MESSAGE_KEY_INVALID');
  }
  return `SHOPPING_ORDER_V1:${clean}:${occurrence}`;
}

export function cloneShoppingEvidence(value) {
  return deepCopy(value);
}
