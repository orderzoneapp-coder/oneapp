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

