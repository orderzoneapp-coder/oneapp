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
  const ROW_FIELDS = Object.freeze(['itemCode', 'itemName', 'specification', 'quantity', 'unit', 'unitPrice', 'memo', 'description', 'noticePrice']);
  const HEADER_FIELD_DEFINITIONS = Object.freeze([
    Object.freeze({ id: 'customer', label: '배송 거래처', required: true }),
    Object.freeze({ id: 'taxCustomer', label: '세무 거래처', required: false }),
    Object.freeze({ id: 'deliveryDate', label: '배송일자', required: true }),
    Object.freeze({ id: 'warehouse', label: '출하창고', required: true }),
    Object.freeze({ id: 'transactionType', label: '거래유형', required: false })
  ]);
  const VOUCHER_COLUMN_DEFINITIONS = Object.freeze([
    Object.freeze({ id: 'itemCode', label: '품목코드', required: false }),
    Object.freeze({ id: 'itemName', label: '품목명', required: true }),
    Object.freeze({ id: 'specification', label: '규격', required: false }),
    Object.freeze({ id: 'quantity', label: '수량', required: true }),
    Object.freeze({ id: 'unit', label: '단위', required: false }),
    Object.freeze({ id: 'unitPrice', label: '단가', required: false }),
    Object.freeze({ id: 'supplyAmount', label: '공급가액', required: false }),
    Object.freeze({ id: 'memo', label: '메모', required: false }),
    Object.freeze({ id: 'description', label: '적요(직원)', required: false }),
    Object.freeze({ id: 'noticePrice', label: '공지단가', required: false })
  ]);
  const DEFAULT_SETTINGS = Object.freeze({
    orderCutoffTime: '',
    allowSameDayDelivery: true,
    defaultDeliveryWeekdays: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
    deliveryCustomerWeekdays: Object.freeze({}),
    holidayWeekdays: Object.freeze([]),
    holidayDates: Object.freeze([]),
    timezone: 'Asia/Seoul',
    headerFields: Object.freeze(HEADER_FIELD_DEFINITIONS.map(field => field.id)),
    voucherColumns: Object.freeze(VOUCHER_COLUMN_DEFINITIONS.map(field => field.id)),
    customFields: Object.freeze([])
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
    const customFields = (Array.isArray(value.customFields) ? value.customFields : []).map((field, index) => {
      const scope = field?.scope === 'voucher' ? 'voucher' : 'header';
      const category = ['PRODUCT', 'CUSTOMER', 'CUSTOM'].includes(text(field?.category).toUpperCase())
        ? text(field.category).toUpperCase()
        : 'CUSTOM';
      const label = text(field?.label);
      if (!label) return null;
      return {
        id: text(field?.id) || `custom-${scope}-${index + 1}`,
        label,
        scope,
        category,
        sourceField: text(field?.sourceField)
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
      const requested = Array.isArray(selected) ? selected.map(text).filter(id => allowed.has(id)) : [...fallback];
      const requestedSet = new Set(requested);
      definitions.filter(field => field.required).forEach(field => requestedSet.add(field.id));
      return [...definitions.map(field => field.id), ...customFields.filter(field => field.scope === scope).map(field => field.id)].filter(id => requestedSet.has(id));
    };
    return {
      orderCutoffTime: /^\d{2}:\d{2}$/.test(text(value.orderCutoffTime)) ? text(value.orderCutoffTime) : '',
      allowSameDayDelivery: value.allowSameDayDelivery !== false,
      defaultDeliveryWeekdays: normalizeWeekdays(value.defaultDeliveryWeekdays, DEFAULT_SETTINGS.defaultDeliveryWeekdays),
      deliveryCustomerWeekdays,
      holidayWeekdays: normalizeWeekdays(value.holidayWeekdays, DEFAULT_SETTINGS.holidayWeekdays),
      holidayDates: [...new Set((Array.isArray(value.holidayDates) ? value.holidayDates : []).map(text).filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort(),
      timezone: text(value.timezone || DEFAULT_SETTINGS.timezone),
      headerFields: normalizeLayout(value.headerFields, HEADER_FIELD_DEFINITIONS, DEFAULT_SETTINGS.headerFields, 'header'),
      voucherColumns: normalizeLayout(value.voucherColumns, VOUCHER_COLUMN_DEFINITIONS, DEFAULT_SETTINGS.voucherColumns, 'voucher'),
      customFields
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
    return {
      rowId: text(input.rowId) || createId('SIROW'),
      batchId: text(input.batchId || fallbackBatchId),
      batchSequence: Number(input.batchSequence || 0),
      sourceLineNo: Number(input.sourceLineNo || 0),
      sourceLineKey: text(input.sourceLineKey),
      intakeLineId: text(input.intakeLineId),
      sourceRegion: normalizeSourceRegion(input.sourceRegion),
      rawText: String(input.rawText ?? input.rawExpression ?? ''),
      productId,
      masterProductId,
      itemCode,
      itemName: text(input.itemName || input.productText),
      specification: text(input.specification),
      quantity: numberOrNull(input.quantity ?? input.finalQuantity ?? input.rawQuantity),
      unit: text(input.unit || input.finalUnit || input.rawUnit),
      unitPrice: numberOrNull(input.unitPrice ?? input.price),
      memo: text(input.memo),
      description: text(input.description),
      noticePrice: numberOrNull(input.noticePrice) ?? 0,
      customValues: input.customValues && typeof input.customValues === 'object' ? { ...input.customValues } : {},
      matchStatus: ['MATCHED', 'SIMILAR', 'UNRESOLVED'].includes(matchStatus) ? matchStatus : 'UNRESOLVED',
      candidateProducts,
      editedFields: input.editedFields && typeof input.editedFields === 'object' ? { ...input.editedFields } : {},
      duplicatePossible: Boolean(input.duplicatePossible),
      reviewStatus: hasMasterIdentity ? 'CONFIRMED' : 'PENDING',
      productIdentityStatus: hasMasterIdentity ? 'MASTER_LINKED' : 'UNRESOLVED'
    };
  }

  function normalizeModeDraft(mode, input = {}, fallback = createModeDraft(mode)) {
    return {
      documentId: text(input.documentId) || fallback.documentId,
      catalogRecordId: text(input.catalogRecordId),
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
    ROW_FIELDS,
    HEADER_FIELD_DEFINITIONS,
    VOUCHER_COLUMN_DEFINITIONS,
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
