const CHECK_HEADERS = Object.freeze(['그룹', '거래처', '품목코드', '품명', '수량', '확인사항']);
const SALES_HEADERS = Object.freeze([
  '일자', '순번', '거래처코드', '거래처명', '출하창고', '거래유형', '전잔액', '전달사항',
  '품목코드', '품목명', '규격', '수량', '단가', '외화금액', '공급가액', '적요', '출고지시',
  '공지', '구매처', '날짜', '구매'
]);
const OUTBOUND_HEADERS = Object.freeze(SALES_HEADERS.slice(0, 12));
const PURCHASE_HEADERS = Object.freeze(SALES_HEADERS.slice(0, 20));
const PREVIEW_HEADERS = Object.freeze([
  '일자', '거래처명', 'no.', '품목코드', '품명', '수량', '단가', '공급가', '적요',
  '출고지시', '출고가 (공지)', '구매처', '구매', '구매합계', '정리', '정산', '수수료'
]);
const SETTINGS_HEADERS = Object.freeze([
  '거래처명', '단가그룹', '단가적용순서', '수수료모드', '수익모드',
  '출력거래처명모드', '설정출처', '정확일치'
]);
const PURCHASE_UPLOAD_HEADERS = Object.freeze([
  '일자', '순번', '거래처코드', '거래처명', '입고창고', '거래유형', '전잔액', '전달사항',
  '코드', '품명', '규격(기본)', '수량', '단가', '외화금액', '공급가', '간단설명(품위)',
  '지시사항', '출고가 (공지)', '판매', 'no.'
]);

const SALES_WIDTHS = Object.freeze([10, 8, 12, 16, 8, 10, 10, 14, 14, 34, 14, 10, 12, 10, 14, 18, 18, 12, 18, 10, 12]);
const OUTBOUND_WIDTHS = Object.freeze([10, 8, 12, 16, 8, 10, 10, 20, 14, 34, 18, 10]);
const PURCHASE_WIDTHS = Object.freeze([10, 8, 12, 16, 8, 10, 10, 20, 14, 34, 18, 10, 12, 10, 14, 18, 18, 12, 18, 10]);
const PREVIEW_WIDTHS = Object.freeze([16, 14, 14, 14, 34, 9, 10, 12, 14, 14, 14, 18, 10, 12, 10, 12, 10]);
const CHECK_WIDTHS = Object.freeze([14, 16, 14, 34, 10, 42]);
const PURCHASE_UPLOAD_WIDTHS = Object.freeze([10, 8, 14, 18, 10, 10, 12, 20, 14, 34, 16, 10, 12, 12, 14, 20, 18, 14, 10, 10]);

const GROUP_PRESETS = Object.freeze([
  Object.freeze({
    groupName: '청과상장',
    customers: Object.freeze(['1마산', '2중앙']),
    rule: Object.freeze(['출고가(공지)', '청과', '도매A/0.91', '상장가']),
    feeMode: 'LISTING_FEE', profitMode: 'NORMAL', outputCustomerMode: 'GROUP_NAME'
  }),
  Object.freeze({
    groupName: '식자재',
    customers: Object.freeze(['4연산', '5온산', '6진주', '7초전', '7남해', '8통영', '9구미']),
    rule: Object.freeze(['출고가(공지)', '식자재', '도매A', '출고(외노)']),
    feeMode: 'NONE', profitMode: 'NORMAL', outputCustomerMode: 'ORIGINAL_CUSTOMER'
  }),
  Object.freeze({
    groupName: '창고출고',
    customers: Object.freeze([
      '9부산', '금양', '상남식자재', '삼진', '진영상회',
      '농협114번', '농협123번', '농협12번', '농협15번', '농협19번', '농협30번', '농협33번',
      '농협35번', '농협37번', '농협38번', '농협44번', '농협45번', '농협62번', '농협65번',
      '농협666', '농협67', '농협67번', '농협69번', '농협6번', '농협70번', '농협77번',
      '농협78번', '농협81번', '농협888번', '농협89번', '창원100번', '창원118번', '창원153번',
      '창원24번', '창원38번', '창원39번', '창원48번', '창원56번', '창원59번', '창원88번',
      '대구구매', '마산구매', '부산현금', '현금구매', '현금판매'
    ]),
    rule: Object.freeze(['출고가(공지)', '도매A', '출고(외노)']),
    feeMode: 'NONE', profitMode: 'NORMAL', outputCustomerMode: 'ORIGINAL_CUSTOMER'
  }),
  Object.freeze({
    groupName: '내부이동',
    customers: Object.freeze(['3우리']),
    rule: Object.freeze(['단가']),
    feeMode: 'NONE', profitMode: 'ZERO_PROFIT', outputCustomerMode: 'GROUP_NAME'
  })
]);

const SUMMARY_TOKENS = Object.freeze(['총합계', '총계', '합계', '소계', '월계', '일계', 'subtotal', 'total']);

function text(value, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).trim() || fallback;
}

function normalizedHeader(value) {
  return text(value).normalize('NFKC').replace(/\s/g, '').toLowerCase();
}

function strictNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const source = text(value).replace(/,/g, '');
  if (!source || !/^-?\d+(?:\.\d+)?$/.test(source)) return 0;
  const parsed = Number(source);
  return Number.isFinite(parsed) ? parsed : 0;
}

function quantityValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const source = text(value).replace(/,/g, '');
  if (!source) return 0;
  const wrappedNegative = source.startsWith('(') && source.endsWith(')');
  const numericText = wrappedNegative ? source.slice(1, -1) : source;
  const parsed = Number(numericText);
  if (!Number.isFinite(parsed)) return 0;
  return wrappedNegative ? -parsed : parsed;
}

function rawCell(raw = {}, aliases = [], { allowBlank = false } = {}) {
  const keys = Object.keys(raw || {});
  for (const alias of aliases) {
    const target = normalizedHeader(alias);
    const found = keys.find(key => normalizedHeader(key) === target);
    if (found === undefined) continue;
    const value = raw[found];
    if (allowBlank || (value !== undefined && value !== null && text(value) !== '')) return value;
  }
  return null;
}

function transferRawValue(raw = {}, columnName = '') {
  const target = normalizedHeader(columnName);
  const keys = Object.keys(raw || {});
  if (!target) return null;
  if (target === normalizedHeader('청과')) {
    const duplicated = keys.find(key => ['청과_1', '청과.1'].includes(normalizedHeader(key)));
    if (duplicated !== undefined) return raw[duplicated];
    const exact = keys.find(key => normalizedHeader(key) === target);
    return exact !== undefined && strictNumber(raw[exact]) > 0 ? raw[exact] : null;
  }
  if (target === normalizedHeader('출고가(공지)')) {
    const found = keys.find(key => ['출고가(공지)', '출고가 （공지）'].some(alias => normalizedHeader(key) === normalizedHeader(alias)));
    return found === undefined ? null : raw[found];
  }
  const exact = keys.find(key => normalizedHeader(key) === target);
  return exact === undefined ? null : raw[exact];
}

function priceByKey(raw = {}, priceKey = '') {
  const aliases = {
    '출고가(공지)': ['출고가(공지)', '출고가 (공지)'],
    '청과': ['청과'],
    '상장가': ['상장가'],
    '출고(외노)': ['출고(외노)'],
    '식자재': ['식자재'],
    '도매A': ['도매A'],
    '단가': ['단가', '입고가', '매입단가']
  };
  for (const column of aliases[priceKey] || [priceKey]) {
    const price = strictNumber(transferRawValue(raw, column));
    if (price > 0) return { price, columnName: column };
  }
  return { price: 0, columnName: '' };
}

function priceGroups() {
  const groups = new Map();
  GROUP_PRESETS.forEach(preset => preset.customers.forEach(customer => groups.set(customer, {
    customer, groupName: preset.groupName, rule: [...preset.rule], feeMode: preset.feeMode,
    profitMode: preset.profitMode, outputCustomerMode: preset.outputCustomerMode
  })));
  return groups;
}

function baseFields(input = {}) {
  const raw = input?._raw && typeof input._raw === 'object' ? input._raw : input;
  const code = text(rawCell(raw, ['품목코드', '상품코드', '코드'])).replace(/\.0$/, '').trim();
  const name = text(rawCell(raw, ['품목명(규격)', '품명', '품목명', '상품명']));
  const groupCustomer = text(rawCell(raw, ['거래처', '거래처명']));
  let detailCustomer = text(rawCell(raw, ['거래처명']));
  if (!detailCustomer) {
    const legacyCheonggwa = rawCell(raw, ['청과']);
    if (legacyCheonggwa !== null && strictNumber(legacyCheonggwa) <= 0) detailCustomer = text(legacyCheonggwa);
  }
  const spec = text(rawCell(raw, ['거래처명', '규격', '규격명', '포장규격', '상품규격', '옵션', '사이즈'])) || detailCustomer;
  const quantityKeys = Object.keys(raw || {}).filter(key => ['수량', '입고수량', '구매수량', '매입수량'].some(alias => normalizedHeader(key) === normalizedHeader(alias)));
  const populatedQuantityKey = quantityKeys.find(key => raw[key] !== undefined && raw[key] !== null && text(raw[key]) !== '');
  const qtyRaw = populatedQuantityKey !== undefined ? raw[populatedQuantityKey] : (quantityKeys.length ? raw[quantityKeys[0]] : undefined);
  const qtyMissing = qtyRaw === undefined || qtyRaw === null || text(qtyRaw) === '';
  let qtyInvalid = false;
  if (!qtyMissing) {
    if (typeof qtyRaw === 'number') qtyInvalid = !Number.isFinite(qtyRaw);
    else {
      const source = text(qtyRaw).replace(/,/g, '');
      const wrappedNegative = source.startsWith('(') && source.endsWith(')');
      const numericText = wrappedNegative ? source.slice(1, -1) : source;
      qtyInvalid = (!wrappedNegative && (source.startsWith('(') || source.endsWith(')')))
        || !/^[+-]?\d+(?:\.\d+)?$/.test(numericText);
    }
  }
  const qty = qtyMissing || qtyInvalid ? 0 : quantityValue(qtyRaw);
  const cost = strictNumber(transferRawValue(raw, '단가'))
    || strictNumber(transferRawValue(raw, '입고가'))
    || strictNumber(rawCell(raw, ['매입단가']));
  return {
    raw, code, name, groupCustomer, detailCustomer, spec, qty, qtyRaw, qtyMissing, qtyInvalid,
    dateValue: text(rawCell(raw, ['일자', '날짜', '매입일자'])),
    purchaseVendor: text(rawCell(raw, ['구매처', '원구매처', '매입처'])),
    cost,
    wholesaleA: strictNumber(transferRawValue(raw, '도매A')),
    memo: text(rawCell(raw, ['적요', '비고'])),
    orderNote: text(rawCell(raw, ['출고지시'])),
    deliveryMessage: text(rawCell(raw, ['전달사항', '전달 사항', '메모', '비고'])),
    notice: transferRawValue(raw, '출고가(공지)')
  };
}

function exactSummaryToken(value) {
  return SUMMARY_TOKENS.includes(text(value).replace(/\s/g, '').toLowerCase());
}

function summaryLike(fields) {
  const { raw, code, name, groupCustomer, detailCustomer } = fields;
  const codeNormalized = text(code).replace(/\s/g, '').toLowerCase();
  const nameNormalized = text(name).replace(/\s/g, '').toLowerCase();
  const noRealCode = !codeNormalized || ['no_code', '-', '미상', '없음'].includes(codeNormalized);
  if ([groupCustomer, detailCustomer, code, name].some(exactSummaryToken)) return true;
  if (noRealCode && [rawCell(raw, ['거래처', '거래처명', '매입처', '구매처', '판매처'])].some(exactSummaryToken)) return true;
  if (noRealCode && (/^[+-]?[\d,.]+$/.test(nameNormalized) || ['', '이름없음', '미상', '기록없음'].includes(nameNormalized))) return true;
  return /^[+-]?[\d,.]+$/.test(nameNormalized) && codeNormalized && codeNormalized === nameNormalized;
}

function resolvePrice(fields, group) {
  if (!group) return { status: 'CUSTOMER_GROUP_MISSING', price: 0, priceKey: '', groupName: '', feeMode: 'NONE', profitMode: 'NORMAL', outputCustomerMode: 'GROUP_NAME' };
  if (group.groupName === '청과상장') {
    const notice = priceByKey(fields.raw, '출고가(공지)');
    if (notice.price > 0) return { status: 'MATCHED', ...notice, priceKey: '출고가(공지)', ...group };
    const cheonggwa = priceByKey(fields.raw, '청과');
    if (cheonggwa.price > 0) return { status: 'MATCHED', ...cheonggwa, priceKey: '청과', ...group };
    if (fields.wholesaleA > 0) return {
      status: 'MATCHED', price: Math.round((fields.wholesaleA / 0.91) / 100) * 100,
      priceKey: '도매A/0.91', columnName: '도매A / 0.91 / 100단위 반올림', ...group
    };
    const listing = priceByKey(fields.raw, '상장가');
    if (listing.price > 0) return { status: 'MATCHED', ...listing, priceKey: '상장가', ...group };
    return { status: 'PRICE_MISSING', price: 0, priceKey: '', columnName: '', ...group };
  }
  for (const priceKey of group.rule) {
    const found = priceByKey(fields.raw, priceKey);
    if (found.price > 0) return { status: 'MATCHED', ...found, priceKey, ...group };
  }
  return { status: 'PRICE_MISSING', price: 0, priceKey: '', columnName: '', ...group };
}

function missingPriceReason(groupName = '') {
  if (groupName === '청과상장') return '청과상장 판매단가 없음(청과/도매A/상장가)';
  if (groupName === '식자재') return '식자재 판매단가 없음(식자재/도매A/출고(외노))';
  if (groupName === '창고출고') return '창고출고 판매단가 없음(도매A/출고(외노))';
  if (groupName === '내부이동') return '내부이동 입고가 없음';
  return '판매단가 기준 없음';
}

function outputCustomer(fields, resolved) {
  return resolved.outputCustomerMode === 'ORIGINAL_CUSTOMER'
    ? text(fields.detailCustomer || fields.groupCustomer)
    : text(fields.groupCustomer || resolved.groupName);
}

function money(value) {
  return Number(value || 0).toLocaleString('ko-KR');
}

function rowValues(row, headers) {
  return headers.map(header => row?.[header] ?? '');
}

function wooriVendor(value) {
  return ['우리농산', '우리', '3우리'].includes(text(value).replace(/\s/g, ''));
}

function previewDate(value, now) {
  const source = text(value);
  const year = now.getFullYear();
  if (!source) return `${year}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const numbers = source.match(/\d+/g) || [];
  if (numbers.length >= 3) {
    const normalizedYear = numbers[0].length === 2 ? `20${numbers[0]}` : numbers[0];
    return `${normalizedYear}/${numbers[1].padStart(2, '0')}/${numbers[2].padStart(2, '0')}`;
  }
  if (numbers.length === 2) return `${year}/${numbers[0].padStart(2, '0')}/${numbers[1].padStart(2, '0')}`;
  return source;
}

function purchaseSequence(raw = {}) {
  const explicit = rawCell(raw, ['순번', 'No.', '번호']);
  if (explicit !== null) return explicit;
  const dateNo = text(rawCell(raw, ['일자-No.', '일자-No', '일자No']));
  const match = dateNo.match(/-\s*([^\s-]+)\s*$/);
  return match?.[1] || '';
}

function purchaseUploadRow(fields) {
  const raw = fields.raw || {};
  const rawSupply = rawCell(raw, ['공급가', '공급가액', '합계'], { allowBlank: true });
  const supply = rawSupply === null || text(rawSupply) === ''
    ? fields.qty * fields.cost
    : quantityValue(rawSupply);
  return [
    fields.dateValue,
    purchaseSequence(raw),
    rawCell(raw, ['거래처코드', '구매처코드'], { allowBlank: true }) ?? '',
    rawCell(raw, ['거래처명', '매입처명'], { allowBlank: true }) ?? fields.groupCustomer,
    rawCell(raw, ['입고창고', '창고코드', '창고'], { allowBlank: true }) ?? '',
    rawCell(raw, ['거래유형'], { allowBlank: true }) ?? '',
    rawCell(raw, ['전잔액'], { allowBlank: true }) ?? '',
    fields.deliveryMessage || fields.memo,
    fields.code,
    rawCell(raw, ['품명', '품목명', '상품명'], { allowBlank: true }) ?? fields.name,
    rawCell(raw, ['규격(기본)', '규격', '규격명', '포장규격', '상품규격'], { allowBlank: true }) ?? fields.spec,
    fields.qty,
    fields.cost,
    rawCell(raw, ['외화금액'], { allowBlank: true }) ?? '',
    supply,
    rawCell(raw, ['간단설명(품위)', '간단설명', '품위'], { allowBlank: true }) ?? '',
    rawCell(raw, ['지시사항', '출고지시'], { allowBlank: true }) ?? fields.orderNote,
    fields.notice ?? '',
    rawCell(raw, ['판매'], { allowBlank: true }) ?? '',
    rawCell(raw, ['no.', 'no', 'No.'], { allowBlank: true }) ?? ''
  ];
}

export function buildPurchaseSalesUploadData(sourceRows = [], { now = new Date() } = {}) {
  const groups = priceGroups();
  const rows = [];
  const purchaseUploadRows = [];
  const fatalErrors = [];
  const warnings = [];

  (Array.isArray(sourceRows) ? sourceRows : []).forEach((input, index) => {
    const fields = baseFields(input);
    if (summaryLike(fields)) return;
    const rowBase = {
      rowNo: index + 1, customer: fields.groupCustomer, spec: fields.spec,
      outputCustomer: fields.detailCustomer || fields.groupCustomer,
      code: fields.code, name: fields.name, qty: fields.qty
    };
    const fatalReasons = [];
    if (!text(fields.groupCustomer || fields.detailCustomer)) fatalReasons.push('거래처명 없음');
    if (!fields.code) fatalReasons.push('품목코드 없음');
    if (fields.qtyInvalid) fatalReasons.push('수량 형식 확인');
    if (fatalReasons.length) {
      fatalErrors.push({ ...rowBase, reason: fatalReasons.join(', '), level: '업로드불가' });
      return;
    }
    purchaseUploadRows.push(purchaseUploadRow(fields));

    const zeroQuantity = Number(fields.qty) === 0;
    const group = groups.get(fields.groupCustomer);
    const resolved = zeroQuantity
      ? {
        status: 'ZERO_QUANTITY', price: 0, priceKey: '', columnName: '',
        groupName: group?.groupName || '', feeMode: group?.feeMode || 'NONE',
        profitMode: group?.profitMode || 'NORMAL', outputCustomerMode: group?.outputCustomerMode || 'GROUP_NAME',
        rule: group?.rule || []
      }
      : resolvePrice(fields, group);
    const customer = outputCustomer(fields, resolved) || fields.detailCustomer || fields.groupCustomer;
    const reasons = [];
    if (zeroQuantity) reasons.push('수량 없음/0: 수량 0, 판매가 0으로 업로드');
    else {
      if (resolved.status === 'CUSTOMER_GROUP_MISSING') reasons.push('거래처 단가그룹 없음');
      if (resolved.status === 'PRICE_MISSING') reasons.push(missingPriceReason(resolved.groupName));
    }
    if (!fields.name) reasons.push('품명 없음');
    const price = zeroQuantity ? 0 : (resolved.status === 'MATCHED' ? strictNumber(resolved.price) : '');
    if (!zeroQuantity) {
      if (price !== '' && price > 0 && fields.cost > 0 && price < fields.cost) {
        reasons.push(`역마진/입고가초과: 입고가 ${money(fields.cost)} > 판매가 ${money(price)} (${resolved.priceKey || resolved.columnName || '판매가'})`);
      }
      if (fields.cost > 0 && fields.wholesaleA > 0) {
        if (fields.wholesaleA < fields.cost && !reasons.some(reason => reason.includes('역마진/입고가초과'))) {
          reasons.push(`역마진/입고가초과: 입고가 ${money(fields.cost)} > 도매A ${money(fields.wholesaleA)}`);
        }
        if (fields.wholesaleA >= fields.cost * 4) {
          reasons.push(`도매A과대의심: 입고가 ${money(fields.cost)} / 도매A ${money(fields.wholesaleA)} (${(fields.wholesaleA / fields.cost).toFixed(1)}배, 수기입력 오류 확인)`);
        }
      }
    }
    if (reasons.length) warnings.push({ ...rowBase, outputCustomer: customer, reason: reasons.join(', '), groupName: resolved.groupName || '' });
    const supply = zeroQuantity ? 0 : (price === '' ? '' : fields.qty * price);
    rows.push({
      '일자': '', '순번': '', '거래처코드': '', '거래처명': customer, '출하창고': '02',
      '거래유형': '', '전잔액': '', '전달사항': fields.deliveryMessage || '', '품목코드': fields.code,
      '품목명': fields.name, '규격': fields.spec, '수량': fields.qty, '단가': price, '외화금액': '',
      '공급가액': supply, '적요': fields.memo, '출고지시': fields.orderNote, '공지': text(fields.notice),
      '구매처': fields.purchaseVendor, '날짜': fields.dateValue, '구매': fields.cost,
      '_적용그룹': resolved.groupName || '', '_구매처보정전': fields.purchaseVendor
    });
  });

  rows.sort((left, right) => text(left['거래처명']).localeCompare(text(right['거래처명']), 'ko')
    || text(left['규격']).localeCompare(text(right['규격']), 'ko')
    || text(left['품목코드']).localeCompare(text(right['품목코드']), 'ko'));

  const outboundRows = rows.filter(row => wooriVendor(row['_구매처보정전'] || row['구매처'])).map(row => ({
    ...row, '일자': '', '순번': '', '거래처코드': '', '거래처명': '1전송', '출하창고': '40',
    '거래유형': '', '전잔액': ''
  }));
  const purchaseRows = rows.filter(row => text(row['거래처명']).replace(/\s/g, '') === '3우리').map(row => ({
    ...row, '일자': '', '순번': '', '거래처코드': '', '거래처명': '3우리', '출하창고': '03',
    '거래유형': '', '전잔액': '', '전달사항': '', '출고지시': '', '공지': ''
  }));
  const previewRows = rows.map(row => {
    const qty = strictNumber(row['수량']);
    const price = strictNumber(row['단가']);
    const cost = strictNumber(row['구매']);
    const supply = qty === 0 ? 0 : (strictNumber(row['공급가액']) || qty * price);
    const unitProfit = price - cost;
    const fee = row['_적용그룹'] === '청과상장' ? Math.round(supply * 0.09) : 0;
    return {
      '일자': previewDate(row['날짜'] || row['일자'], now), '거래처명': row['거래처명'] || '',
      'no.': row['규격'] || '', '품목코드': row['품목코드'] || '', '품명': row['품목명'] || '',
      '수량': qty, '단가': qty === 0 ? 0 : (price > 0 ? price : ''),
      '공급가': qty === 0 ? 0 : (supply !== 0 ? supply : ''), '적요': row['적요'] || '',
      '출고지시': row['출고지시'] || '', '출고가 (공지)': row['공지'] || '', '구매처': row['구매처'] || '',
      '구매': cost || '', '구매합계': cost ? qty * cost : '',
      '정리': qty === 0 ? 0 : (price && cost ? unitProfit : ''),
      '정산': qty === 0 ? 0 : (price && cost ? unitProfit * qty : ''),
      '수수료': qty === 0 ? 0 : (fee !== 0 ? fee : '')
    };
  });
  const checkRows = [
    ...fatalErrors.map(error => ({
      '그룹': error.customer || '', '거래처': error.spec || error.outputCustomer || '',
      '품목코드': error.code || '', '품명': error.name || '', '수량': error.qty || 0,
      '확인사항': `업로드불가: ${error.reason || '필수값 확인'}`
    })),
    ...warnings.map(warning => ({
      '그룹': warning.customer || '', '거래처': warning.spec || warning.outputCustomer || '',
      '품목코드': warning.code || '', '품명': warning.name || '', '수량': warning.qty || 0,
      '확인사항': warning.reason || '확인필요'
    }))
  ];
  if (!checkRows.length) checkRows.push({ '그룹': '', '거래처': '', '품목코드': '', '품명': '', '수량': '', '확인사항': '확인필요 항목 없음' });
  const settingRows = [...groups.values()].map(group => ({
    '거래처명': group.customer, '단가그룹': group.groupName, '단가적용순서': group.rule.join(' > '),
    '수수료모드': group.feeMode, '수익모드': group.profitMode,
    '출력거래처명모드': group.outputCustomerMode, '설정출처': '기본값', '정확일치': 'Y'
  }));

  const matrices = {
    '확인요청': [CHECK_HEADERS, ...checkRows.map(row => rowValues(row, CHECK_HEADERS))],
    '판매입력': [SALES_HEADERS, ...rows.map(row => rowValues(row, SALES_HEADERS))],
    '전송출고': [OUTBOUND_HEADERS, ...outboundRows.map(row => rowValues(row, OUTBOUND_HEADERS))],
    '전송구매': [PURCHASE_HEADERS, ...purchaseRows.map(row => rowValues(row, PURCHASE_HEADERS))],
    '거래처별': [PREVIEW_HEADERS, ...previewRows.map(row => rowValues(row, PREVIEW_HEADERS))],
    '단가설정': [SETTINGS_HEADERS, ...settingRows.map(row => rowValues(row, SETTINGS_HEADERS))],
    '구매 업로드': [PURCHASE_UPLOAD_HEADERS, ...purchaseUploadRows]
  };
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return {
    sheetNames: ['확인요청', '판매입력', '전송출고', '전송구매', '거래처별', '단가설정', '구매 업로드'],
    matrices,
    widths: {
      '확인요청': CHECK_WIDTHS, '판매입력': SALES_WIDTHS, '전송출고': OUTBOUND_WIDTHS,
      '전송구매': PURCHASE_WIDTHS, '거래처별': PREVIEW_WIDTHS, '단가설정': SETTINGS_HEADERS.map(() => 18),
      '구매 업로드': PURCHASE_UPLOAD_WIDTHS
    },
    fileName: `2전송_판매업로드_생성_${ymd}.xlsx`,
    stats: { outputRows: rows.length, fatalErrors: fatalErrors.length, warnings: warnings.length }
  };
}

export const PURCHASE_SALES_UPLOAD_HEADERS = Object.freeze({
  check: CHECK_HEADERS, sales: SALES_HEADERS, outbound: OUTBOUND_HEADERS,
  purchase: PURCHASE_HEADERS, preview: PREVIEW_HEADERS, settings: SETTINGS_HEADERS,
  upload: PURCHASE_UPLOAD_HEADERS
});

export const PURCHASE_SALES_UPLOAD_GROUPS = GROUP_PRESETS;
