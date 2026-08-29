import { parseSourceInput } from './source-parser.js?v=0.8.1';
import { EVENT_TYPE, detectOrderEvent } from './order-event-detector.js?v=0.8.1';
import { parseOrderLines } from './order-line-parser.js?v=0.8.1';

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
