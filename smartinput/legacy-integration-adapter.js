const text = value => String(value ?? '').normalize('NFKC').trim();
const normalize = value => text(value).toLowerCase().replace(/\s+/g, '');
const moduleCache = new Map();

async function load(path) {
  if (!moduleCache.has(path)) moduleCache.set(path, import(path));
  return moduleCache.get(path);
}

function unavailable(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function sha256(value) {
  if (globalThis.crypto?.subtle) {
    const bytes = new TextEncoder().encode(String(value ?? ''));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (const char of String(value ?? '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function splitSourceMessages({ sourceType = 'KAKAO_TEXT', sourceId = '', rawText = '' } = {}) {
  const source = String(rawText ?? '').replace(/\r\n?/g, '\n').trim();
  if (!source) return [];
  if (String(sourceType).toUpperCase() !== 'KAKAO_TEXT') {
    return source.split(/\n\s*\n/).map((block, index) => ({
      sourceMessageKey: `SMARTINPUT:${sourceId || 'LOCAL'}:${index + 1}`,
      senderRaw: '',
      timestampRaw: '',
      rawText: block.trim()
    })).filter(message => message.rawText);
  }
  const messages = [];
  let current = null;
  const commit = () => {
    if (!current) return;
    current.rawText = current.lines.join('\n').trim();
    if (current.rawText) {
      current.sourceMessageKey = `SMARTINPUT:${sourceId || 'LOCAL'}:${messages.length + 1}`;
      messages.push(current);
    }
    current = null;
  };
  source.split('\n').forEach(line => {
    const match = line.match(/^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/);
    if (match) {
      commit();
      current = { senderRaw: text(match[1]), timestampRaw: text(match[2]), lines: [match[3]] };
    } else if (current) current.lines.push(line);
    else current = { senderRaw: '', timestampRaw: '', lines: [line] };
  });
  commit();
  return messages;
}

const UNIT_ALIASES = Object.freeze({
  box: 'BOX', 박스: '박스', ea: 'EA', 개: '개', 봉: '봉', 팩: '팩', 단: '단', 망: '망', 묶음: '묶음',
  kg: 'kg', 키로: '키로', 통: '통', 병: '병', 포: '포', 롤: '롤', 장: '장', 대: '대', 판: '판'
});
const UNIT_SOURCE = Object.keys(UNIT_ALIASES).sort((left, right) => right.length - left.length).join('|');

function parseOrderLine(rawLine) {
  const rawText = text(rawLine).replace(/^[\-•·*]+\s*/, '').replace(/^\d+[.)]\s+/, '');
  if (!rawText || /^(?:[/.]|ㅇ|네|넵|예|확인|감사|감사합니다|알겠습니다)$/i.test(rawText)) return null;
  let working = rawText.replace(/(?:주세요|부탁드립니다|부탁해요|입니다|이에요|요)\s*$/i, '').trim();
  let quantity = null;
  let rawUnit = '';
  const unitQuantity = working.match(new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*(${UNIT_SOURCE})$`, 'i'));
  if (unitQuantity) {
    quantity = Number(unitQuantity[1]);
    rawUnit = UNIT_ALIASES[unitQuantity[2].toLowerCase()] || unitQuantity[2];
    working = working.slice(0, unitQuantity.index).trim();
  } else {
    const terminalQuantity = working.match(/(-?\d+(?:\.\d+)?)$/);
    if (terminalQuantity) {
      quantity = Number(terminalQuantity[1]);
      working = working.slice(0, terminalQuantity.index).trim();
    }
  }
  let specText = '';
  const specMatch = working.match(/(\d+(?:\.\d+)?\s*(?:개입|수|입))(?=\s|[가-힣A-Za-z]|$)/i);
  if (specMatch) {
    specText = specMatch[1].replace(/\s+/g, '');
    working = `${working.slice(0, specMatch.index)} ${working.slice(specMatch.index + specMatch[0].length)}`.trim();
  }
  const productText = working.replace(/[,:;]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!productText && quantity === null) return null;
  return {
    rawText,
    productText,
    specText,
    quantity,
    rawUnit,
    finalUnit: rawUnit,
    excluded: quantity === null && !productText
  };
}

function looksLikeOrder(rawText) {
  return new RegExp(`\\d+(?:\\.\\d+)?\\s*(?:${UNIT_SOURCE})(?:요|주세요)?(?:\\s|$)`, 'i').test(rawText)
    || /[가-힣A-Za-z][가-힣A-Za-z()/_\-\s]*\d+(?:\.\d+)?\s*(?:요|주세요)?$/im.test(rawText)
    || String(rawText).split('\n').filter(line => /\d/.test(line)).length > 0;
}

export function extractOrderProductLines(input = {}) {
  let lineNo = 0;
  return splitSourceMessages(input).flatMap(message => {
    if (!looksLikeOrder(message.rawText)) return [];
    return message.rawText.split('\n').map(parseOrderLine).filter(Boolean).map(line => ({
      ...line,
      sourceLineNo: ++lineNo,
      sourceMessageKey: message.sourceMessageKey,
      senderRaw: message.senderRaw,
      timestampRaw: message.timestampRaw,
      eventType: 'ORDER'
    }));
  });
}

function splitTableRow(line) {
  const raw = String(line ?? '').trim();
  if (!raw) return [];
  if (raw.includes('\t')) return raw.split('\t').map(text);
  if (raw.includes('|')) return raw.split('|').map(text).filter(Boolean);
  const cells = raw.split(/\s{2,}/).map(text).filter(Boolean);
  return cells.length >= 4 ? cells : [];
}

function parseStructuredOrderText(rawText) {
  const lines = String(rawText ?? '').replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  let headerIndex = -1;
  let headers = [];
  for (let index = 0; index < lines.length; index += 1) {
    const cells = splitTableRow(lines[index]);
    const normalized = cells.map(normalize);
    if (cells.length >= 3 && normalized.some(value => value.includes('상품명') || value.includes('품목명'))
      && normalized.some(value => value.includes('수량'))) {
      headerIndex = index;
      headers = normalized;
      break;
    }
  }
  if (headerIndex < 0) return { detected: false, rows: [], analysisText: text(rawText) };
  const column = names => headers.findIndex(header => names.some(name => header.includes(name)));
  const productIndex = column(['상품명', '품목명', '상품']);
  const specIndex = column(['규격', '단위']);
  const quantityIndex = column(['수량']);
  const priceIndex = column(['판매가', '단가']);
  const rows = lines.slice(headerIndex + 1).flatMap(line => {
    if (/^(닫기|합계|총합)$/i.test(line)) return [];
    const cells = splitTableRow(line);
    if (cells.length <= Math.max(productIndex, quantityIndex)) return [];
    const quantity = Number(String(cells[quantityIndex]).replace(/[,원₩]/g, ''));
    if (!text(cells[productIndex]) || !Number.isFinite(quantity)) return [];
    const specification = specIndex >= 0 ? text(cells[specIndex]) : '';
    const unit = /^(box|ea)$/i.test(specification) ? specification.toUpperCase() : '';
    const unitPriceValue = priceIndex >= 0 ? Number(String(cells[priceIndex]).replace(/[,원₩]/g, '')) : NaN;
    return [{ productText: text(cells[productIndex]), specification, unit, quantity, unitPrice: Number.isFinite(unitPriceValue) ? unitPriceValue : null }];
  });
  return {
    detected: rows.length > 0,
    rows,
    analysisText: rows.map(row => `${row.productText}${row.specification && !row.unit ? ` ${row.specification}` : ''} ${row.quantity}${row.unit ? ` ${row.unit}` : ''}`).join('\n')
  };
}

function diceSimilarity(left, right) {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a.includes(b) || b.includes(a) ? 0.7 : 0;
  const pairs = new Map();
  for (let index = 0; index < a.length - 1; index += 1) pairs.set(a.slice(index, index + 2), (pairs.get(a.slice(index, index + 2)) || 0) + 1);
  let overlap = 0;
  for (let index = 0; index < b.length - 1; index += 1) {
    const pair = b.slice(index, index + 2);
    const count = pairs.get(pair) || 0;
    if (!count) continue;
    overlap += 1;
    pairs.set(pair, count - 1);
  }
  return (2 * overlap) / (a.length + b.length - 2);
}

export function isSelectableMasterProduct(product = {}) {
  return Boolean(text(product.productId || product.itemCode || product.itemName))
    && text(product.status || 'ACTIVE').toUpperCase() !== 'INACTIVE'
    && product.active !== false;
}

export function searchProductCatalog(query, catalog = [], limit = 8) {
  const requested = normalize(query);
  if (!requested) return [];
  return catalog.filter(isSelectableMasterProduct).map(product => {
    const code = normalize(product.itemCode);
    const name = normalize(product.itemName);
    const secondary = normalize(product.secondaryName);
    const info = normalize(product.searchInfo);
    let score = 0;
    if (code === requested) score = 1000;
    else if (name === requested) score = 960;
    else if (secondary === requested || info === requested) score = 930;
    else if (code.startsWith(requested)) score = 880;
    else if (name.startsWith(requested)) score = 840;
    else if (code.includes(requested)) score = 800;
    else if (name.includes(requested)) score = 760;
    else if (secondary.includes(requested) || info.includes(requested)) score = 720;
    else {
      const similarity = Math.max(diceSimilarity(requested, name), diceSimilarity(requested, secondary), diceSimilarity(requested, info));
      if (similarity >= 0.38) score = Math.round(300 + similarity * 300);
    }
    return { ...product, score };
  }).filter(product => product.score > 0)
    .sort((left, right) => right.score - left.score || text(left.itemCode).localeCompare(text(right.itemCode), 'ko', { numeric: true }))
    .slice(0, limit);
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

async function matchLine(line, customer = null, sourceId = 'SMART_INPUT') {
  try {
    const [{ generateProductCandidates }, { matchParsedLine }] = await Promise.all([
      load('../orderq/smartparser/candidate-generator.js'),
      load('../orderq/smartparser/matching-engine.js')
    ]);
    const candidates = line.excluded ? [] : await generateProductCandidates({
      productText: line.productText || line.itemName || line.rawExpression,
      customerId: text(customer?.customerId),
      sourceId,
      itemCodeHint: line.externalItemCode || line.itemCode
    });
    return { ...line, ...matchParsedLine(line, candidates), candidateProducts: candidates };
  } catch (_) {
    const candidates = searchProductCatalog(line.productText || line.itemName || '', (await loadProductCatalog()).products || [], 8);
    const best = candidates[0];
    return {
      ...line,
      candidateProducts: candidates,
      productId: best?.score >= 930 ? best.productId : '',
      itemCode: best?.score >= 930 ? best.itemCode : '',
      itemName: best?.score >= 930 ? best.itemName : (line.itemName || line.productText || ''),
      matchStatus: best?.score >= 930 ? 'MATCHED' : 'MATCH_FAILED'
    };
  }
}

export async function rematchExtractedLinesForCustomer(lines, customer, sourceId = 'SMART_INPUT') {
  if (!customer?.customerId || !customer?.customerName) throw unavailable('CUSTOMER_REQUIRED', '거래처를 먼저 선택하세요.');
  return Promise.all((lines || []).map(async line => ({
    ...await matchLine(line, customer, sourceId),
    customerId: customer.customerId,
    customerName: customer.customerName
  })));
}

export async function captureTextIntake(input = {}) {
  if (!text(input.rawText)) throw unavailable('SMARTINPUT_SOURCE_EMPTY', '분석할 원문을 입력하세요.');
  const fingerprint = await sha256(`${input.sourceType || 'GENERAL_TEXT'}|${input.sourceId || 'SMART_INPUT'}|${input.rawText}`);
  const sessionId = `SI-LOCAL-${fingerprint.slice(0, 24)}`;
  const sourcePartId = `SI-PART-${fingerprint.slice(0, 24)}`;
  const imageHash = text(input.imageEvidence?.contentHash);
  return {
    session: {
      intakeSessionId: sessionId,
      sourceType: text(input.sourceType || 'GENERAL_TEXT'),
      sourceId: text(input.sourceId || 'SMART_INPUT'),
      sourceOccurrenceKey: text(input.captureOccurrenceId || fingerprint),
      rawFingerprint: fingerprint,
      localOnly: true
    },
    sourcePart: { sourcePartId, rawText: String(input.rawText), contentHash: fingerprint, localOnly: true },
    imagePart: imageHash ? { sourcePartId: `SI-IMAGE-${imageHash.slice(0, 24)}`, contentHash: imageHash, localOnly: true } : null
  };
}

export async function analyzeSingleOrderDocument(input = {}) {
  const rawText = String(input.rawText || '');
  const structured = parseStructuredOrderText(rawText);
  const customer = input.customerOverride?.customerId && input.customerOverride?.customerName ? input.customerOverride : null;
  let parserText = structured.detected ? structured.analysisText : rawText;
  let sourceType = text(input.session?.sourceType || 'GENERAL_TEXT').toUpperCase();
  if (sourceType !== 'KAKAO_TEXT') {
    const lines = parserText.split(/\r?\n/).filter(value => value.trim());
    const sender = customer?.customerName || (!structured.detected && sourceType === 'GENERAL_TEXT' ? text(lines.shift()) : '') || 'SMART INPUT';
    parserText = `[${sender}] [SMART INPUT] ${lines.join('\n')}`;
    sourceType = 'KAKAO_TEXT';
  }
  const extracted = extractOrderProductLines({ sourceType, sourceId: input.session?.sourceId || 'SMART_INPUT', rawText: parserText });
  const lines = await Promise.all(extracted.map(async (line, index) => {
    const structuredRow = structured.rows[index] || null;
    const enriched = {
      ...line,
      productText: structuredRow?.productText || line.productText,
      specification: structuredRow?.specification || line.specification || line.specText || '',
      quantity: structuredRow?.quantity ?? line.quantity,
      unit: structuredRow?.unit || line.finalUnit || line.rawUnit || '',
      unitPrice: structuredRow?.unitPrice ?? line.unitPrice ?? null,
      rawExpression: line.rawText || line.productText
    };
    const matched = await matchLine(enriched, customer, input.session?.sourceId || 'SMART_INPUT');
    const productId = matched.productId || matched.confirmedProductId || '';
    return {
      ...matched,
      sourcePartId: input.sourcePart?.sourcePartId || '',
      sourceLineKey: `${input.session?.intakeSessionId || 'SI-LOCAL'}:${line.sourceMessageKey}:${index + 1}`,
      itemName: matched.itemName || enriched.productText,
      productId: productId || null,
      matchStatus: enriched.excluded ? 'EXCLUDED' : (productId ? 'MATCHED' : 'MATCH_FAILED'),
      reviewStatus: enriched.excluded ? 'EXCLUDED' : 'PENDING',
      productIdentityStatus: productId ? 'MASTER_LINKED' : 'UNRESOLVED'
    };
  }));
  if (!lines.length) throw unavailable('SMARTINPUT_PARSER_NO_ROWS', '상품 행을 인식하지 못했습니다. 상품명과 수량을 확인해 주세요.');
  const documentHash = await sha256(`${input.session?.intakeSessionId || ''}|${rawText}`);
  const document = {
    intakeDocumentId: `SI-DOC-${documentHash.slice(0, 24)}`,
    intakeSessionId: input.session?.intakeSessionId || '',
    revision: 1,
    confirmedCustomerId: customer?.customerId || '',
    confirmedCustomerName: customer?.customerName || '',
    localOnly: true
  };
  return { analysis: { results: [], localOnly: true }, document, lines, detectedInputType: structured.detected ? 'SHOP_TABLE' : sourceType };
}

export async function createOrder(payload) {
  const module = await load('../orderq/order-intake-engine.js');
  return module.createOrder(payload);
}

export async function syncAfterLocalMutation(orderId) {
  const module = await load('../orderq/orderq-sync-engine.js');
  return module.syncAfterLocalMutation(orderId);
}

export const SMARTINPUT_PURCHASE_ACTOR_ID = 'SMART_INPUT_ADMIN';
export const SMARTINPUT_SALE_ACTOR_ID = 'SMART_INPUT_ADMIN';

export async function loadPurchaseStage3Capability() {
  try {
    const module = await load('./purchase-official-stage3.js');
    return await module.loadPurchaseStage3Capability();
  } catch (error) {
    return { ready: false, code: 'PURCHASE_FINALIZE_UNAVAILABLE', detail: text(error?.message || error) };
  }
}

export async function loadSaleStage4Capability() {
  try {
    const module = await load('./sale-official-stage4.js');
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
    const module = await load('./purchase-official-stage3.js');
    return await module.postPurchaseGroup(group, context);
  } catch (error) {
    throw unavailable('PURCHASE_FINALIZE_UNAVAILABLE', '구매 원장 연결을 사용할 수 없습니다. 현재 작업과 초안은 유지됩니다.', error);
  }
}

export async function postSaleGroup(group, context = {}) {
  try {
    const module = await load('./sale-official-stage4.js');
    return await module.postSaleGroup(group, context);
  } catch (error) {
    throw unavailable('SALE_FINALIZE_UNAVAILABLE', '판매 원장 연결을 사용할 수 없습니다. 현재 작업과 초안은 유지됩니다.', error);
  }
}
