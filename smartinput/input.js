import { hasMeaningfulSourceValue } from './input-template-mapper.js?v=0.3.0';

// SmartInput owns text intake and pure parsing. No repository, network, or other app engine is loaded here.
const text = value => String(value ?? '').normalize('NFKC').trim();
const normalize = value => text(value).toLowerCase().replace(/\s+/g, '');

function unavailable(code, message) {
  return Object.assign(new Error(message), { code });
}

const KAKAO_HEADER = /^\[([^\]]+)\]\s*\[([^\]]+)\]\s*(.*)$/;

export function normalizeSourceText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function stableHash(value) {
  let hash = 14695981039346656037n;
  for (const char of String(value)) {
    hash ^= BigInt(char.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return hash.toString(36).padStart(13, '0');
}

export function createSourceMessageKey({ sourceType, sourceId, senderRaw, timestampRaw, rawText }) {
  const normalized = [sourceType, sourceId, senderRaw, timestampRaw, rawText]
    .map(value => normalizeSourceText(value).toLowerCase().replace(/\s+/g, ''))
    .join('|');
  return `SMK-${stableHash(normalized)}`;
}

function finalizeMessage(messages, current, sourceType, sourceId) {
  if (!current) return;
  const rawText = normalizeSourceText(current.lines.join('\n'));
  if (!rawText) return;
  const message = {
    messageId: `MSG-${messages.length + 1}`,
    sourceType,
    sourceId,
    senderRaw: normalizeSourceText(current.senderRaw),
    senderNormalized: normalizeSourceText(current.senderRaw).toLowerCase().replace(/\s+/g, ''),
    timestampRaw: normalizeSourceText(current.timestampRaw),
    rawText,
    lines: rawText.split('\n').map(line => line.trim()).filter(Boolean),
    contextIndex: messages.length
  };
  message.sourceMessageKey = createSourceMessageKey(message);
  messages.push(message);
}

export function parseKakaoText(rawText, sourceId = '') {
  const sourceType = 'KAKAO_TEXT';
  const messages = [];
  let current = null;
  normalizeSourceText(rawText).split('\n').forEach(line => {
    const header = line.match(KAKAO_HEADER);
    if (header) {
      finalizeMessage(messages, current, sourceType, sourceId);
      current = { senderRaw: header[1], timestampRaw: header[2], lines: [header[3]] };
      return;
    }
    if (current) {
      current.lines.push(line);
    } else if (line.trim()) {
      current = { senderRaw: '', timestampRaw: '', lines: [line] };
    }
  });
  finalizeMessage(messages, current, sourceType, sourceId);
  return messages;
}

export function parseGeneralText(rawText, sourceId = '') {
  const sourceType = 'GENERAL_TEXT';
  const messages = [];
  const blocks = normalizeSourceText(rawText).split(/\n\s*\n/).flatMap(block => {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    return lines.length > 1 ? lines : [block];
  });
  blocks.map(normalizeSourceText).filter(Boolean).forEach((text, index) => {
    const message = {
      messageId: `MSG-${index + 1}`,
      sourceType,
      sourceId,
      senderRaw: '',
      senderNormalized: '',
      timestampRaw: '',
      rawText: text,
      lines: text.split('\n').map(line => line.trim()).filter(Boolean),
      contextIndex: index
    };
    message.sourceMessageKey = createSourceMessageKey(message);
    messages.push(message);
  });
  return messages;
}

export function parseSourceInput({ sourceType = 'KAKAO_TEXT', sourceId = '', rawText = '' }) {
  const normalizedType = String(sourceType || '').toUpperCase();
  return normalizedType === 'GENERAL_TEXT'
    ? parseGeneralText(rawText, sourceId)
    : parseKakaoText(rawText, sourceId);
}

export const EVENT_TYPE = Object.freeze({
  ORDER: 'ORDER',
  ORDER_UPDATE: 'ORDER_UPDATE',
  ORDER_CANCEL: 'ORDER_CANCEL',
  NOTICE: 'NOTICE',
  INFORMATION: 'INFORMATION',
  ACK: 'ACK',
  UNKNOWN: 'UNKNOWN'
});

const ACK_PATTERN = /^(?:[/.]|ㅇ|네|넵|예|확인|감사|감사합니다|알겠습니다|ok|okay)$/i;
const UNIT_PATTERN = '(?:박스|box|ea|개|봉|팩|단|망|묶음|kg|키로|통|병|포|롤|장|대|판)';

export function detectOrderEvent(rawText) {
  const text = String(rawText ?? '').normalize('NFKC').trim();
  const compact = text.replace(/\s+/g, ' ');
  const reasons = [];
  if (!compact) return { eventType: EVENT_TYPE.UNKNOWN, score: 0, reasons: ['EMPTY'] };
  if (ACK_PATTERN.test(compact.toLowerCase())) return { eventType: EVENT_TYPE.ACK, score: 1, reasons: ['ACK_EXACT'] };

  if (/(?:주문|발주).{0,8}(?:취소|철회)|(?:취소|빼\s*주세요|안\s*할게|필요\s*없)/i.test(compact)) {
    return { eventType: EVENT_TYPE.ORDER_CANCEL, score: 0.96, reasons: ['CANCEL_EXPRESSION'] };
  }
  if (/(?:주문|수량|품목).{0,8}(?:변경|수정)|(?:추가|대신).{0,10}(?:주세요|부탁)/i.test(compact)) {
    return { eventType: EVENT_TYPE.ORDER_UPDATE, score: 0.88, reasons: ['UPDATE_EXPRESSION'] };
  }

  const noticeShape = /(?:공지|안내|마감|휴무|입고예정|출고예정|오픈|도착|가능시간|까지).*(?:발주|주문|부탁)/i.test(compact)
    || /\d{1,2}\s*시\s*(?:전|까지).*(?:발주|주문)\s*부탁/i.test(compact);
  if (noticeShape) return { eventType: EVENT_TYPE.NOTICE, score: 0.94, reasons: ['NOTICE_SENTENCE'] };

  if (/^(?:[가-힣A-Za-z][가-힣A-Za-z()/_\-\s]*)\s+\d{3,7}\s*(?:원)?$/i.test(compact)
      || /(?:단가|가격|재고|시세|원입니다|원이에요)/i.test(compact)) {
    return { eventType: EVENT_TYPE.INFORMATION, score: 0.9, reasons: ['PRICE_OR_STOCK_INFORMATION'] };
  }

  const hasUnitQuantity = new RegExp(`\\d+(?:\\.\\d+)?\\s*${UNIT_PATTERN}(?:요|주세요)?(?:\\s|$)`, 'i').test(compact);
  const hasTerminalQuantity = /[가-힣A-Za-z][가-힣A-Za-z()/_\-\s]*\d+(?:\.\d+)?\s*(?:요|주세요)?$/i.test(compact);
  const hasMultilineItems = text.includes('\n') && text.split('\n').filter(line => /\d/.test(line)).length >= 1;
  if (hasUnitQuantity || hasTerminalQuantity || hasMultilineItems) {
    if (hasUnitQuantity) reasons.push('QUANTITY_WITH_UNIT');
    if (hasTerminalQuantity) reasons.push('PRODUCT_WITH_TERMINAL_QUANTITY');
    if (hasMultilineItems) reasons.push('MULTILINE_ITEMS');
    return { eventType: EVENT_TYPE.ORDER, score: hasUnitQuantity ? 0.9 : 0.82, reasons };
  }

  if (/(?:부탁드립니다|참고하세요|확인바랍니다|전달드립니다)/i.test(compact)) {
    return { eventType: EVENT_TYPE.NOTICE, score: 0.7, reasons: ['NOTICE_REQUEST_STYLE'] };
  }
  return { eventType: EVENT_TYPE.UNKNOWN, score: 0.35, reasons: ['INSUFFICIENT_EVIDENCE'] };
}

const UNIT_ALIASES = Object.freeze({
  box: 'BOX', 박스: '박스', ea: 'EA', 개: '개', 봉: '봉', 팩: '팩', 단: '단', 망: '망', 묶음: '묶음',
  kg: 'kg', 키로: '키로', 통: '통', 병: '병', 포: '포', 롤: '롤', 장: '장', 대: '대', 판: '판'
});
const UNIT_SOURCE = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length).join('|');
const ACK_LINE = /^(?:[/.]|ㅇ|네|넵|예|확인|감사|감사합니다|알겠습니다)$/i;

function cleanLine(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/^[\-•·*]+\s*/, '').replace(/^\d+[.)]\s+/, '');
}

export function parseOrderLine(rawLine) {
  const rawText = cleanLine(rawLine);
  if (!rawText || ACK_LINE.test(rawText)) return { rawText, excluded: true, reason: 'ACK_OR_EMPTY' };

  let working = rawText.replace(/(?:주세요|부탁드립니다|부탁해요|입니다|이에요|요)\s*$/i, '').trim();
  let contextReference = '';
  const contextMatch = working.match(/^(\d+\s*번)(?:\s+|$)/);
  if (contextMatch) {
    contextReference = contextMatch[1].replace(/\s+/g, '');
    working = working.slice(contextMatch[0].length).trim();
    if (!working) return { rawText, contextReference, excluded: true, reason: 'CONTEXT_REFERENCE_ONLY' };
  }

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

  const attributeMatches = working.match(/(?:좋은\s*거|큰\s*거|작은\s*거|굵은\s*거|특품|상품)/g) || [];
  const attributeText = attributeMatches.join(' ').replace(/\s+/g, ' ').trim();
  if (attributeText) working = working.replace(/(?:좋은\s*거|큰\s*거|작은\s*거|굵은\s*거|특품|상품)/g, ' ');
  const productText = working.replace(/[,:;]+/g, ' ').replace(/\s+/g, ' ').trim();

  return {
    rawText,
    productText,
    specText,
    attributeText,
    contextReference,
    quantity,
    rawUnit,
    finalUnit: rawUnit,
    excluded: quantity === null && !productText,
    reason: quantity === null ? 'QUANTITY_UNRESOLVED' : (productText ? 'PARSED' : 'CONTEXT_PRODUCT_UNRESOLVED')
  };
}

export function parseOrderLines(rawText) {
  return String(rawText ?? '').replace(/\r\n?/g, '\n').split('\n')
    .map(parseOrderLine)
    .filter(line => line.rawText && !(line.excluded && line.reason === 'ACK_OR_EMPTY'));
}

const ORDER_LIKE = new Set([EVENT_TYPE.ORDER, EVENT_TYPE.ORDER_UPDATE]);

export function extractOrderMessages({ sourceType = 'KAKAO_TEXT', sourceId = '', rawText = '' } = {}) {
  return parseSourceInput({ sourceType, sourceId, rawText }).map(message => {
    const event = detectOrderEvent(message.rawText);
    return {
      message,
      event,
      parsedLines: ORDER_LIKE.has(event.eventType) ? parseOrderLines(message.rawText) : []
    };
  });
}

export function extractOrderProductLines(input = {}) {
  let sourceLineNo = 0;
  return extractOrderMessages(input).flatMap(({ message, event, parsedLines }) => parsedLines.map(line => ({
    ...line,
    sourceLineNo: ++sourceLineNo,
    sourceMessageKey: message.sourceMessageKey,
    senderRaw: message.senderRaw,
    timestampRaw: message.timestampRaw,
    eventType: event.eventType
  })));
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

export function isSelectableMasterProduct(product = {}) {
  return Boolean(text(product.productId || product.itemCode || product.itemName))
    && text(product.status || 'ACTIVE').toUpperCase() !== 'INACTIVE'
    && product.active !== false;
}


const INPUT_MATCHING_CONTEXT = Symbol('SmartInput matching context');
const normalizeMatchText = value => normalize(value).replace(/[\u200b-\u200d\ufeff]/g, '');

function productSimilarity(left, right) {
  const a = normalizeMatchText(left);
  const b = normalizeMatchText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) * 0.92;
  const previous = new Array(b.length + 1).fill(0).map((_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const upper = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = upper;
    }
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length, 1);
}

function suppliedRows(rows, companyId) {
  return (Array.isArray(rows) ? rows : []).filter(row => row && typeof row === 'object'
    && (!text(row.companyId) || text(row.companyId) === companyId)).map(row => ({ ...row }));
}

// One immutable input batch prepares the product identity map and dictionary once.
// Optional history is an owner-issued snapshot of item rows with customerId already resolved.
export function createInputMatchingContext(input = {}) {
  if (input?.[INPUT_MATCHING_CONTEXT]) return input;
  const companyId = text(input?.companyId);
  const products = suppliedRows(input?.products, companyId);
  const mappings = suppliedRows(input?.mappings, companyId);
  const history = suppliedRows(input?.history, companyId);
  const productById = new Map(products.filter(product => text(product.productId)).map(product => [product.productId, product]));
  const mappingsByText = new Map();
  mappings.forEach(mapping => {
    if ((mapping.status || 'ACTIVE') !== 'ACTIVE') return;
    const key = normalizeMatchText(mapping.normalizedText || mapping.rawText);
    if (!mappingsByText.has(key)) mappingsByText.set(key, []);
    mappingsByText.get(key).push(mapping);
  });
  const historyByCustomer = new Map();
  history.forEach(item => {
    if (!historyByCustomer.has(item.customerId)) historyByCustomer.set(item.customerId, []);
    historyByCustomer.get(item.customerId).push(item);
  });
  return { [INPUT_MATCHING_CONTEXT]: true, companyId, revision: input?.revision ?? '',
    products, productById, mappingsByText, historyByCustomer, candidateCache: new Map() };
}

function inputProductShape(product = {}, mapping = {}, context) {
  const requestedId = mapping.productId || product.productId || '';
  return {
    productId: context.productById.has(requestedId) ? requestedId : '',
    itemCode: mapping.itemCode || product.itemCode || product.productCode || '',
    itemName: mapping.itemName || product.itemName || product.productName || '',
    specification: mapping.specification || product.specification || '',
    finalUnit: mapping.finalUnit || product.unit || product.finalUnit || ''
  };
}

export function generateInputProductCandidates({ productText, customerId = '', sourceId = '' } = {}, matchingContext = {}) {
  const context = createInputMatchingContext(matchingContext);
  const normalized = normalizeMatchText(productText);
  if (!normalized) return [];
  const cacheKey = JSON.stringify([normalized, customerId, sourceId]);
  if (context.candidateCache.has(cacheKey)) return context.candidateCache.get(cacheKey).map(candidate => ({ ...candidate }));
  const candidates = [];
  const add = (shape, score, source) => {
    if (!shape.productId && !shape.itemCode && !shape.itemName) return;
    candidates.push({ ...shape, score, source });
  };
  (context.mappingsByText.get(normalized) || []).forEach(mapping => {
    const product = context.productById.get(mapping.productId) || {};
    if (customerId && mapping.customerId === customerId) add(inputProductShape(product, mapping, context), 1, 'CUSTOMER_MAPPING');
    else if (sourceId && mapping.sourceId === sourceId) add(inputProductShape(product, mapping, context), 0.98, 'SOURCE_MAPPING');
    else if (!mapping.customerId && !mapping.sourceId) add(inputProductShape(product, mapping, context), 0.96, 'COMMON_MAPPING');
  });
  if (customerId) {
    (context.historyByCustomer.get(customerId) || []).forEach(item => {
      const score = productSimilarity(productText, item.itemName);
      if (score >= 0.72) add(inputProductShape(item, item, context), Math.min(0.94, 0.78 + score * 0.16), 'CUSTOMER_HISTORY');
    });
  }
  context.products.forEach(product => {
    const score = productSimilarity(productText, product.itemName || product.productName);
    if (score >= 0.58) add(inputProductShape(product, {}, context), score === 1 ? 0.94 : 0.52 + score * 0.38, score === 1 ? 'MASTER_EXACT' : 'MASTER_FUZZY');
  });
  const byIdentity = new Map();
  candidates.forEach(candidate => {
    const key = candidate.productId || candidate.itemCode || normalizeMatchText(candidate.itemName);
    const previous = byIdentity.get(key);
    if (!previous || candidate.score > previous.score) byIdentity.set(key, candidate);
  });
  const result = [...byIdentity.values()].sort((a, b) => b.score - a.score).slice(0, 8);
  context.candidateCache.set(cacheKey, result);
  return result.map(candidate => ({ ...candidate }));
}

function matchLine(line, customer = null, sourceId = 'SMART_INPUT', matchingContext = {}) {
  const candidates = line.excluded ? [] : generateInputProductCandidates({
    productText: line.productText || line.itemName || line.rawExpression,
    customerId: text(customer?.customerId), sourceId
  }, matchingContext);
  if (line.excluded) return { ...line, candidateProducts: candidates, matchStatus: 'EXCLUDED', matchSource: line.reason || 'EXCLUDED' };
  const best = candidates[0] || null;
  const autoMatched = best && best.score >= 0.94 && best.productId;
  if (!autoMatched) {
    return { ...line, candidateProducts: candidates, matchStatus: 'MATCH_FAILED',
      matchSource: best ? 'CANDIDATE_REVIEW_REQUIRED' : 'NO_CANDIDATE',
      productId: '', confirmedProductId: '', itemCode: '', itemName: '' };
  }
  return { ...line, candidateProducts: candidates, matchStatus: 'MATCHED', matchSource: best.source,
    confirmedProductId: best.productId, productId: best.productId, itemCode: best.itemCode, itemName: best.itemName,
    specification: line.specText || best.specification || '', finalUnit: best.finalUnit || line.rawUnit || '' };
}

export async function rematchExtractedLinesForCustomer(lines, customer, sourceId = 'SMART_INPUT', matchingContext = {}) {
  if (!customer?.customerId || !customer?.customerName) throw unavailable('CUSTOMER_REQUIRED', '거래처를 먼저 선택하세요.');
  const context = createInputMatchingContext(matchingContext);
  return (lines || []).map(line => ({
    ...matchLine(line, customer, sourceId, context),
    customerId: customer.customerId, customerName: customer.customerName
  }));
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
  const matchingContext = createInputMatchingContext(input.matchingContext);
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
    const matched = await matchLine(enriched, customer, input.session?.sourceId || 'SMART_INPUT', matchingContext);
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


const MEANINGFUL_ROW_FIELDS = Object.freeze([
  'productId', 'masterProductId', 'itemCode', 'itemName', 'secondaryName', 'searchInfo',
  'unregisteredProductQuery', 'specification', 'boxQuantity', 'quantity', 'unit', 'unitPrice',
  'sourceUnitPrice', 'outPrice', 'wholesaleA', 'wholesaleB', 'listingPrice', 'marketPrice',
  'promoPrice', 'purchasePriceB', 'priceD', 'lastPurchasePrice', 'priceH', 'priceI',
  'memo', 'memo2', 'description', 'rowCustomerCode', 'rowCustomerId', 'rowCustomerName',
  'saleAmount1', 'saleAmount2', 'saleMemo3',
  'deliveryCustomerId', 'deliveryCustomerCode', 'deliveryCustomerName', 'billingCustomerId',
  'billingCustomerCode', 'billingCustomerName', 'supplierCustomerId', 'supplierCustomerCode',
  'supplierCustomerName', 'salesCustomerId', 'salesCustomerCode', 'salesCustomerName',
  'rowVoucherDate', 'rowDeliveryDate', 'rowWarehouseId', 'rowWarehouseCode', 'rowVoucherNo'
]);

export function hasEnteredValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return hasMeaningfulSourceValue(value);
  if (typeof value === 'number') return Number.isFinite(value);
  return Boolean(value);
}

export function rowHasMeaningfulInput(row = {}) {
  return MEANINGFUL_ROW_FIELDS.some(field => hasEnteredValue(row[field]))
    || hasEnteredValue(row.rawText)
    || Object.values(row.customValues || {}).some(hasEnteredValue);
}

export function rowHasLinkedSource(row = {}) {
  return Boolean(row.linkedSourceRefs?.length || (row.linkedSourceEstimateId && row.linkedSourceRowId));
}

export function compactRowBlankValues(row) {
  if (!row?.customValues || typeof row.customValues !== 'object') return row;
  row.customValues = Object.fromEntries(Object.entries(row.customValues).filter(([, value]) => hasEnteredValue(value)));
  return row;
}

export function pruneEmptyWorkRows(current) {
  if (!current?.rows) return false;
  const before = current.rows.length;
  current.rows = current.rows.filter(rowHasMeaningfulInput).map(compactRowBlankValues);
  return before !== current.rows.length;
}

export function manualLinkedRows(rows = []) {
  return rows.filter(row => !rowHasLinkedSource(row) && rowHasMeaningfulInput(row));
}
