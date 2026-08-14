import { parseSourceInput } from './source-parser.js?v=0.7.0';
import { EVENT_TYPE, detectOrderEvent } from './order-event-detector.js?v=0.7.0';
import { resolveCustomer } from './customer-resolver.js?v=0.7.0';
import { parseOrderLines } from './order-line-parser.js?v=0.7.0';
import { generateProductCandidates } from './candidate-generator.js?v=0.7.0';
import { matchParsedLine } from './matching-engine.js?v=0.7.0';
import { persistAnalysis } from './parser-repository.js?v=0.7.0';

const ORDER_LIKE = new Set([EVENT_TYPE.ORDER, EVENT_TYPE.ORDER_UPDATE]);

export async function analyzeSmartText({ sourceType, sourceId, rawText, deviceId = '', forceReanalyze = false }) {
  const messages = parseSourceInput({ sourceType, sourceId, rawText });
  if (!messages.length) throw new Error('분석할 텍스트를 입력하세요.');
  const rows = [];
  for (const message of messages) {
    const event = detectOrderEvent(message.rawText);
    const customerResolution = await resolveCustomer({ senderRaw: message.senderRaw, sourceId });
    const parsed = ORDER_LIKE.has(event.eventType) ? parseOrderLines(message.rawText) : [];
    const parsedLines = [];
    for (const line of parsed) {
      const candidates = line.excluded ? [] : await generateProductCandidates({
        productText: line.productText,
        customerId: customerResolution.customer?.customerId || '',
        sourceId
      });
      parsedLines.push(matchParsedLine(line, candidates));
    }
    rows.push({
      messageId: message.messageId,
      sourceMessageKey: message.sourceMessageKey,
      sourceType: message.sourceType,
      sourceId,
      senderRaw: message.senderRaw,
      senderNormalized: message.senderNormalized,
      timestampRaw: message.timestampRaw,
      rawText: message.rawText,
      eventType: event.eventType,
      eventScore: event.score,
      eventReasons: event.reasons,
      customerCandidate: customerResolution.customer || null,
      customerStatus: customerResolution.status,
      customerMatchSource: customerResolution.matchSource,
      customerCandidates: customerResolution.candidates || [],
      confirmedCustomerId: customerResolution.customer?.customerId || '',
      confirmedCustomerName: customerResolution.customer?.customerName || '',
      parsedLines,
      orderGroup: message.senderNormalized || message.messageId,
      contextIndex: message.contextIndex
    });
  }
  const stored = await persistAnalysis({ sourceType, sourceId, rawText, deviceId }, rows, { forceReanalyze });
  return {
    ...stored,
    summary: summarizeParserResults(stored.results)
  };
}

export function summarizeParserResults(results) {
  const orderMessages = results.filter(result => result.eventType === EVENT_TYPE.ORDER || result.eventType === EVENT_TYPE.ORDER_UPDATE);
  const lines = orderMessages.flatMap(result => result.parsedLines || []);
  return {
    messages: results.length,
    orders: results.filter(result => result.eventType === EVENT_TYPE.ORDER).length,
    updates: results.filter(result => result.eventType === EVENT_TYPE.ORDER_UPDATE).length,
    excludedMessages: results.filter(result => !ORDER_LIKE.has(result.eventType)).length,
    items: lines.filter(line => line.matchStatus !== 'EXCLUDED').length,
    matched: lines.filter(line => line.matchStatus === 'MATCHED').length,
    failed: lines.filter(line => line.matchStatus === 'MATCH_FAILED').length,
    duplicates: results.filter(result => result.duplicate).length
  };
}

