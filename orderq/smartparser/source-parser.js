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
