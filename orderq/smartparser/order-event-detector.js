import { parseOrderLines } from './order-line-parser.js?v=0.8.1';

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

  const orderLines = parseOrderLines(text);
  if (orderLines.length) {
    const hasUnitQuantity = orderLines.some(line => line.rawUnit);
    reasons.push(hasUnitQuantity ? 'QUANTITY_WITH_UNIT' : 'PRODUCT_WITH_TERMINAL_QUANTITY');
    if (orderLines.length > 1) reasons.push('MULTIPLE_ORDER_LINES');
    return { eventType: EVENT_TYPE.ORDER, score: hasUnitQuantity ? 0.9 : 0.82, reasons };
  }

  if (/(?:부탁드립니다|참고하세요|확인바랍니다|전달드립니다)/i.test(compact)) {
    return { eventType: EVENT_TYPE.NOTICE, score: 0.7, reasons: ['NOTICE_REQUEST_STYLE'] };
  }
  return { eventType: EVENT_TYPE.UNKNOWN, score: 0.35, reasons: ['INSUFFICIENT_EVIDENCE'] };
}
