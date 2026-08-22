import { analyzeSmartText } from './smartparser/parser-orchestrator.js?v=0.12.3';
import { generateProductCandidates, loadCandidateContext } from './smartparser/candidate-generator.js?v=0.8.2';
import { matchParsedLine } from './smartparser/matching-engine.js?v=0.8.0';
import { createOrder } from './order-intake-engine.js?v=0.15.0';
import { buildSourceOccurrenceKey, computeRawFingerprint } from './intake-identity.js?v=0.11.0';
import {
  createOrOpenIntakeSession,
  appendIntakeSourcePart,
  createIntakeDocument,
  replaceIntakeLines,
  getIntakeSessionBundle
} from './intake-repository.js?v=0.11.0';
import { adaptAnalysisToOrderDocument, intakeLinesToOrderItems } from './intake-document-adapter.js?v=0.2.0';

const actor = value => value || { actorId: 'LOCAL_USER', actorName: 'ORDER IN 관리자' };
const ORDER_LIKE = new Set(['ORDER', 'ORDER_UPDATE']);

function text(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function numberValue(value) {
  const normalized = text(value).replace(/[,원₩]/g, '');
  if (!normalized) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function splitTableRow(line) {
  const raw = String(line ?? '').trim();
  if (!raw) return [];
  if (raw.includes('\t')) return raw.split('\t').map(text);
  if (raw.includes('|')) return raw.split('|').map(text).filter(Boolean);
  const wide = raw.split(/\s{2,}/).map(text).filter(Boolean);
  return wide.length >= 4 ? wide : [];
}

function cleanProductCell(value) {
  const raw = text(value);
  const markdown = raw.match(/^\[\s*([^\]]+?)\s*\]\(([^)]+)\)$/);
  const label = text(markdown ? markdown[1] : raw).replace(/^[-•·*]+\s*/, '');
  const url = markdown?.[2] || raw;
  const code = decodeURIComponent(url).match(/[?&](?:it_id|item_id|itemCode)=([^&#]+)/i)?.[1] || '';
  return { label, itemCode: text(code) };
}

function normalizedHeader(value) {
  return text(value).toLowerCase().replace(/\s+/g, '');
}

function findColumn(headers, names) {
  return headers.findIndex(header => names.some(name => header.includes(name)));
}

function unitFromSpecification(specification) {
  const value = text(specification);
  if (/^box$/i.test(value)) return 'BOX';
  if (/^ea$/i.test(value)) return 'EA';
  const known = value.match(/(?:^|\d)\s*(개|봉|팩|단|망|상자|묶음|kg|키로|통|병|포|롤|장|대|판)$/i);
  return known?.[1] || '';
}

export function parseStructuredOrderText(rawText) {
  const lines = String(rawText ?? '').replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean);
  let headerIndex = -1;
  let headers = [];
  for (let index = 0; index < lines.length; index += 1) {
    const cells = splitTableRow(lines[index]);
    if (cells.length < 3) continue;
    const normalized = cells.map(normalizedHeader);
    if (normalized.some(value => value.includes('상품명')) && normalized.some(value => value.includes('수량'))) {
      headerIndex = index;
      headers = normalized;
      break;
    }
  }
  if (headerIndex < 0) return { detected: false, rows: [], analysisText: text(rawText) };

  const productIndex = findColumn(headers, ['상품명', '품목명', '상품']);
  const specIndex = findColumn(headers, ['규격', '단위']);
  const quantityIndex = findColumn(headers, ['수량']);
  const priceIndex = findColumn(headers, ['판매가', '단가']);
  const rows = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (/^(닫기|합계|총합)$/i.test(line)) break;
    const cells = splitTableRow(line);
    if (!cells.length || productIndex < 0 || quantityIndex < 0 || cells.length <= Math.max(productIndex, quantityIndex)) continue;
    const product = cleanProductCell(cells[productIndex]);
    const quantity = numberValue(cells[quantityIndex]);
    if (!product.label || quantity === null) continue;
    const specification = specIndex >= 0 ? text(cells[specIndex]) : '';
    const unit = unitFromSpecification(specification);
    const unitPrice = priceIndex >= 0 ? numberValue(cells[priceIndex]) : null;
    rows.push({
      productText: product.label,
      itemCode: product.itemCode,
      specification,
      unit,
      quantity,
      unitPrice
    });
  }
  if (!rows.length) return { detected: false, rows: [], analysisText: text(rawText) };
  const analysisText = rows.map(row => {
    const specForName = row.specification && !row.unit ? ` ${row.specification}` : '';
    const quantityUnit = `${row.quantity}${row.unit ? ` ${row.unit}` : ''}`;
    return `${row.productText}${specForName} ${quantityUnit}`.trim();
  }).join('\n');
  return { detected: true, rows, analysisText };
}

function customerOverride(value = null) {
  const customerId = text(value?.customerId);
  const customerName = text(value?.customerName);
  return customerId && customerName ? { customerId, customerName } : null;
}

async function rematchAnalysisForCustomer(analysis, customer, sourceId, structuredRows = []) {
  const context = await loadCandidateContext();
  for (const result of analysis.results || []) {
    if (!ORDER_LIKE.has(result.eventType)) continue;
    result.confirmedCustomerId = customer.customerId;
    result.confirmedCustomerName = customer.customerName;
    result.customerCandidate = { customerId: customer.customerId, customerName: customer.customerName };
    result.customerStatus = 'MATCHED';
    result.customerMatchSource = 'ADMIN_PRESET';
    result.parsedLines = await Promise.all((result.parsedLines || []).map(async (line, index) => {
      const structured = structuredRows[index] || null;
      const enriched = {
        ...line,
        productText: structured?.productText || line.productText,
        specification: structured?.specification || line.specification || line.specText || '',
        specText: structured?.specification || line.specText || line.specification || '',
        rawUnit: structured?.unit || line.rawUnit || line.finalUnit || '',
        finalUnit: structured?.unit || line.finalUnit || line.rawUnit || '',
        unitPrice: structured?.unitPrice ?? line.unitPrice ?? null,
        externalItemCode: structured?.itemCode || line.externalItemCode || ''
      };
      if (enriched.excluded) return enriched;
      const candidates = await generateProductCandidates({
        productText: enriched.productText,
        customerId: customer.customerId,
        sourceId,
        itemCodeHint: enriched.externalItemCode,
        context
      });
      return {
        ...matchParsedLine(enriched, candidates),
        unitPrice: enriched.unitPrice,
        externalItemCode: enriched.externalItemCode
      };
    }));
  }
  return analysis;
}

export async function rematchExtractedLinesForCustomer(lines, customer, sourceId = 'ORDER_IN') {
  if (!customer?.customerId || !customer?.customerName) throw new Error('ORDERQ_INTAKE_CUSTOMER_REQUIRED');
  const context = await loadCandidateContext();
  return Promise.all((lines || []).map(async line => {
    if (line.excluded || line.reviewStatus === 'EXCLUDED') return line;
    const candidates = await generateProductCandidates({
      productText: line.productText || line.itemName || line.rawExpression,
      customerId: customer.customerId,
      sourceId,
      itemCodeHint: line.externalItemCode || line.itemCode,
      context
    });
    return {
      ...line,
      ...matchParsedLine(line, candidates),
      customerId: customer.customerId,
      customerName: customer.customerName
    };
  }));
}

export async function captureTextIntake(input = {}) {
  if (!text(input.rawText)) throw new Error('ORDERQ_INTAKE_SOURCE_EMPTY');
  if (text(input.documentType || 'ORDER') !== 'ORDER') throw new Error('ORDERQ_INTAKE_DOCUMENT_TYPE_UNSUPPORTED');
  const sourceType = text(input.sourceType || 'GENERAL_TEXT');
  const sourceId = text(input.sourceId || 'ORDER_IN');
  const imageHash = text(input.imageEvidence?.contentHash);
  const fingerprintInput = imageHash ? `${input.rawText}\nIMAGE:${imageHash}` : input.rawText;
  const rawFingerprint = await computeRawFingerprint({ sourceType, sourceId, rawText: fingerprintInput });
  const sourceOccurrenceKey = await buildSourceOccurrenceKey({
    sourceSystem: sourceType,
    sourceContainerId: sourceId,
    sourceNativeId: input.captureOccurrenceId || rawFingerprint
  });
  const opened = await createOrOpenIntakeSession({
    actor: actor(input.actor),
    documentType: 'ORDER',
    sourceType,
    sourceId,
    sourceOccurrenceKey,
    rawFingerprint,
    stage: 'CAPTURED'
  });
  const textPartResult = await appendIntakeSourcePart({
    actor: actor(input.actor),
    intakeSessionId: opened.session.intakeSessionId,
    sourceType,
    sourceId,
    sourceMessageKey: sourceOccurrenceKey,
    partType: 'TEXT',
    rawText: input.rawText,
    contentHash: rawFingerprint
  });
  let imagePart = null;
  if (imageHash && input.imageEvidence?.binaryBase64) {
    const imagePartResult = await appendIntakeSourcePart({
      actor: actor(input.actor),
      intakeSessionId: opened.session.intakeSessionId,
      sourceType,
      sourceId,
      partType: 'IMAGE',
      contextIndex: 1,
      mimeType: text(input.imageEvidence.mimeType),
      binaryBase64: text(input.imageEvidence.binaryBase64),
      byteLength: Number(input.imageEvidence.byteLength || 0),
      contentHash: imageHash,
      ocrText: input.rawText
    });
    imagePart = imagePartResult.sourcePart || imagePartResult.part;
  }
  return {
    session: opened.session,
    sourcePart: textPartResult.sourcePart || textPartResult.part,
    imagePart
  };
}

export async function analyzeSingleOrderDocument(input) {
  const raw = String(input.rawText || '');
  const structured = parseStructuredOrderText(raw);
  const override = customerOverride(input.customerOverride);
  const sessionType = text(input.session.sourceType || 'GENERAL_TEXT').toUpperCase();
  let parserSourceType = sessionType;
  let parserText = structured.detected ? structured.analysisText : raw;

  if (sessionType !== 'KAKAO_TEXT') {
    const lines = parserText.split(/\r?\n/).filter(value => value.trim());
    let sender = override?.customerName || '';
    if (!sender && !structured.detected && sessionType === 'GENERAL_TEXT') sender = text(lines.shift());
    if (!sender) sender = 'ORDER IN';
    parserSourceType = 'KAKAO_TEXT';
    parserText = `[${sender}] [ORDER IN] ${lines.join('\n')}`;
  }

  let analysis = await analyzeSmartText({
    sourceType: parserSourceType,
    sourceId: input.session.sourceId,
    rawText: parserText
  });

  const orderRows = (analysis.results || []).filter(result => ORDER_LIKE.has(result.eventType));
  const resolved = orderRows.length === 1 && orderRows[0].confirmedCustomerId && orderRows[0].confirmedCustomerName
    ? { customerId: orderRows[0].confirmedCustomerId, customerName: orderRows[0].confirmedCustomerName }
    : null;
  const customer = override || resolved;
  if (customer) analysis = await rematchAnalysisForCustomer(analysis, customer, input.session.sourceId, structured.rows);
  const adapted = await adaptAnalysisToOrderDocument({
    analysis,
    intakeSession: input.session,
    sourcePart: input.sourcePart
  });
  const created = await createIntakeDocument({
    actor: actor(input.actor),
    intakeSessionId: input.session.intakeSessionId,
    documentType: 'ORDER',
    sourceDocumentKey: adapted.sourceDocumentKey,
    sourceMessageKeys: [adapted.parsed.sourceMessageKey],
    confirmedCustomerId: customer?.customerId || '',
    confirmedCustomerName: customer?.customerName || '',
    headerDraft: input.headerDraft || {},
    stage: 'EXTRACTION_REVIEW'
  });
  const replaced = await replaceIntakeLines({
    actor: actor(input.actor),
    intakeDocumentId: created.document.intakeDocumentId,
    expectedRevision: created.document.revision,
    lines: adapted.lines,
    nextStage: 'EXTRACTION_REVIEW'
  });
  return {
    analysis,
    document: replaced.document,
    lines: replaced.lines,
    detectedInputType: structured.detected ? 'SHOP_TABLE' : sessionType
  };
}

const save = (input, nextStage, reasonCode) => replaceIntakeLines({
  actor: actor(input.actor),
  intakeDocumentId: input.document.intakeDocumentId,
  expectedRevision: input.document.revision,
  lines: input.lines,
  nextStage,
  reviewStatus: nextStage === 'DOCUMENT_REVIEW' ? 'CONFIRMED' : 'PENDING',
  reasonCode
});

export const saveExtractionReview = input => save(input, 'EXTRACTION_REVIEW', 'EXTRACTION_EDITED');
export const confirmExtraction = input => save(input, 'MATCH_REVIEW', 'EXTRACTION_CONFIRMED');
export const saveMatchingReview = input => save(input, 'MATCH_REVIEW', 'MATCHING_EDITED');
export const confirmMatching = input => save(input, 'DOCUMENT_REVIEW', 'MATCHING_CONFIRMED');
export const saveOrderCompletion = input => save(input, 'DOCUMENT_REVIEW', 'COMPLETION_EDITED');
export const reopenIntakeStage = (input, stage) => save(input, stage, 'DOWNSTREAM_CONFIRMATION_INVALIDATED');

export async function commitIntakeOrder(input) {
  const bundle = await getIntakeSessionBundle(input.document.intakeSessionId);
  const lines = bundle.lines.filter(line => line.intakeDocumentId === input.document.intakeDocumentId);
  return createOrder({
    ...input.orderDraft,
    items: intakeLinesToOrderItems(lines),
    sourceType: 'ORDER_IN',
    sourceId: bundle.session.sourceId,
    sourceDocumentKey: input.document.sourceDocumentKey,
    intakeSessionId: bundle.session.intakeSessionId,
    intakeDocumentId: input.document.intakeDocumentId,
    intakeCommit: {
      intakeSessionId: bundle.session.intakeSessionId,
      intakeDocumentId: input.document.intakeDocumentId,
      expectedRevision: input.document.revision,
      actor: actor(input.actor),
      injectFailureAt: input.injectFailureAt
    }
  });
}
