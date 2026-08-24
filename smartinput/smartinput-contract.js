(function initSmartInputContract(global) {
  'use strict';

  const SCHEMA_VERSION = 'ONEAPP_SMART_INPUT_DRAFT_V1';
  const DRAFT_STORAGE_KEY = 'oneapp.smartinput.draft.v1';
  const DRAFT_LIST_STORAGE_KEY = 'oneapp.smartinput.drafts.v1';
  const DELIVERY_HISTORY_KEY = 'oneapp.smartinput.delivery-history.v1';
  const SETTINGS_STORAGE_KEY = 'oneapp.smartinput.settings.v1';
  const APP_ID = 'smart-input';
  const MODE_ORDER = ['order', 'purchase', 'sale', 'estimate'];
  const MODES = Object.freeze({
    order: Object.freeze({ id: 'order', label: '주문서', target: 'ORDERQ_VNEXT_LEDGER' }),
    purchase: Object.freeze({ id: 'purchase', label: '구매', target: 'DATAOPS_PURCHASE_PENDING' }),
    sale: Object.freeze({ id: 'sale', label: '판매', target: 'DATAOPS_SALE_PENDING' }),
    estimate: Object.freeze({ id: 'estimate', label: '견적서', target: 'SMART_INPUT_ESTIMATE_CATALOG' })
  });
  const INPUT_METHODS = Object.freeze([
    Object.freeze({ id: 'direct', label: '직접입력', sourceType: 'MANUAL' }),
    Object.freeze({ id: 'excel', label: 'Excel·파일', sourceType: 'FILE' }),
    Object.freeze({ id: 'text', label: '텍스트', sourceType: 'GENERAL_TEXT' }),
    Object.freeze({ id: 'paste', label: 'Ctrl+V', sourceType: 'CLIPBOARD' }),
    Object.freeze({ id: 'photo', label: '사진 OCR', sourceType: 'IMAGE_OCR' }),
    Object.freeze({ id: 'voice', label: '음성 STT', sourceType: 'VOICE_STT' })
  ]);
  const STAGES = Object.freeze(['capture', 'extract', 'match', 'review', 'complete']);
  const PRODUCT_FIELD_GROUPS = Object.freeze([
    Object.freeze({ id: 'ITEM', label: '품목정보' }),
    Object.freeze({ id: 'QUANTITY', label: '수량' }),
    Object.freeze({ id: 'PRICE', label: '단가' }),
    Object.freeze({ id: 'COST', label: '원가' }),
    Object.freeze({ id: 'ADDITIONAL', label: '부가정보' })
  ]);
  const productField = (id, label, group, options = {}) => Object.freeze({
    id,
    label,
    group,
    required: options.required === true,
    valueType: options.valueType === 'NUMBER' ? 'NUMBER' : 'TEXT',
    editable: options.editable !== false,
    masterAliases: Object.freeze([...(options.masterAliases || [])]),
    inputAliases: Object.freeze([...(options.inputAliases || [])])
  });
  const HEADER_FIELD_DEFINITIONS = Object.freeze([
    Object.freeze({ id: 'customer', label: '배송 거래처', required: true }),
    Object.freeze({ id: 'deliveryDate', label: '배송일자', required: true }),
    Object.freeze({ id: 'warehouse', label: '출하창고', required: true }),
    Object.freeze({ id: 'transactionType', label: '거래유형', required: false })
  ]);
  const VOUCHER_COLUMN_DEFINITIONS = Object.freeze([
    productField('itemCode', '품목코드', 'ITEM', { required: true, masterAliases: ['itemCode', 'productCode', '코드', '품목코드', '상품코드'] }),
    productField('itemName', '품목(상품명)', 'ITEM', { masterAliases: ['itemName', 'productName', '품목명', '상품명', '제품명', '품명'] }),
    productField('specification', '규격', 'ITEM', { masterAliases: ['specification', 'spec', '규격', '규격명'] }),
    productField('quantity', '수량', 'QUANTITY', { valueType: 'NUMBER' }),
    productField('unit', '단위(상품구성)', 'ITEM', { masterAliases: ['finalUnit', 'unit', '업무단위', '단위', '상품구성'] }),
    productField('unitPrice', '단가', 'PRICE', { valueType: 'NUMBER', inputAliases: ['견적단가', '판매단가', '주문단가'] }),
    productField('supplyAmount', '공급가액', 'PRICE', { valueType: 'NUMBER', editable: false }),
    productField('memo', '메모', 'ADDITIONAL', { inputAliases: ['지시사항', '비고', '요청사항'] }),
    productField('description', '적요(직원)', 'ADDITIONAL', { inputAliases: ['적요', '직원적요'] }),
    productField('noticePrice', '공지단가', 'PRICE', { valueType: 'NUMBER' })
  ]);
  const voucherField = id => VOUCHER_COLUMN_DEFINITIONS.find(field => field.id === id);
  const PRODUCT_FIELD_DEFINITIONS = Object.freeze([
    voucherField('itemCode'),
    voucherField('itemName'),
    voucherField('specification'),
    voucherField('unit'),
    productField('productType', '품목구분', 'ITEM', { masterAliases: ['productType', '품목구분'] }),
    productField('inventoryQuantityManagement', '재고수량관리', 'ITEM', { masterAliases: ['inventoryQuantityManagement', '재고수량관리'] }),
    productField('salesVatRate', '부가세율(매출)', 'ITEM', { valueType: 'NUMBER', masterAliases: ['salesVatRate', '부가세율(매출)', '매출부가세율'] }),
    productField('purchaseVatRate', '부가세율(매입)', 'ITEM', { valueType: 'NUMBER', masterAliases: ['purchaseVatRate', '부가세율(매입)', '매입부가세율'] }),
    productField('barcode', '바코드', 'ITEM', { masterAliases: ['barcode', '바코드'] }),
    productField('productionProcess', '생산공정', 'ITEM', { masterAliases: ['productionProcess', '생산공정'] }),
    productField('secondaryName', '검색(품명2)', 'ITEM', { masterAliases: ['secondaryName', 'secondName', '제2품명', '제2상품명', '품명2', '검색(품명2)', '약칭', '별칭'] }),
    productField('shared', '공유여부', 'ITEM', { masterAliases: ['shared', '공유여부'] }),
    productField('productGroup1', '품목그룹1', 'ITEM', { masterAliases: ['productGroup1', '품목그룹1', '1그룹명'] }),
    productField('productGroup2', '품목그룹2', 'ITEM', { masterAliases: ['productGroup2', '품목그룹2', '2그룹명'] }),
    productField('productGroup3', '품목그룹3', 'ITEM', { masterAliases: ['productGroup3', '품목그룹3', '3그룹명'] }),
    productField('productDescription', '상품설명', 'ITEM', { masterAliases: ['productDescription', '상품설명', '간단설명'] }),
    productField('qualityInspectionType', '품질검사유형', 'ITEM', { masterAliases: ['qualityInspectionType', '품질검사유형'] }),
    productField('qualityInspectionMethod', '품질검사방법', 'ITEM', { masterAliases: ['qualityInspectionMethod', '품질검사방법'] }),

    voucherField('quantity'),
    productField('quantityPerQuantity2', '수량2당수량', 'QUANTITY', { valueType: 'NUMBER', masterAliases: ['quantityPerQuantity2', '수량2당수량', '2당수량'] }),
    productField('safetyStockManagement', '안전재고관리', 'QUANTITY', { masterAliases: ['safetyStockManagement', '안전재고관리'] }),
    productField('safetyQuantity', '안전수량', 'QUANTITY', { valueType: 'NUMBER', masterAliases: ['safetyQuantity', '안전수량', '안전재고'] }),
    productField('cPortalMinOrderQuantityCheck', 'C-Portal최소주문수량체크', 'QUANTITY', { masterAliases: ['cPortalMinOrderQuantityCheck', 'C-Portal최소주문수량체크'] }),
    productField('cPortalMinOrderQuantity', 'C-Portal최소주문수량', 'QUANTITY', { valueType: 'NUMBER', masterAliases: ['cPortalMinOrderQuantity', 'C-Portal최소주문수량', '최소구매수'] }),
    productField('cPortalMinOrderUnit', 'C-Portal최소주문단위', 'QUANTITY', { valueType: 'NUMBER', masterAliases: ['cPortalMinOrderUnit', 'C-Portal최소주문단위'] }),
    productField('procurementLeadTime', '조달기간', 'QUANTITY', { valueType: 'NUMBER', masterAliases: ['procurementLeadTime', '조달기간'] }),
    productField('minimumPurchaseUnit', '최소구매단위', 'QUANTITY', { valueType: 'NUMBER', masterAliases: ['minimumPurchaseUnit', '최소구매단위'] }),
    productField('supplier', '구매처', 'QUANTITY', { masterAliases: ['supplier', '구매처'] }),

    voucherField('unitPrice'),
    voucherField('supplyAmount'),
    productField('inboundPrice', '입고가', 'PRICE', { valueType: 'NUMBER', masterAliases: ['inboundPrice', '입고가'] }),
    productField('outPrice', '출고가', 'PRICE', { valueType: 'NUMBER', masterAliases: ['outPrice', '출고가'] }),
    productField('purchasePriceB', '입고B', 'PRICE', { valueType: 'NUMBER', masterAliases: ['purchasePriceB', '입고B'] }),
    productField('wholesaleA', '도매A', 'PRICE', { valueType: 'NUMBER', masterAliases: ['wholesaleA', '도매A', '도매가', 'A판매', 'A판매가'] }),
    productField('wholesaleB', '도매B', 'PRICE', { valueType: 'NUMBER', masterAliases: ['wholesaleB', '도매B', 'B판매', 'B판매가', 'B도매', 'B도매가'] }),
    productField('priceD', '단가D', 'PRICE', { valueType: 'NUMBER', masterAliases: ['priceD', '단가D'] }),
    productField('lastPurchasePrice', '최종입고', 'PRICE', { valueType: 'NUMBER', masterAliases: ['lastPurchasePrice', '최종입고'] }),
    productField('marketPrice', '시중가', 'PRICE', { valueType: 'NUMBER', masterAliases: ['marketPrice', '시중가', '시중가격'] }),
    productField('listingPrice', '상장가', 'PRICE', { valueType: 'NUMBER', masterAliases: ['listingPrice', '상장가'] }),
    productField('priceH', '단가H', 'PRICE', { valueType: 'NUMBER', masterAliases: ['priceH', '단가H'] }),
    productField('priceI', '단가I', 'PRICE', { valueType: 'NUMBER', masterAliases: ['priceI', '단가I'] }),
    productField('promoPrice', '행사가', 'PRICE', { valueType: 'NUMBER', masterAliases: ['promoPrice', '행사가', '특가'] }),
    voucherField('noticePrice'),

    productField('outsourcingUnitPrice', '외주비단가', 'COST', { valueType: 'NUMBER', masterAliases: ['outsourcingUnitPrice', '외주비단가', '외주비'] }),
    productField('standardLaborTime', '표준노무시간(노무비가중치)', 'COST', { valueType: 'NUMBER', masterAliases: ['standardLaborTime', '표준노무시간(노무비가중치)', '노무비가중치'] }),
    productField('expenseWeight', '경비가중치', 'COST', { valueType: 'NUMBER', masterAliases: ['expenseWeight', '경비가중치'] }),
    productField('materialStandardCost', '재료비표준원가', 'COST', { valueType: 'NUMBER', masterAliases: ['materialStandardCost', '재료비표준원가'] }),
    productField('expenseStandardCost', '경비표준원가', 'COST', { valueType: 'NUMBER', masterAliases: ['expenseStandardCost', '경비표준원가', '경비'] }),
    productField('laborStandardCost', '노무비표준원가', 'COST', { valueType: 'NUMBER', masterAliases: ['laborStandardCost', '노무비표준원가', '노무비'] }),
    productField('outsourcingStandardCost', '외주비표준원가', 'COST', { valueType: 'NUMBER', masterAliases: ['outsourcingStandardCost', '외주비표준원가'] }),

    productField('brand', '브랜드', 'ADDITIONAL', { masterAliases: ['brand', '브랜드'] }),
    productField('type1Code', '1종코드', 'ADDITIONAL', { masterAliases: ['type1Code', '1종코드'] }),
    productField('type1Specification', '1종규격', 'ADDITIONAL', { masterAliases: ['type1Specification', '1종규격'] }),
    productField('type2Code', '2종코드', 'ADDITIONAL', { masterAliases: ['type2Code', '2종코드'] }),
    productField('type2Specification', '2종규격', 'ADDITIONAL', { masterAliases: ['type2Specification', '2종규격'] }),
    productField('defaultDivision', '구분(기본)', 'ADDITIONAL', { masterAliases: ['defaultDivision', '구분(기본)', '기본'] }),
    productField('type1Operation', '1종연산', 'ADDITIONAL', { masterAliases: ['type1Operation', '1종연산'] }),
    productField('type2Operation', '2종연산', 'ADDITIONAL', { masterAliases: ['type2Operation', '2종연산'] }),
    productField('boxQuantity', '박스입수', 'ADDITIONAL', { valueType: 'NUMBER', masterAliases: ['boxQuantity', 'unitsPerBox', '박스입수', '박스당수량', '박스당 수량', '원단위', '입수'] }),
    productField('preparationDays', '준비기간(일)', 'ADDITIONAL', { valueType: 'NUMBER', masterAliases: ['preparationDays', '준비기간(일)', '준비기간'] }),
    productField('orderCutoffTime', '주문마감시간', 'ADDITIONAL', { masterAliases: ['orderCutoffTime', '주문마감시간', '마감시간'] }),
    productField('machang', '마창', 'ADDITIONAL', { masterAliases: ['machang', '마창'] }),
    productField('saecheonyeon', '새천년', 'ADDITIONAL', { masterAliases: ['saecheonyeon', '새천년'] }),
    productField('hanbit', '한빛', 'ADDITIONAL', { masterAliases: ['hanbit', '한빛'] }),
    productField('distributor1', '유통사1', 'ADDITIONAL', { masterAliases: ['distributor1', '유통사1'] }),
    productField('distributor2', '유통사2', 'ADDITIONAL', { masterAliases: ['distributor2', '유통사2'] }),
    productField('taxExempt', '비과세', 'ADDITIONAL', { masterAliases: ['taxExempt', '비과세'] }),
    productField('storageLocation', '적재위치', 'ADDITIONAL', { masterAliases: ['storageLocation', '적재위치'] }),
    productField('naver', '네이버', 'ADDITIONAL', { masterAliases: ['naver', '네이버'] }),
    productField('orderzCategory3', '오더즈분류3', 'ADDITIONAL', { masterAliases: ['orderzCategory3', '오더즈분류3', '오더즈'] }),
    productField('distributor', '유통사', 'ADDITIONAL', { masterAliases: ['distributor', '유통사'] }),
    productField('shelfLife', '유통기한', 'ADDITIONAL', { masterAliases: ['shelfLife', '유통기한'] }),
    productField('dateInfo', '일자', 'ADDITIONAL', { masterAliases: ['dateInfo', '일자'] }),
    productField('transactionInfo', '거래', 'ADDITIONAL', { masterAliases: ['transactionInfo', '거래'] }),
    productField('additionalQuantity', '수량', 'ADDITIONAL', { valueType: 'NUMBER', masterAliases: ['additionalQuantity', '부가수량'] }),
    productField('marketPriceFlag', '싯가', 'ADDITIONAL', { masterAliases: ['marketPriceFlag', '싯가'] }),
    productField('orderzTags', '오더즈태그', 'ADDITIONAL', { masterAliases: ['orderzTags', '오더즈태그'] }),
    productField('disclosureInfo', '정보고시', 'ADDITIONAL', { masterAliases: ['disclosureInfo', '정보고시'] }),
    productField('category', '카테고리', 'ADDITIONAL', { masterAliases: ['category', '카테고리'] }),
    productField('additionalSpecification', '규격', 'ADDITIONAL', { masterAliases: ['additionalSpecification', '부가규격'] }),
    productField('oneApp', '원앱', 'ADDITIONAL', { masterAliases: ['oneApp', '원앱'] }),
    productField('woori2', '우리2', 'ADDITIONAL', { masterAliases: ['woori2', '우리2'] }),
    productField('grade', '등급', 'ADDITIONAL', { masterAliases: ['grade', '등급'] }),
    productField('sizeFruitCount', '사이즈/과수', 'ADDITIONAL', { masterAliases: ['sizeFruitCount', '사이즈/과수'] }),
    productField('weightFruitCount', '중량/과수', 'ADDITIONAL', { masterAliases: ['weightFruitCount', '중량/과수'] }),
    productField('packaging', '포장', 'ADDITIONAL', { masterAliases: ['packaging', '포장'] }),
    productField('managementItem', '관리항목', 'ADDITIONAL', { masterAliases: ['managementItem', '관리항목'] }),
    productField('serialLotNo', '시리얼/로트No.', 'ADDITIONAL', { masterAliases: ['serialLotNo', '시리얼/로트No.', '시리얼/로트NO'] }),
    productField('productionSlipTarget', '생산전표생성대상', 'ADDITIONAL', { masterAliases: ['productionSlipTarget', '생산전표생성대상'] }),
    productField('qualityInspectionRequestTarget', '품질검사요청대상', 'ADDITIONAL', { masterAliases: ['qualityInspectionRequestTarget', '품질검사요청대상'] }),
    productField('otherInfo', '기타', 'ADDITIONAL', { masterAliases: ['otherInfo', '기타'] }),
    productField('discontinued', '사용중단', 'ADDITIONAL', { masterAliases: ['discontinued', '사용중단', '판매여부'] }),
    productField('searchInfo', '검색정보', 'ADDITIONAL', { masterAliases: ['searchInfo', 'searchKeywords', '검색창정보', '검색어등록', '검색어'] }),
    voucherField('memo'),
    voucherField('description')
  ]);
  const ROW_FIELDS = Object.freeze(PRODUCT_FIELD_DEFINITIONS.filter(field => field.editable !== false).map(field => field.id));
  const DEFAULT_HEADER_FIELDS = Object.freeze(HEADER_FIELD_DEFINITIONS.map(field => field.id));
  const DEFAULT_VOUCHER_COLUMNS = Object.freeze(VOUCHER_COLUMN_DEFINITIONS.map(field => field.id));
  const DEFAULT_HEADER_FIELDS_BY_MODE = Object.freeze(Object.fromEntries(
    MODE_ORDER.map(mode => [mode, Object.freeze([...DEFAULT_HEADER_FIELDS])])
  ));
  const DEFAULT_VOUCHER_COLUMNS_BY_MODE = Object.freeze(Object.fromEntries(
    MODE_ORDER.map(mode => [mode, Object.freeze([...DEFAULT_VOUCHER_COLUMNS])])
  ));
  const DEFAULT_INPUT_ORDER_BY_MODE = Object.freeze(Object.fromEntries(MODE_ORDER.map(mode => [
    mode,
    Object.freeze(Object.fromEntries(DEFAULT_VOUCHER_COLUMNS.map((fieldId, index) => [
      fieldId,
      VOUCHER_COLUMN_DEFINITIONS.find(field => field.id === fieldId)?.editable === false ? 0 : index + 1
    ])))
  ])));
  const DEFAULT_SETTINGS = Object.freeze({
    orderCutoffTime: '',
    allowSameDayDelivery: true,
    defaultDeliveryWeekdays: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
    deliveryCustomerWeekdays: Object.freeze({}),
    holidayWeekdays: Object.freeze([]),
    holidayDates: Object.freeze([]),
    timezone: 'Asia/Seoul',
    headerFields: DEFAULT_HEADER_FIELDS,
    voucherColumns: DEFAULT_VOUCHER_COLUMNS,
    headerFieldsByMode: DEFAULT_HEADER_FIELDS_BY_MODE,
    voucherColumnsByMode: DEFAULT_VOUCHER_COLUMNS_BY_MODE,
    inputOrderByMode: DEFAULT_INPUT_ORDER_BY_MODE,
    customFields: Object.freeze([]),
    columnWidths: Object.freeze({}),
    columnWidthsByMode: Object.freeze(Object.fromEntries(MODE_ORDER.map(mode => [mode, Object.freeze({})])))
  });
  const WEEKDAY_LABELS = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);

  function text(value) {
    return String(value ?? '').normalize('NFKC').trim();
  }

  function numberOrNull(value) {
    if (value === '' || value === null || value === undefined) return null;
    const number = Number(String(value).replace(/[,원₩]/g, ''));
    return Number.isFinite(number) ? number : null;
  }

  function createId(prefix, now = Date.now(), random = Math.random()) {
    return `${prefix}-${Number(now).toString(36)}-${Math.floor(Number(random) * 0xffffff).toString(36).padStart(5, '0')}`;
  }

  function todayLocal(date = new Date()) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  function normalizeWeekdays(value, fallback = []) {
    const source = Array.isArray(value) ? value : fallback;
    return [...new Set(source.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
  }

  function normalizeSettings(value = {}) {
    const customTypeCounts = { TEXT: 0, NUMBER: 0 };
    const customFields = (Array.isArray(value.customFields) ? value.customFields : []).map((field, index) => {
      const scope = field?.scope === 'voucher' ? 'voucher' : 'header';
      const category = ['PRODUCT', 'CUSTOMER', 'CUSTOM'].includes(text(field?.category).toUpperCase())
        ? text(field.category).toUpperCase()
        : 'CUSTOM';
      const label = text(field?.label);
      if (!label) return null;
      const valueType = text(field?.valueType).toUpperCase() === 'NUMBER' ? 'NUMBER' : 'TEXT';
      if (category === 'CUSTOM') {
        if (customTypeCounts[valueType] >= 10) return null;
        customTypeCounts[valueType] += 1;
      }
      return {
        id: text(field?.id) || `custom-${scope}-${index + 1}`,
        label,
        scope,
        category,
        sourceField: text(field?.sourceField),
        valueType
      };
    }).filter(Boolean).filter((field, index, rows) => rows.findIndex(other => other.id === field.id) === index);
    const deliveryCustomerWeekdays = {};
    const sourceMap = value.deliveryCustomerWeekdays && typeof value.deliveryCustomerWeekdays === 'object'
      ? value.deliveryCustomerWeekdays
      : {};
    Object.entries(sourceMap).forEach(([customerId, weekdays]) => {
      deliveryCustomerWeekdays[text(customerId)] = normalizeWeekdays(weekdays);
    });
    const normalizeLayout = (selected, definitions, fallback, scope) => {
      const allowed = new Set([...definitions.map(field => field.id), ...customFields.filter(field => field.scope === scope).map(field => field.id)]);
      const requested = Array.isArray(selected) ? selected.map(text).filter(id => allowed.has(id)) : [...fallback].filter(id => allowed.has(id));
      const ordered = [...new Set(requested)];
      definitions.filter(field => field.required).forEach(field => {
        if (!ordered.includes(field.id)) ordered.push(field.id);
      });
      return ordered;
    };
    const allowedColumnIds = new Set(['productSearch', ...PRODUCT_FIELD_DEFINITIONS.map(field => field.id), ...customFields.filter(field => field.scope === 'voucher').map(field => field.id)]);
    const columnWidths = {};
    Object.entries(value.columnWidths && typeof value.columnWidths === 'object' ? value.columnWidths : {}).forEach(([fieldId, width]) => {
      const normalizedWidth = Number(width);
      if (!allowedColumnIds.has(text(fieldId)) || !Number.isFinite(normalizedWidth)) return;
      columnWidths[text(fieldId)] = Math.max(56, Math.min(480, Math.round(normalizedWidth)));
    });
    const sourceColumnWidthsByMode = value.columnWidthsByMode && typeof value.columnWidthsByMode === 'object'
      ? value.columnWidthsByMode
      : {};
    const columnWidthsByMode = Object.fromEntries(MODE_ORDER.map(mode => {
      const widths = {};
      Object.entries(sourceColumnWidthsByMode[mode] && typeof sourceColumnWidthsByMode[mode] === 'object' ? sourceColumnWidthsByMode[mode] : {})
        .forEach(([fieldId, width]) => {
          const normalizedWidth = Number(width);
          if (!allowedColumnIds.has(text(fieldId)) || !Number.isFinite(normalizedWidth)) return;
          widths[text(fieldId)] = Math.max(56, Math.min(480, Math.round(normalizedWidth)));
        });
      return [mode, widths];
    }));
    const legacyHeaderFields = normalizeLayout(value.headerFields, HEADER_FIELD_DEFINITIONS, DEFAULT_SETTINGS.headerFields, 'header');
    const legacyVoucherColumns = normalizeLayout(value.voucherColumns, PRODUCT_FIELD_DEFINITIONS, DEFAULT_SETTINGS.voucherColumns, 'voucher');
    const sourceHeaderFieldsByMode = value.headerFieldsByMode && typeof value.headerFieldsByMode === 'object'
      ? value.headerFieldsByMode
      : {};
    const sourceVoucherColumnsByMode = value.voucherColumnsByMode && typeof value.voucherColumnsByMode === 'object'
      ? value.voucherColumnsByMode
      : {};
    const headerFieldsByMode = Object.fromEntries(MODE_ORDER.map(mode => [
      mode,
      normalizeLayout(sourceHeaderFieldsByMode[mode], HEADER_FIELD_DEFINITIONS, legacyHeaderFields, 'header')
    ]));
    const voucherColumnsByMode = Object.fromEntries(MODE_ORDER.map(mode => [
      mode,
      normalizeLayout(sourceVoucherColumnsByMode[mode], PRODUCT_FIELD_DEFINITIONS, legacyVoucherColumns, 'voucher')
    ]));
    const inputOrderSource = value.inputOrderByMode && typeof value.inputOrderByMode === 'object'
      ? value.inputOrderByMode
      : {};
    const productFieldById = new Map(PRODUCT_FIELD_DEFINITIONS.map(field => [field.id, field]));
    const inputOrderByMode = Object.fromEntries(MODE_ORDER.map(mode => {
      const selected = voucherColumnsByMode[mode];
      const selectedIndex = new Map(selected.map((fieldId, index) => [fieldId, index]));
      const source = inputOrderSource[mode] && typeof inputOrderSource[mode] === 'object' ? inputOrderSource[mode] : {};
      const order = {};
      allowedColumnIds.forEach(fieldId => {
        const configured = Number(source[fieldId]);
        const builtIn = productFieldById.get(fieldId);
        const fallbackOrder = selectedIndex.has(fieldId) && builtIn?.editable !== false ? selectedIndex.get(fieldId) + 1 : 0;
        order[fieldId] = builtIn?.editable === false
          ? 0
          : (Number.isFinite(configured) && configured >= 0
              ? Math.min(999, Math.round(configured))
              : fallbackOrder);
      });
      return [mode, order];
    }));
    return {
      orderCutoffTime: /^\d{2}:\d{2}$/.test(text(value.orderCutoffTime)) ? text(value.orderCutoffTime) : '',
      allowSameDayDelivery: value.allowSameDayDelivery !== false,
      defaultDeliveryWeekdays: normalizeWeekdays(value.defaultDeliveryWeekdays, DEFAULT_SETTINGS.defaultDeliveryWeekdays),
      deliveryCustomerWeekdays,
      holidayWeekdays: normalizeWeekdays(value.holidayWeekdays, DEFAULT_SETTINGS.holidayWeekdays),
      holidayDates: [...new Set((Array.isArray(value.holidayDates) ? value.holidayDates : []).map(text).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort(),
      timezone: text(value.timezone || DEFAULT_SETTINGS.timezone),
      headerFields: [...headerFieldsByMode.order],
      voucherColumns: [...voucherColumnsByMode.order],
      headerFieldsByMode,
      voucherColumnsByMode,
      inputOrderByMode,
      customFields,
      columnWidths,
      columnWidthsByMode
    };
  }

  function parseDate(value) {
    const match = text(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function dateText(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function addDays(value, count) {
    const date = parseDate(value);
    if (!date) return '';
    date.setUTCDate(date.getUTCDate() + Number(count || 0));
    return dateText(date);
  }

  function zonedNow(date = new Date(), timezone = DEFAULT_SETTINGS.timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23'
      }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
      return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
    } catch (_) {
      return { date: todayLocal(date), time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` };
    }
  }

  function businessDate(date = new Date(), timezone = DEFAULT_SETTINGS.timezone) {
    const value = date instanceof Date ? date : new Date(date);
    return zonedNow(Number.isNaN(value.getTime()) ? new Date() : value, timezone).date;
  }

  function effectiveDeliveryWeekdays(settings, customerId = '') {
    const normalized = normalizeSettings(settings);
    const key = text(customerId);
    if (key && Object.prototype.hasOwnProperty.call(normalized.deliveryCustomerWeekdays, key)) {
      return normalized.deliveryCustomerWeekdays[key];
    }
    return normalized.defaultDeliveryWeekdays;
  }

  function validateDeliveryDate({ deliveryDate, orderDate, customerId = '', settings = DEFAULT_SETTINGS, now = new Date() } = {}) {
    const normalized = normalizeSettings(settings);
    const target = parseDate(deliveryDate);
    const order = parseDate(orderDate);
    if (!target) return { valid: false, code: 'DATE_REQUIRED', message: '배송일자를 확인하세요.' };
    const current = zonedNow(now, normalized.timezone);
    if (deliveryDate < current.date) return { valid: false, code: 'PAST_DATE', message: '지난 날짜는 배송일로 선택할 수 없습니다.' };
    if (order && deliveryDate < orderDate) return { valid: false, code: 'BEFORE_ORDER_DATE', message: '배송일은 주문일자보다 빠를 수 없습니다.' };
    const weekdays = effectiveDeliveryWeekdays(normalized, customerId);
    if (!weekdays.length) return { valid: false, code: 'NO_DELIVERY_WEEKDAYS', message: '배송 가능 요일을 설정하세요.' };
    const weekday = target.getUTCDay();
    if (!weekdays.includes(weekday)) return { valid: false, code: 'WEEKDAY_BLOCKED', message: `${WEEKDAY_LABELS[weekday]}요일은 선택한 배송처의 배송 가능 요일이 아닙니다.` };
    if (normalized.holidayWeekdays.includes(weekday) || normalized.holidayDates.includes(deliveryDate)) {
      return { valid: false, code: 'HOLIDAY', message: '휴무일은 배송일로 선택할 수 없습니다.' };
    }
    if (deliveryDate === current.date) {
      if (!normalized.allowSameDayDelivery) return { valid: false, code: 'SAME_DAY_DISABLED', message: '당일 배송이 허용되지 않습니다.' };
      if (normalized.orderCutoffTime && current.time > normalized.orderCutoffTime) {
        return { valid: false, code: 'CUTOFF_PASSED', message: `주문 마감 ${normalized.orderCutoffTime} 이후에는 당일 배송을 선택할 수 없습니다.` };
      }
    }
    return { valid: true, code: 'AVAILABLE', message: '선택 가능한 배송일입니다.', weekday };
  }

  function nextDeliveryDate({ orderDate, customerId = '', settings = DEFAULT_SETTINGS, now = new Date(), maxDays = 366 } = {}) {
    if (!parseDate(orderDate)) return { date: '', error: '주문일자를 확인하세요.' };
    const current = zonedNow(now, normalizeSettings(settings).timezone);
    const baseDate = orderDate > current.date ? orderDate : current.date;
    for (let offset = 1; offset <= maxDays; offset += 1) {
      const candidate = addDays(baseDate, offset);
      const decision = validateDeliveryDate({ deliveryDate: candidate, orderDate, customerId, settings, now });
      if (decision.valid) return { date: candidate, offset, decision };
    }
    return { date: '', error: `${maxDays}일 안에 배송 가능한 날짜가 없습니다.` };
  }

  function deliveryWeekdayLabel(settings, customerId = '') {
    const weekdays = effectiveDeliveryWeekdays(settings, customerId);
    return weekdays.length ? weekdays.map(day => WEEKDAY_LABELS[day]).join('·') : '미설정';
  }

  function createModeDraft(mode, date = businessDate(), recordedAt = new Date().toISOString()) {
    return {
      documentId: createId('SIDOC'),
      catalogRecordId: '',
      catalogBaselinePrices: {},
      catalogPreviousPrices: {},
      mode,
      header: {
        recordedAt,
        submittedAt: '',
        customerId: '',
        customerName: '',
        customerLinkGroupId: '',
        taxCustomerId: '',
        taxCustomerName: '',
        isTemporaryCustomer: false,
        rawOrdererName: '',
        aliasMappingId: '',
        customerMappingSource: '',
        orderDate: date,
        deliveryDate: '',
        manualDeliveryOverride: false,
        deliveryPolicySnapshot: null,
        warehouseId: '',
        warehouseCode: '',
        warehouseName: '',
        transactionType: '기타',
        customValues: {}
      },
      sourceText: '',
      activeMethod: 'text',
      batches: [],
      rows: [],
      delivery: { status: 'DRAFT', targetId: '', targetRecordId: '', deliveredAt: '' },
      updatedAt: new Date().toISOString()
    };
  }

  function createDraft(options = {}) {
    const created = new Date(options.now ?? Date.now());
    const recordedAt = created.toISOString();
    const date = options.date || businessDate(created);
    return {
      schemaVersion: SCHEMA_VERSION,
      appId: APP_ID,
      draftId: options.draftId || createId('SIDRAFT', options.now, options.random),
      activeMode: MODE_ORDER.includes(options.activeMode) ? options.activeMode : 'order',
      modes: {
        order: createModeDraft('order', date, recordedAt),
        purchase: createModeDraft('purchase', date, recordedAt),
        sale: createModeDraft('sale', date, recordedAt),
        estimate: createModeDraft('estimate', date, recordedAt)
      },
      ui: { stage: 'capture', relatedOpen: false, selectedRowId: '', scrollTop: 0 },
      createdAt: recordedAt,
      updatedAt: recordedAt
    };
  }

  function normalizeHeader(value = {}, fallback = {}) {
    const recordedAt = text(value.recordedAt || fallback.recordedAt) || new Date().toISOString();
    return {
      recordedAt,
      submittedAt: text(value.submittedAt || fallback.submittedAt),
      customerId: text(value.customerId || fallback.customerId),
      customerName: text(value.customerName || fallback.customerName),
      customerLinkGroupId: text(value.customerLinkGroupId || fallback.customerLinkGroupId),
      taxCustomerId: text(value.taxCustomerId || fallback.taxCustomerId),
      taxCustomerName: text(value.taxCustomerName || fallback.taxCustomerName),
      isTemporaryCustomer: Boolean(value.isTemporaryCustomer ?? fallback.isTemporaryCustomer),
      rawOrdererName: text(value.rawOrdererName || fallback.rawOrdererName),
      aliasMappingId: text(value.aliasMappingId || fallback.aliasMappingId),
      customerMappingSource: text(value.customerMappingSource || fallback.customerMappingSource),
      orderDate: businessDate(recordedAt),
      deliveryDate: text(value.deliveryDate || fallback.deliveryDate),
      manualDeliveryOverride: Boolean(value.manualDeliveryOverride ?? fallback.manualDeliveryOverride),
      deliveryPolicySnapshot: value.deliveryPolicySnapshot && typeof value.deliveryPolicySnapshot === 'object'
        ? { ...value.deliveryPolicySnapshot }
        : (fallback.deliveryPolicySnapshot ? { ...fallback.deliveryPolicySnapshot } : null),
      warehouseId: text(value.warehouseId || fallback.warehouseId),
      warehouseCode: text(value.warehouseCode || fallback.warehouseCode),
      warehouseName: text(value.warehouseName || fallback.warehouseName),
      transactionType: text(value.transactionType || fallback.transactionType || '기타'),
      customValues: value.customValues && typeof value.customValues === 'object'
        ? { ...value.customValues }
        : (fallback.customValues ? { ...fallback.customValues } : {})
    };
  }

  function normalizeSourceRegion(value) {
    if (!value || typeof value !== 'object') return null;
    const left = Number(value.left);
    const top = Number(value.top);
    const width = Number(value.width);
    const height = Number(value.height);
    if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    const normalizedLeft = Math.max(0, Math.min(1, left));
    const normalizedTop = Math.max(0, Math.min(1, top));
    const normalizedWidth = Math.max(0, Math.min(1 - normalizedLeft, width));
    const normalizedHeight = Math.max(0, Math.min(1 - normalizedTop, height));
    if (!normalizedWidth || !normalizedHeight) return null;
    return {
      left: normalizedLeft,
      top: normalizedTop,
      width: normalizedWidth,
      height: normalizedHeight
    };
  }

  function normalizeRow(input = {}, fallbackBatchId = '') {
    const productId = text(input.productId);
    const masterProductId = text(input.masterProductId);
    const itemCode = text(input.itemCode);
    const candidateProducts = Array.isArray(input.candidateProducts) ? input.candidateProducts : [];
    const requestedMatchStatus = text(input.matchStatus).toUpperCase();
    const hasMasterIdentity = Boolean(productId && masterProductId && itemCode);
    const matchStatus = hasMasterIdentity
      ? 'MATCHED'
      : (requestedMatchStatus === 'SIMILAR' || candidateProducts.length
        ? 'SIMILAR'
        : 'UNRESOLVED');
    const row = {
      rowId: text(input.rowId) || createId('SIROW'),
      batchId: text(input.batchId || fallbackBatchId),
      batchSequence: Number(input.batchSequence || 0),
      sourceLineNo: Number(input.sourceLineNo || 0),
      sourceLineKey: text(input.sourceLineKey),
      intakeLineId: text(input.intakeLineId),
      sourceRegion: normalizeSourceRegion(input.sourceRegion),
      rawText: String(input.rawText ?? input.rawExpression ?? ''),
      inputOwnership: input.inputOwnership === 'USER' ? 'USER' : 'SOURCE',
      productId,
      masterProductId,
      itemCode,
      itemName: text(input.itemName || input.productText),
      secondaryName: text(input.secondaryName),
      searchInfo: text(input.searchInfo),
      specification: text(input.specification),
      boxQuantity: numberOrNull(input.boxQuantity),
      quantity: numberOrNull(input.quantity ?? input.finalQuantity ?? input.rawQuantity),
      unit: text(input.unit || input.finalUnit || input.rawUnit),
      unitPrice: numberOrNull(input.unitPrice ?? input.price),
      outPrice: numberOrNull(input.outPrice),
      wholesaleA: numberOrNull(input.wholesaleA),
      wholesaleB: numberOrNull(input.wholesaleB),
      listingPrice: numberOrNull(input.listingPrice),
      marketPrice: numberOrNull(input.marketPrice),
      promoPrice: numberOrNull(input.promoPrice),
      purchasePriceB: numberOrNull(input.purchasePriceB),
      priceD: numberOrNull(input.priceD),
      lastPurchasePrice: numberOrNull(input.lastPurchasePrice),
      priceH: numberOrNull(input.priceH),
      priceI: numberOrNull(input.priceI),
      memo: text(input.memo),
      description: text(input.description),
      noticePrice: numberOrNull(input.noticePrice) ?? 0,
      unitPriceReviewStatus: input.unitPriceReviewStatus === 'PENDING' ? 'PENDING' : 'CONFIRMED',
      customValues: input.customValues && typeof input.customValues === 'object' ? { ...input.customValues } : {},
      matchStatus: ['MATCHED', 'SIMILAR', 'UNRESOLVED'].includes(matchStatus) ? matchStatus : 'UNRESOLVED',
      candidateProducts,
      editedFields: input.editedFields && typeof input.editedFields === 'object' ? { ...input.editedFields } : {},
      duplicatePossible: Boolean(input.duplicatePossible),
      reviewStatus: hasMasterIdentity ? 'CONFIRMED' : 'PENDING',
      productIdentityStatus: hasMasterIdentity ? 'MASTER_LINKED' : 'UNRESOLVED'
    };
    PRODUCT_FIELD_DEFINITIONS.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(row, field.id)) return;
      row[field.id] = field.valueType === 'NUMBER' ? numberOrNull(input[field.id]) : text(input[field.id]);
    });
    return row;
  }

  function normalizeModeDraft(mode, input = {}, fallback = createModeDraft(mode)) {
    return {
      documentId: text(input.documentId) || fallback.documentId,
      catalogRecordId: text(input.catalogRecordId),
      catalogBaselinePrices: input.catalogBaselinePrices && typeof input.catalogBaselinePrices === 'object'
        ? { ...input.catalogBaselinePrices }
        : {},
      catalogPreviousPrices: input.catalogPreviousPrices && typeof input.catalogPreviousPrices === 'object'
        ? { ...input.catalogPreviousPrices }
        : {},
      mode,
      header: normalizeHeader(input.header, fallback.header),
      sourceText: String(input.sourceText ?? ''),
      activeMethod: INPUT_METHODS.some(method => method.id === input.activeMethod) ? input.activeMethod : 'text',
      batches: Array.isArray(input.batches) ? input.batches.map(batch => ({ ...batch, rawText: String(batch.rawText ?? '') })) : [],
      rows: Array.isArray(input.rows) ? input.rows.map(row => normalizeRow(row)) : [],
      delivery: input.delivery && typeof input.delivery === 'object' ? { ...fallback.delivery, ...input.delivery } : { ...fallback.delivery },
      updatedAt: text(input.updatedAt) || fallback.updatedAt
    };
  }

  function normalizeDraft(input) {
    const fallback = createDraft();
    if (!input || typeof input !== 'object' || input.schemaVersion !== SCHEMA_VERSION) return fallback;
    return {
      ...fallback,
      draftId: text(input.draftId) || fallback.draftId,
      activeMode: MODE_ORDER.includes(input.activeMode) ? input.activeMode : 'order',
      modes: {
        order: normalizeModeDraft('order', input.modes?.order, fallback.modes.order),
        purchase: normalizeModeDraft('purchase', input.modes?.purchase, fallback.modes.purchase),
        sale: normalizeModeDraft('sale', input.modes?.sale, fallback.modes.sale),
        estimate: normalizeModeDraft('estimate', input.modes?.estimate, fallback.modes.estimate)
      },
      ui: { ...fallback.ui, ...(input.ui || {}) },
      createdAt: text(input.createdAt) || fallback.createdAt,
      updatedAt: text(input.updatedAt) || fallback.updatedAt
    };
  }

  function createBatch(input = {}) {
    return {
      batchId: text(input.batchId) || createId('SIBATCH', input.now, input.random),
      sequence: Number(input.sequence || 1),
      method: text(input.method || 'text'),
      sourceType: text(input.sourceType || 'GENERAL_TEXT'),
      sourceName: text(input.sourceName),
      sourceRole: text(input.sourceRole),
      automatic: Boolean(input.automatic),
      rawText: String(input.rawText ?? ''),
      contentHash: text(input.contentHash),
      sourceImageId: text(input.sourceImageId),
      sourceImageHash: text(input.sourceImageHash),
      intakeSessionId: text(input.intakeSessionId),
      intakeDocumentId: text(input.intakeDocumentId),
      ocrStatus: text(input.ocrStatus),
      ocrConfidence: numberOrNull(input.ocrConfidence),
      ocrVariant: text(input.ocrVariant),
      ocrTotals: input.ocrTotals && typeof input.ocrTotals === 'object' ? { ...input.ocrTotals } : null,
      createdAt: new Date(input.now || Date.now()).toISOString()
    };
  }

  function duplicateKey(row) {
    const product = text(row.productId || row.itemCode || row.itemName).toLowerCase().replace(/\s+/g, '');
    const spec = text(row.specification).toLowerCase().replace(/\s+/g, '');
    return product ? `${product}|${spec}` : '';
  }

  function markDuplicatePossibilities(rows) {
    const counts = new Map();
    rows.forEach(row => {
      const key = duplicateKey(row);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    });
    return rows.map(row => ({ ...row, duplicatePossible: Boolean(duplicateKey(row) && counts.get(duplicateKey(row)) > 1) }));
  }

  function mergePreservingEdits(previous, next) {
    const merged = { ...previous, ...next, editedFields: { ...(previous.editedFields || {}) } };
    ROW_FIELDS.forEach(field => {
      if (previous.editedFields?.[field]) merged[field] = previous[field];
    });
    if (previous.unitPriceReviewStatus === 'CONFIRMED' && Number(previous.unitPrice) === Number(next.unitPrice)) {
      merged.unitPriceReviewStatus = 'CONFIRMED';
    }
    merged.rowId = previous.rowId;
    return merged;
  }

  function applyParserResults(existingRows, batch, lines = []) {
    const rows = (existingRows || []).map(row => normalizeRow(row));
    const bySource = new Map(rows.filter(row => row.sourceLineKey).map(row => [row.sourceLineKey, row]));
    (lines || []).forEach((line, index) => {
      const next = normalizeRow({
        ...line,
        batchId: batch.batchId,
        batchSequence: batch.sequence,
        sourceLineNo: Number(line.sourceLineNo || index + 1),
        rawText: line.rawText ?? line.rawExpression ?? line.productText ?? ''
      }, batch.batchId);
      const previous = next.sourceLineKey ? bySource.get(next.sourceLineKey) : null;
      if (previous) {
        const at = rows.findIndex(row => row.rowId === previous.rowId);
        rows[at] = mergePreservingEdits(previous, next);
      } else {
        rows.push(next);
      }
    });
    return markDuplicatePossibilities(rows);
  }

  function markUserEdit(row, field, value) {
    if (!ROW_FIELDS.includes(field)) return normalizeRow(row);
    return normalizeRow({ ...row, [field]: value, editedFields: { ...(row.editedFields || {}), [field]: true } });
  }

  function markProductEdit(row, field, value) {
    const next = markUserEdit(row, field, value);
    if (!['itemCode', 'itemName'].includes(field)) return next;
    return normalizeRow({
      ...next,
      productId: '',
      masterProductId: '',
      matchStatus: 'SIMILAR',
      reviewStatus: 'PENDING',
      productIdentityStatus: 'UNRESOLVED',
      matchSource: '',
      candidateProducts: []
    });
  }

  function summarizeRows(rows = []) {
    const summary = { total: rows.length, matched: 0, similar: 0, unresolved: 0, duplicate: 0, quantity: 0, amount: 0 };
    rows.forEach(row => {
      if (row.matchStatus === 'MATCHED') summary.matched += 1;
      else if (row.matchStatus === 'SIMILAR') summary.similar += 1;
      else summary.unresolved += 1;
      if (row.duplicatePossible) summary.duplicate += 1;
      summary.quantity += Number(row.quantity || 0);
      summary.amount += Number(row.quantity || 0) * Number(row.unitPrice || 0);
    });
    return summary;
  }

  function validateOrderDraft(modeDraft) {
    const errors = [];
    const header = modeDraft?.header || {};
    const rows = Array.isArray(modeDraft?.rows) ? modeDraft.rows : [];
    if (!text(header.customerId) || !text(header.customerName)) errors.push({ field: 'customer', message: '등록된 거래처를 선택하세요.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text(header.orderDate))) errors.push({ field: 'orderDate', message: '주문일자를 확인하세요.' });
    if (!text(header.warehouseName)) errors.push({ field: 'warehouse', message: '출하창고를 입력하세요.' });
    if (!rows.length) errors.push({ field: 'rows', message: '상품을 1개 이상 입력하세요.' });
    rows.forEach((row, index) => {
      if (!text(row.itemName) && !text(row.itemCode)) errors.push({ field: `row:${index}:item`, message: `${index + 1}행 상품을 입력하세요.` });
      if (numberOrNull(row.quantity) === null) errors.push({ field: `row:${index}:quantity`, message: `${index + 1}행 수량을 입력하세요.` });
    });
    return errors;
  }

  global.SMART_INPUT_CONTRACT = Object.freeze({
    SCHEMA_VERSION,
    DRAFT_STORAGE_KEY,
    DRAFT_LIST_STORAGE_KEY,
    DELIVERY_HISTORY_KEY,
    SETTINGS_STORAGE_KEY,
    APP_ID,
    MODES,
    INPUT_METHODS,
    STAGES,
    PRODUCT_FIELD_GROUPS,
    ROW_FIELDS,
    HEADER_FIELD_DEFINITIONS,
    VOUCHER_COLUMN_DEFINITIONS,
    PRODUCT_FIELD_DEFINITIONS,
    DEFAULT_SETTINGS,
    WEEKDAY_LABELS,
    text,
    numberOrNull,
    createId,
    todayLocal,
    businessDate,
    normalizeSettings,
    effectiveDeliveryWeekdays,
    validateDeliveryDate,
    nextDeliveryDate,
    deliveryWeekdayLabel,
    createDraft,
    normalizeModeDraft,
    normalizeDraft,
    normalizeRow,
    createBatch,
    applyParserResults,
    markUserEdit,
    markProductEdit,
    markDuplicatePossibilities,
    summarizeRows,
    validateOrderDraft
  });
})(typeof window !== 'undefined' ? window : globalThis);
