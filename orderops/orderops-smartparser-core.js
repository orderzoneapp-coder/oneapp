(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OrderOpsSmartParserCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STATUS = Object.freeze({
    CONFIRMED: 'confirmed',
    CANDIDATE: 'candidate',
    UNMAPPED: 'unmapped',
    NEW: 'new',
    ERROR: 'error'
  });

  const STATUS_LABELS = Object.freeze({
    [STATUS.CONFIRMED]: '확정매핑',
    [STATUS.CANDIDATE]: '후보매핑',
    [STATUS.UNMAPPED]: '미매핑',
    [STATUS.NEW]: '신규품목',
    [STATUS.ERROR]: '오류'
  });

  const BLOCKING_STATUSES = new Set([
    STATUS.CANDIDATE,
    STATUS.UNMAPPED,
    STATUS.NEW,
    STATUS.ERROR
  ]);

  const QUANTITY_UNITS = [
    '박스', 'box', 'BOX', '개', 'ea', 'EA', '단', '팩', '봉', '포', '병', '캔',
    '마리', '망', '통', '묶음', '세트', '판', '롤', 'kg', 'KG', 'g', 'G', 'l', 'L', 'ml', 'ML'
  ];

  const SPEC_UNITS = [
    '킬로그램', '키로그람', '키로', '킬로', 'kg', 'KG', '그램', 'g', 'G',
    '밀리리터', '미리', 'ml', 'ML', '리터', 'l', 'L', '톤', 't', 'T',
    '입', '입수', '단', '팩', '봉', '포', '박스', 'BOX', 'box'
  ];

  const HEADER_ALIASES = Object.freeze({
    documentType: ['문서종류', '문서유형', '종류'],
    sourceName: ['문서출처', '출처', '제공자'],
    sourceRole: ['출처역할', '역할'],
    documentDate: ['일자', '날짜', '문서일자'],
    warehouse: ['출하창고', '창고'],
    client: ['거래처', '주문처', '고객'],
    transactionType: ['거래유형', '결제유형'],
    message: ['전하실말씀', '전달사항', '메시지'],
    memo: ['메모', '비고']
  });

  function uid(prefix = 'osp') {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return `${prefix}-${crypto.randomUUID()}`;
    }
    const random = Math.random().toString(36).slice(2);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
  }

  function stringValue(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function normalizeWhitespace(value) {
    return stringValue(value).replace(/\s+/g, ' ').trim();
  }

  function normalizeText(value) {
    return stringValue(value)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/킬로그램|키로그람|킬로|키로/g, 'kg')
      .replace(/그램/g, 'g')
      .replace(/밀리리터|미리/g, 'ml')
      .replace(/리터/g, 'l')
      .replace(/박스/g, 'box')
      .replace(/[^0-9a-z가-힣]/g, '');
  }

  function normalizeCode(value) {
    return stringValue(value).normalize('NFKC').replace(/\s+/g, '').toUpperCase().trim();
  }

  function normalizeUnit(value) {
    const raw = normalizeWhitespace(value).toLowerCase();
    if (!raw) return '';
    const replacements = [
      [/킬로그램|키로그람|킬로|키로|kgs?/g, 'kg'],
      [/그램|gr|g/g, 'g'],
      [/밀리리터|미리|ml/g, 'ml'],
      [/리터|lt|l/g, 'l'],
      [/박스|boxes|box/g, 'box'],
      [/한단/g, '단'],
      [/개|ea/g, 'ea']
    ];
    let valueOut = raw;
    replacements.forEach(([pattern, replacement]) => {
      valueOut = valueOut.replace(pattern, replacement);
    });
    return valueOut.replace(/\s+/g, '');
  }

  function parseNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const raw = stringValue(value).trim();
    if (!raw) return null;
    const cleaned = raw.replace(/,/g, '').replace(/[^0-9.+-]/g, '');
    if (!cleaned || !/[0-9]/.test(cleaned)) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseKoreanNumberToken(value) {
    const raw = stringValue(value)
      .normalize('NFKC')
      .replace(/\s+/g, '')
      .replace(/원/g, '')
      .replace(/,/g, '');
    if (!raw) return null;
    if (/^[+-]?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);

    const digitMap = {
      영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4,
      오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9
    };
    const smallUnitMap = { 십: 10, 백: 100, 천: 1000 };
    let total = 0;
    let section = 0;
    let pending = null;
    let found = false;

    const flushPending = () => {
      if (pending !== null) {
        section += pending;
        pending = null;
      }
    };

    for (let i = 0; i < raw.length; i += 1) {
      const char = raw[i];
      if (/\d/.test(char)) {
        let digits = char;
        while (i + 1 < raw.length && /\d/.test(raw[i + 1])) {
          digits += raw[i + 1];
          i += 1;
        }
        pending = Number(digits);
        found = true;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(digitMap, char)) {
        pending = digitMap[char];
        found = true;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(smallUnitMap, char)) {
        section += (pending === null ? 1 : pending) * smallUnitMap[char];
        pending = null;
        found = true;
        continue;
      }
      if (char === '만') {
        flushPending();
        total += (section || 1) * 10000;
        section = 0;
        found = true;
        continue;
      }
      if (char === '억') {
        flushPending();
        total += (section || 1) * 100000000;
        section = 0;
        found = true;
        continue;
      }
      return null;
    }

    flushPending();
    const result = total + section;
    return found && Number.isFinite(result) ? result : null;
  }

  function extractHeaderLine(line) {
    const match = normalizeWhitespace(line).match(/^([^:=]{1,20})\s*[:=]\s*(.*)$/);
    if (!match) return null;
    const key = normalizeText(match[1]);
    const value = normalizeWhitespace(match[2]);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.some(alias => normalizeText(alias) === key)) {
        return { field, value };
      }
    }
    return null;
  }

  function escapeRegExp(value) {
    return stringValue(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripKnownSourcePrefix(value, context) {
    let line = normalizeWhitespace(value);
    const candidates = [];
    if (context && context.sourceName) candidates.push(context.sourceName);
    if (context && context.client) candidates.push(context.client);
    if (context && Array.isArray(context.knownSources)) candidates.push(...context.knownSources);
    const unique = [...new Set(candidates.map(normalizeWhitespace).filter(Boolean))]
      .sort((a, b) => b.length - a.length);
    for (const source of unique) {
      const pattern = new RegExp(`^${escapeRegExp(source)}(?:\\s+|[-:|/]\\s*)`, 'i');
      if (pattern.test(line)) {
        return { line: line.replace(pattern, '').trim(), detectedSource: source };
      }
    }
    return { line, detectedSource: '' };
  }

  function splitItemSegments(rawLine) {
    const line = normalizeWhitespace(rawLine)
      .replace(/[•·▪◦]/g, ' ')
      .replace(/^\s*[-*]\s*/, '')
      .trim();
    if (!line) return [];

    const splitParts = line.split(/\s*[;|]\s*|\s*\/\s*(?=[가-힣A-Za-z])/).map(normalizeWhitespace).filter(Boolean);
    const explicitSegments = [];
    splitParts.forEach(part => {
      if (/^(?:메모|비고|적요(?:\(직원\))?|공지단가)\s*[:=]/i.test(part) && explicitSegments.length) {
        explicitSegments[explicitSegments.length - 1] += ` | ${part}`;
      } else {
        explicitSegments.push(part);
      }
    });
    if (explicitSegments.length > 1) return explicitSegments;

    // 한 품목에 단가·공급가액·공지단가가 함께 있으면 금액 표현이 여러 개여도 분할하지 않는다.
    if (/(?:공급가액|금액|합계|공지단가)\s*[:=]?/i.test(line)) return [line];

    const pricePattern = /(?:[0-9영공일이삼사오육칠팔구십백천만억,]+(?:\.\d+)?)\s*(?:원|₩)(?=\s|$|[,;/|])/g;
    const matches = [...line.matchAll(pricePattern)];
    if (matches.length <= 1) return [line];

    const segments = [];
    let start = 0;
    matches.forEach(match => {
      const end = (match.index || 0) + match[0].length;
      const segment = normalizeWhitespace(line.slice(start, end).replace(/^[,;/|\s]+/, ''));
      if (segment) segments.push(segment);
      start = end;
    });
    const tail = normalizeWhitespace(line.slice(start).replace(/^[,;/|\s]+/, ''));
    if (tail) segments.push(tail);
    return segments;
  }

  function findMoneyExpressionByLabels(value, labels = []) {
    const line = normalizeWhitespace(value);
    const labelPattern = labels.map(escapeRegExp).join('|');
    if (!labelPattern) return null;
    const pattern = new RegExp(`(?:${labelPattern})\\s*[:=]?\\s*((?:[0-9영공일이삼사오육칠팔구십백천만억,]+(?:\\.\\d+)?)\\s*(?:원|₩)?)`, 'i');
    const match = line.match(pattern);
    if (!match) return null;
    const raw = normalizeWhitespace(match[1]);
    const number = parseKoreanNumberToken(raw);
    if (number === null) return null;
    return { raw, number, index: match.index || 0, full: match[0] };
  }

  function findAmountExpression(value) {
    return findMoneyExpressionByLabels(value, ['공급가액', '공급액', '금액']);
  }

  function findNoticePriceExpression(value) {
    return findMoneyExpressionByLabels(value, ['공지단가']);
  }

  function findDelimitedTextExpression(value, labels = []) {
    const line = normalizeWhitespace(value);
    const labelPattern = labels.map(escapeRegExp).join('|');
    if (!labelPattern) return null;
    const pattern = new RegExp(`(?:^|[|;])\\s*(?:${labelPattern})\\s*[:=]\\s*([^|;]+)`, 'i');
    const match = line.match(pattern);
    if (!match) return null;
    return {
      raw: normalizeWhitespace(match[1]),
      index: match.index || 0,
      full: match[0]
    };
  }

  function findPriceExpression(value) {
    const line = normalizeWhitespace(value);
    const patterns = [
      /(?:단가|가격)\s*[:=]?\s*((?:[0-9영공일이삼사오육칠팔구십백천만억,]+(?:\.\d+)?)\s*(?:원|₩)?)/i,
      /((?:[0-9영공일이삼사오육칠팔구십백천만억,]+(?:\.\d+)?)\s*(?:원|₩))(?=\s*$)/i,
      /((?:\d{1,3}(?:,\d{3})+|\d{3,}|[영공일이삼사오육칠팔구십백천만억]+))(?=\s*$)/i
    ];
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      const raw = normalizeWhitespace(match[1]);
      const number = parseKoreanNumberToken(raw);
      if (number !== null) return { raw, number, index: match.index || 0, full: match[0] };
    }
    return null;
  }

  function findQuantityExpression(value) {
    const line = normalizeWhitespace(value);
    const unitPattern = QUANTITY_UNITS.map(escapeRegExp).join('|');
    const explicit = new RegExp(`(?:수량|qty)\\s*[:=]?\\s*(\\d+(?:\\.\\d+)?)\\s*(${unitPattern})?`, 'i');
    const all = [...line.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${unitPattern})(?=\\s|$|[,;/|])`, 'gi'))];
    const match = line.match(explicit) || (all.length ? all[all.length - 1] : null);
    if (!match) return null;
    const number = parseNumber(match[1]);
    if (number === null) return null;
    return {
      raw: normalizeWhitespace(match[0]),
      number,
      unit: normalizeWhitespace(match[2] || ''),
      index: match.index || 0,
      full: match[0]
    };
  }

  function findSpecExpression(value, quantityExpression) {
    const line = normalizeWhitespace(value);
    const unitPattern = SPEC_UNITS.map(escapeRegExp).join('|');
    const patterns = [
      new RegExp(`(?:규격|스펙)\\s*[:=]?\\s*((?:\\d+(?:\\.\\d+)?|한)\\s*(?:${unitPattern})(?:\\s*[x×*]\\s*\\d+(?:\\.\\d+)?)?)`, 'i'),
      new RegExp(`((?:\\d+(?:\\.\\d+)?|한)\\s*(?:${unitPattern})(?:\\s*[x×*]\\s*\\d+(?:\\.\\d+)?)?)(?=\\s|$|[,;/|])`, 'i')
    ];
    for (const pattern of patterns) {
      const matches = [...line.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
      for (const match of matches) {
        if (quantityExpression && match.index === quantityExpression.index && normalizeText(match[0]) === normalizeText(quantityExpression.full)) {
          continue;
        }
        return {
          raw: normalizeWhitespace(match[1] || match[0]),
          index: match.index || 0,
          full: match[0]
        };
      }
    }
    return null;
  }

  function findCodeExpression(value) {
    const line = normalizeWhitespace(value);
    const explicit = line.match(/(?:품목코드|상품코드|코드|sku)\s*[:=#]?\s*([A-Za-z0-9_-]{3,})/i);
    if (!explicit) return null;
    return {
      raw: explicit[1],
      code: normalizeCode(explicit[1]),
      index: explicit.index || 0,
      full: explicit[0]
    };
  }

  function removeExpression(value, expression) {
    if (!expression || !expression.full) return value;
    const exactIndex = String(value).indexOf(expression.full);
    const index = exactIndex >= 0 ? exactIndex : Math.max(0, expression.index || 0);
    return `${value.slice(0, index)} ${value.slice(index + expression.full.length)}`;
  }

  function parseItemSegment(segment, context = {}) {
    const original = normalizeWhitespace(segment);
    let working = original;
    const validationMessages = [];

    const memoExpression = findDelimitedTextExpression(working, ['메모', '비고']);
    if (memoExpression) working = removeExpression(working, memoExpression);

    const descriptionExpression = findDelimitedTextExpression(working, ['적요(직원)', '적요']);
    if (descriptionExpression) working = removeExpression(working, descriptionExpression);

    const noticePriceExpression = findNoticePriceExpression(working);
    if (noticePriceExpression) working = removeExpression(working, noticePriceExpression);

    const amountExpression = findAmountExpression(working);
    if (amountExpression) working = removeExpression(working, amountExpression);

    const priceExpression = findPriceExpression(working);
    if (priceExpression) working = removeExpression(working, priceExpression);

    const codeExpression = findCodeExpression(working);
    if (codeExpression) working = removeExpression(working, codeExpression);

    const quantityExpression = findQuantityExpression(working);
    if (quantityExpression) working = removeExpression(working, quantityExpression);

    const specExpression = findSpecExpression(working, quantityExpression);
    if (specExpression) working = removeExpression(working, specExpression);

    working = working
      .replace(/(?:품목명|상품명|제품명)\s*[:=]?/gi, ' ')
      .replace(/(?:수량|qty|단가|가격|규격|스펙)\s*[:=]?/gi, ' ')
      .replace(/^[,;/|\s-]+|[,;/|\s-]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    const itemName = working;
    const quantity = quantityExpression ? quantityExpression.number : null;
    const price = priceExpression ? priceExpression.number : null;
    const sourceAmount = amountExpression ? amountExpression.number : null;
    const calculatedAmount = quantity !== null && price !== null ? quantity * price : null;
    const specification = specExpression ? specExpression.raw : '';
    const unit = specification ? normalizeUnit(specification.replace(/[\d.×x*]/gi, '')) : '';

    if (!itemName) validationMessages.push('품목명을 해석하지 못했습니다.');
    if (quantity === null) validationMessages.push('수량을 확인해 주세요.');
    if (quantity !== null && quantity <= 0) validationMessages.push('수량은 0보다 커야 합니다.');
    if (price !== null && price < 0) validationMessages.push('단가는 0 이상이어야 합니다.');
    if (sourceAmount !== null && sourceAmount < 0) validationMessages.push('원본 금액은 0 이상이어야 합니다.');
    if (sourceAmount !== null && calculatedAmount !== null && Math.abs(sourceAmount - calculatedAmount) > 0.5) {
      validationMessages.push('원본 금액과 수량×단가 계산값이 일치하지 않습니다.');
    }

    const sourceItemText = normalizeWhitespace([itemName, specification].filter(Boolean).join(' '));

    return {
      rowId: uid('row'),
      sourceText: original,
      sourceItemText,
      parsed: {
        itemCode: codeExpression ? codeExpression.code : '',
        itemName,
        specification,
        unit,
        quantity,
        quantityUnit: quantityExpression ? quantityExpression.unit : '',
        price,
        sourceAmount,
        calculatedAmount,
        memo: memoExpression ? memoExpression.raw : '',
        description: descriptionExpression ? descriptionExpression.raw : '',
        noticePrice: noticePriceExpression ? noticePriceExpression.number : null
      },
      master: null,
      work: {
        itemCode: '',
        itemName,
        specification,
        unit,
        quantity,
        price,
        memo: memoExpression ? memoExpression.raw : '',
        description: descriptionExpression ? descriptionExpression.raw : '',
        noticePrice: noticePriceExpression ? noticePriceExpression.number : null
      },
      mappingStatus: validationMessages.length ? STATUS.ERROR : STATUS.UNMAPPED,
      mappingConfidence: 0,
      mappingReason: validationMessages.length ? '파싱 오류' : '마스터 매핑 전',
      candidates: [],
      validationMessages,
      mappingOrigin: '',
      userConfirmedMapping: false
    };
  }

  function normalizeDocumentType(value) {
    const raw = normalizeText(value);
    if (raw.includes('구매')) return '구매';
    if (raw.includes('품목')) return '품목정보';
    if (raw.includes('주문')) return '주문';
    return value ? normalizeWhitespace(value) : '주문';
  }

  function parseText(rawText, context = {}) {
    const input = stringValue(rawText);
    const now = new Date().toISOString();
    const document = {
      parserVersion: 'orderops-smartparser-core-v2.2.0',
      documentId: uid('document'),
      inputType: context.inputType || 'text',
      originalInput: input,
      parsedAt: now,
      documentType: normalizeDocumentType(context.documentType || '주문'),
      sourceId: normalizeWhitespace(context.sourceId),
      sourceName: normalizeWhitespace(context.sourceName),
      sourceRole: normalizeWhitespace(context.sourceRole || '주문처'),
      documentDate: normalizeWhitespace(context.documentDate),
      header: {
        warehouse: normalizeWhitespace(context.warehouse),
        client: normalizeWhitespace(context.client),
        transactionType: normalizeWhitespace(context.transactionType),
        message: normalizeWhitespace(context.message),
        memo: normalizeWhitespace(context.memo)
      },
      items: [],
      warnings: []
    };

    const physicalLines = input
      .split(/\r?\n/)
      .map(line => normalizeWhitespace(line))
      .filter(Boolean);

    const itemLines = [];
    physicalLines.forEach(line => {
      const header = extractHeaderLine(line);
      if (header) {
        if (header.field === 'documentType') document.documentType = normalizeDocumentType(header.value);
        else if (header.field === 'sourceName') document.sourceName = header.value;
        else if (header.field === 'sourceRole') document.sourceRole = header.value;
        else if (header.field === 'documentDate') document.documentDate = header.value;
        else if (Object.prototype.hasOwnProperty.call(document.header, header.field)) document.header[header.field] = header.value;
        return;
      }
      itemLines.push(line);
    });

    itemLines.forEach((line, lineIndex) => {
      const stripped = stripKnownSourcePrefix(line, {
        ...context,
        sourceName: document.sourceName,
        client: document.header.client
      });
      if (!document.sourceName && stripped.detectedSource) document.sourceName = stripped.detectedSource;
      const segments = splitItemSegments(stripped.line);
      if (!segments.length) return;
      segments.forEach((segment, segmentIndex) => {
        const item = parseItemSegment(segment, context);
        item.sourceLineIndex = lineIndex;
        item.sourceSegmentIndex = segmentIndex;
        document.items.push(item);
      });
    });

    if (!document.items.length) document.warnings.push('품목 행을 찾지 못했습니다.');
    if (!document.sourceName) document.warnings.push('문서 출처가 지정되지 않았습니다.');
    return document;
  }

  function getMasterCode(rawItem, fallbackKey = '') {
    return normalizeCode(
      rawItem && (rawItem.코드 ?? rawItem.품목코드 ?? rawItem.상품코드 ?? rawItem.itemCode ?? fallbackKey)
    );
  }

  function toMasterRecord(rawItem, fallbackKey = '') {
    const raw = rawItem && typeof rawItem === 'object' ? rawItem : {};
    const code = getMasterCode(raw, fallbackKey);
    return {
      code,
      rawCode: stringValue(raw.코드 ?? raw.품목코드 ?? raw.상품코드 ?? raw.itemCode ?? fallbackKey),
      itemName: normalizeWhitespace(raw.품목명 ?? raw.상품명 ?? raw.제품명 ?? raw.itemName),
      specification: normalizeWhitespace(raw.규격 ?? raw.specification),
      unit: normalizeWhitespace(raw.단위 ?? raw.unit),
      price: parseNumber(raw.출고가 ?? raw.단가 ?? raw.price),
      raw
    };
  }

  function buildMasterIndex(masterInput) {
    const source = Array.isArray(masterInput)
      ? masterInput.map((item, index) => [String(index), item])
      : Object.entries(masterInput && typeof masterInput === 'object' ? masterInput : {});
    const records = [];
    const byCode = new Map();
    const byNameSpecUnit = new Map();
    const byName = new Map();

    source.forEach(([key, rawItem]) => {
      const record = toMasterRecord(rawItem, key);
      if (!record.code || !record.itemName) return;
      records.push(record);
      if (!byCode.has(record.code)) byCode.set(record.code, []);
      byCode.get(record.code).push(record);

      const exactKey = [
        normalizeText(record.itemName),
        normalizeText(record.specification),
        normalizeUnit(record.unit)
      ].join('|');
      if (!byNameSpecUnit.has(exactKey)) byNameSpecUnit.set(exactKey, []);
      byNameSpecUnit.get(exactKey).push(record);

      const nameKey = normalizeText(record.itemName);
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey).push(record);
    });

    return { records, byCode, byNameSpecUnit, byName };
  }

  function buildSourceMappingKey(source, sourceItemText) {
    const sourceId = normalizeText(source && source.sourceId);
    const sourceName = normalizeText(source && source.sourceName);
    const sourceRole = normalizeText(source && source.sourceRole);
    const rawItem = normalizeText(sourceItemText);
    return [sourceId || sourceName || '_unknown_source_', sourceRole || '_unknown_role_', rawItem].join('|');
  }

  function tokenize(value) {
    return normalizeWhitespace(value)
      .toLowerCase()
      .replace(/[^0-9a-z가-힣]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  }

  function similarityScore(item, master) {
    const itemName = normalizeText(item.parsed.itemName);
    const masterName = normalizeText(master.itemName);
    if (!itemName || !masterName) return 0;
    let score = 0;
    if (itemName === masterName) score += 0.72;
    else if (itemName.includes(masterName) || masterName.includes(itemName)) score += 0.5;

    const itemTokens = new Set(tokenize(item.parsed.itemName));
    const masterTokens = new Set(tokenize(master.itemName));
    if (itemTokens.size && masterTokens.size) {
      let intersection = 0;
      itemTokens.forEach(token => {
        if (masterTokens.has(token)) intersection += 1;
      });
      const union = new Set([...itemTokens, ...masterTokens]).size;
      score += union ? (intersection / union) * 0.35 : 0;
    }

    const itemSpec = normalizeText(item.parsed.specification);
    const masterSpec = normalizeText(master.specification);
    if (itemSpec && masterSpec) {
      if (itemSpec === masterSpec) score += 0.2;
      else if (itemSpec.includes(masterSpec) || masterSpec.includes(itemSpec)) score += 0.08;
      else score -= 0.12;
    }

    const itemUnit = normalizeUnit(item.parsed.unit);
    const masterUnit = normalizeUnit(master.unit);
    if (itemUnit && masterUnit) score += itemUnit === masterUnit ? 0.08 : -0.05;
    return Math.max(0, Math.min(1, score));
  }

  function searchCandidates(item, masterIndex, limit = 8) {
    return masterIndex.records
      .map(record => ({ ...record, score: similarityScore(item, record) }))
      .filter(record => record.score >= 0.35)
      .sort((a, b) => b.score - a.score || a.itemName.localeCompare(b.itemName, 'ko'))
      .slice(0, Math.max(1, limit));
  }

  function applyMasterToItem(item, master, options = {}) {
    const mapped = {
      code: master.code,
      itemName: master.itemName,
      specification: master.specification,
      unit: master.unit,
      price: master.price,
      raw: master.raw
    };
    const keepParsedPrice = options.keepParsedPrice !== false;
    return {
      ...item,
      master: mapped,
      work: {
        ...item.work,
        itemCode: mapped.code,
        itemName: mapped.itemName,
        specification: mapped.specification,
        unit: mapped.unit,
        quantity: item.work && item.work.quantity !== null && item.work.quantity !== ''
          ? item.work.quantity
          : item.parsed.quantity,
        price: item.work && item.work.price !== null && item.work.price !== ''
          ? item.work.price
          : (keepParsedPrice && item.parsed.price !== null ? item.parsed.price : mapped.price),
        memo: item.work && item.work.memo ? item.work.memo : (item.parsed.memo || '')
      }
    };
  }

  function setMatch(item, master, status, confidence, reason, origin, candidates = []) {
    const applied = master ? applyMasterToItem(item, master) : { ...item };
    return {
      ...applied,
      mappingStatus: status,
      mappingConfidence: confidence,
      mappingReason: reason,
      mappingOrigin: origin,
      candidates,
      userConfirmedMapping: origin === 'user'
    };
  }

  function matchItem(item, document, masterIndex, sourceMappings = {}) {
    if (!item || item.validationMessages.length) return item;

    const parsedCode = normalizeCode(item.parsed.itemCode);
    if (parsedCode) {
      const codeMatches = masterIndex.byCode.get(parsedCode) || [];
      if (codeMatches.length === 1) {
        return setMatch(item, codeMatches[0], STATUS.CONFIRMED, 1, '품목코드 완전 일치', 'code');
      }
      if (codeMatches.length > 1) {
        return setMatch(item, null, STATUS.CANDIDATE, 0.98, '동일 품목코드 후보가 여러 개입니다.', 'code', codeMatches);
      }
    }

    const mappingKey = buildSourceMappingKey(document, item.sourceItemText);
    const saved = sourceMappings && sourceMappings[mappingKey];
    if (saved && saved.masterItemCode) {
      const mappedCode = normalizeCode(saved.masterItemCode);
      const mapped = masterIndex.byCode.get(mappedCode) || [];
      if (mapped.length === 1) {
        return setMatch(item, mapped[0], STATUS.CONFIRMED, 1, '기존 출처별 품목 매핑', 'source-mapping');
      }
    }

    const exactKey = [
      normalizeText(item.parsed.itemName),
      normalizeText(item.parsed.specification),
      normalizeUnit(item.parsed.unit)
    ].join('|');
    const exactMatches = masterIndex.byNameSpecUnit.get(exactKey) || [];
    if (exactMatches.length === 1) {
      return setMatch(item, exactMatches[0], STATUS.CONFIRMED, 0.98, '상품명·규격·단위 정확 일치', 'exact');
    }
    if (exactMatches.length > 1) {
      return setMatch(item, null, STATUS.CANDIDATE, 0.95, '정확 일치 후보가 여러 개입니다.', 'exact', exactMatches);
    }

    const nameMatches = masterIndex.byName.get(normalizeText(item.parsed.itemName)) || [];
    if (nameMatches.length === 1) {
      return setMatch(item, nameMatches[0], STATUS.CONFIRMED, 0.9, '정규화된 상품명 일치', 'normalized-name');
    }
    if (nameMatches.length > 1) {
      return setMatch(item, null, STATUS.CANDIDATE, 0.82, '같은 상품명의 규격 후보가 여러 개입니다.', 'normalized-name', nameMatches);
    }

    const candidates = searchCandidates(item, masterIndex);
    if (candidates.length) {
      return setMatch(item, null, STATUS.CANDIDATE, candidates[0].score, '유사 상품 후보를 확인해 주세요.', 'fuzzy', candidates);
    }

    return {
      ...item,
      mappingStatus: STATUS.UNMAPPED,
      mappingConfidence: 0,
      mappingReason: '적절한 마스터 품목을 찾지 못했습니다.',
      mappingOrigin: '',
      candidates: []
    };
  }

  function matchDocument(document, masterInput, sourceMappings = {}) {
    const masterIndex = buildMasterIndex(masterInput);
    const items = (document.items || []).map(item => matchItem(item, document, masterIndex, sourceMappings));
    return { ...document, items, masterCount: masterIndex.records.length };
  }

  function chooseMaster(document, rowId, masterCode, masterInput, origin = 'user') {
    const masterIndex = buildMasterIndex(masterInput);
    const matches = masterIndex.byCode.get(normalizeCode(masterCode)) || [];
    if (matches.length !== 1) {
      throw new Error(matches.length > 1 ? '같은 코드의 마스터 후보가 여러 개입니다.' : '선택한 마스터 품목을 찾을 수 없습니다.');
    }
    const items = (document.items || []).map(item => {
      if (item.rowId !== rowId) return item;
      const selected = setMatch(item, matches[0], STATUS.CONFIRMED, 1, '사용자 확정 매핑', origin);
      return { ...selected, userConfirmedMapping: true };
    });
    return { ...document, items };
  }

  function updateItemWork(document, rowId, patch) {
    const items = (document.items || []).map(item => {
      if (item.rowId !== rowId) return item;
      const work = { ...item.work, ...(patch || {}) };
      const validationMessages = (item.validationMessages || []).filter(message =>
        !['품목명을 해석하지 못했습니다.', '수량을 확인해 주세요.', '수량은 0보다 커야 합니다.', '단가는 0 이상이어야 합니다.'].includes(message)
      );
      if (!normalizeWhitespace(work.itemName)) validationMessages.push('품목명을 확인해 주세요.');
      const quantity = parseNumber(work.quantity);
      if (quantity === null) validationMessages.push('수량을 확인해 주세요.');
      else if (quantity <= 0) validationMessages.push('수량은 0보다 커야 합니다.');
      const price = work.price === '' || work.price === null ? null : parseNumber(work.price);
      if (work.price !== '' && work.price !== null && price === null) validationMessages.push('단가를 확인해 주세요.');
      else if (price !== null && price < 0) validationMessages.push('단가는 0 이상이어야 합니다.');
      const recoveredStatus = item.mappingStatus === STATUS.ERROR
        ? (item.master ? STATUS.CONFIRMED : STATUS.UNMAPPED)
        : item.mappingStatus;
      const mappingStatus = validationMessages.length ? STATUS.ERROR : recoveredStatus;
      return {
        ...item,
        work: { ...work, quantity, price },
        validationMessages,
        mappingStatus,
        mappingReason: validationMessages.length
          ? '작업값 오류'
          : (recoveredStatus === STATUS.UNMAPPED ? '마스터 매핑이 필요합니다.' : item.mappingReason)
      };
    });
    return { ...document, items };
  }

  function markAsNew(document, rowId) {
    const items = (document.items || []).map(item => item.rowId === rowId ? {
      ...item,
      master: null,
      work: { ...item.work, itemCode: '' },
      mappingStatus: STATUS.NEW,
      mappingConfidence: 0,
      mappingReason: '신규상품 작업 대상으로 지정되었습니다.',
      mappingOrigin: 'user-new',
      userConfirmedMapping: true
    } : item);
    return { ...document, items };
  }

  function validateDocument(document) {
    const issues = [];
    const items = Array.isArray(document && document.items) ? document.items : [];
    if (!items.length) issues.push({ type: 'document', message: '적용할 품목이 없습니다.' });
    items.forEach((item, index) => {
      const messages = [...(item.validationMessages || [])];
      if (BLOCKING_STATUSES.has(item.mappingStatus)) {
        messages.push(`${STATUS_LABELS[item.mappingStatus] || item.mappingStatus} 상태를 해결해 주세요.`);
      }
      if (!item.work || !normalizeCode(item.work.itemCode)) messages.push('필수 품목코드가 없습니다.');
      const quantity = item.work ? parseNumber(item.work.quantity) : null;
      if (quantity === null || quantity <= 0) messages.push('수량을 확인해 주세요.');
      [...new Set(messages)].forEach(message => issues.push({
        type: 'item',
        rowId: item.rowId,
        rowNumber: index + 1,
        message
      }));
    });
    return { valid: issues.length === 0, issues };
  }

  function summarize(document) {
    const counts = {
      total: 0,
      confirmed: 0,
      candidate: 0,
      unmapped: 0,
      new: 0,
      error: 0,
      blocking: 0
    };
    (document && Array.isArray(document.items) ? document.items : []).forEach(item => {
      counts.total += 1;
      if (Object.prototype.hasOwnProperty.call(counts, item.mappingStatus)) counts[item.mappingStatus] += 1;
      if (BLOCKING_STATUSES.has(item.mappingStatus) || (item.validationMessages || []).length) counts.blocking += 1;
    });
    return counts;
  }

  function buildOrderOpsPayload(document) {
    const validation = validateDocument(document);
    if (!validation.valid) {
      const error = new Error(validation.issues.slice(0, 5).map(issue => issue.message).join('\n'));
      error.code = 'ORDEROPS_SMARTPARSER_VALIDATION_FAILED';
      error.issues = validation.issues;
      throw error;
    }
    return {
      documentId: document.documentId,
      inputType: document.inputType,
      source: {
        sourceId: document.sourceId || '',
        sourceName: document.sourceName || '',
        sourceRole: document.sourceRole || ''
      },
      header: {
        documentDate: document.documentDate || '',
        warehouse: document.header && document.header.warehouse || '',
        client: document.header && document.header.client || '',
        transactionType: document.header && document.header.transactionType || '',
        message: document.header && document.header.message || ''
      },
      items: document.items.map(item => ({
        sourceText: item.sourceText,
        sourceItemText: item.sourceItemText,
        itemCode: normalizeCode(item.work.itemCode),
        itemName: normalizeWhitespace(item.work.itemName),
        specification: normalizeWhitespace(item.work.specification),
        unit: normalizeWhitespace(item.work.unit),
        quantity: parseNumber(item.work.quantity),
        price: item.work.price === '' || item.work.price === null ? null : parseNumber(item.work.price),
        memo: normalizeWhitespace(item.work.memo),
        description: normalizeWhitespace(item.work.description),
        noticePrice: item.work.noticePrice === '' || item.work.noticePrice === null ? null : parseNumber(item.work.noticePrice),
        sourceAmount: item.parsed && item.parsed.sourceAmount !== null ? parseNumber(item.parsed.sourceAmount) : null,
        calculatedAmount: item.work && item.work.quantity !== null && item.work.price !== null
          ? parseNumber(item.work.quantity) * parseNumber(item.work.price)
          : null,
        mappingStatus: item.mappingStatus,
        mappingConfidence: item.mappingConfidence,
        mappingOrigin: item.mappingOrigin,
        userConfirmedMapping: !!item.userConfirmedMapping
      }))
    };
  }

  function collectSourceMappings(document, existingMappings = {}, actor = '') {
    const next = { ...(existingMappings || {}) };
    const hasSource = !!normalizeWhitespace(document.sourceId || document.sourceName);
    if (!hasSource) return next;
    (document.items || []).forEach(item => {
      if (!item.userConfirmedMapping || !item.master || !item.master.code) return;
      const key = buildSourceMappingKey(document, item.sourceItemText);
      next[key] = {
        sourceId: document.sourceId || '',
        sourceName: document.sourceName || '',
        sourceRole: document.sourceRole || '',
        rawItemText: item.sourceItemText || '',
        normalizedItemText: normalizeText(item.sourceItemText),
        masterItemCode: item.master.code,
        masterItemName: item.master.itemName,
        confirmedBy: actor || '',
        confirmedAt: new Date().toISOString(),
        active: true,
        version: 1
      };
    });
    return next;
  }

  return Object.freeze({
    STATUS,
    STATUS_LABELS,
    BLOCKING_STATUSES,
    uid,
    normalizeWhitespace,
    normalizeText,
    normalizeCode,
    normalizeUnit,
    parseNumber,
    parseKoreanNumberToken,
    splitItemSegments,
    findAmountExpression,
    findNoticePriceExpression,
    parseItemSegment,
    parseText,
    buildMasterIndex,
    buildSourceMappingKey,
    searchCandidates,
    matchDocument,
    chooseMaster,
    updateItemWork,
    markAsNew,
    validateDocument,
    summarize,
    buildOrderOpsPayload,
    collectSourceMappings
  });
});
