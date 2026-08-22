(function initSmartInputContract(global) {
  'use strict';

  const SCHEMA_VERSION = 'ONEAPP_SMART_INPUT_DRAFT_V1';
  const DRAFT_STORAGE_KEY = 'oneapp.smartinput.draft.v1';
  const DELIVERY_HISTORY_KEY = 'oneapp.smartinput.delivery-history.v1';
  const APP_ID = 'smart-input';
  const MODE_ORDER = ['order', 'purchase', 'sale'];
  const MODES = Object.freeze({
    order: Object.freeze({ id: 'order', label: '주문서', target: 'ORDERQ_VNEXT_LEDGER' }),
    purchase: Object.freeze({ id: 'purchase', label: '구매', target: 'DATAOPS_PURCHASE_PENDING' }),
    sale: Object.freeze({ id: 'sale', label: '판매', target: 'DATAOPS_SALE_PENDING' })
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
  const ROW_FIELDS = Object.freeze(['itemCode', 'itemName', 'specification', 'quantity', 'unit', 'unitPrice', 'memo']);

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

  function createModeDraft(mode, date = todayLocal()) {
    return {
      mode,
      header: {
        customerId: '',
        customerName: '',
        orderDate: date,
        deliveryDate: '',
        warehouseId: '',
        warehouseCode: '',
        warehouseName: '',
        transactionType: '기타'
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
    const date = options.date || todayLocal();
    return {
      schemaVersion: SCHEMA_VERSION,
      appId: APP_ID,
      draftId: options.draftId || createId('SIDRAFT', options.now, options.random),
      activeMode: MODE_ORDER.includes(options.activeMode) ? options.activeMode : 'order',
      modes: {
        order: createModeDraft('order', date),
        purchase: createModeDraft('purchase', date),
        sale: createModeDraft('sale', date)
      },
      ui: { stage: 'capture', relatedOpen: false, selectedRowId: '', scrollTop: 0 },
      createdAt: new Date(options.now || Date.now()).toISOString(),
      updatedAt: new Date(options.now || Date.now()).toISOString()
    };
  }

  function normalizeHeader(value = {}, fallback = {}) {
    return {
      customerId: text(value.customerId || fallback.customerId),
      customerName: text(value.customerName || fallback.customerName),
      orderDate: text(value.orderDate || fallback.orderDate || todayLocal()),
      deliveryDate: text(value.deliveryDate || fallback.deliveryDate),
      warehouseId: text(value.warehouseId || fallback.warehouseId),
      warehouseCode: text(value.warehouseCode || fallback.warehouseCode),
      warehouseName: text(value.warehouseName || fallback.warehouseName),
      transactionType: text(value.transactionType || fallback.transactionType || '기타')
    };
  }

  function normalizeRow(input = {}, fallbackBatchId = '') {
    const productId = text(input.productId);
    const itemCode = text(input.itemCode);
    const candidateProducts = Array.isArray(input.candidateProducts) ? input.candidateProducts : [];
    const requestedMatchStatus = text(input.matchStatus).toUpperCase();
    const matchStatus = productId && itemCode
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
      rawText: String(input.rawText ?? input.rawExpression ?? ''),
      productId,
      itemCode,
      itemName: text(input.itemName || input.productText),
      specification: text(input.specification),
      quantity: numberOrNull(input.quantity ?? input.finalQuantity ?? input.rawQuantity),
      unit: text(input.unit || input.finalUnit || input.rawUnit),
      unitPrice: numberOrNull(input.unitPrice ?? input.price),
      memo: text(input.memo),
      matchStatus: ['MATCHED', 'SIMILAR', 'UNRESOLVED'].includes(matchStatus) ? matchStatus : 'UNRESOLVED',
      candidateProducts,
      editedFields: input.editedFields && typeof input.editedFields === 'object' ? { ...input.editedFields } : {},
      duplicatePossible: Boolean(input.duplicatePossible),
      reviewStatus: text(input.reviewStatus).toUpperCase() || (productId && itemCode ? 'CONFIRMED' : 'PENDING'),
      productIdentityStatus: text(input.productIdentityStatus).toUpperCase() || (productId && itemCode ? 'MASTER_LINKED' : 'UNRESOLVED')
    };
  }

  function normalizeModeDraft(mode, input = {}, fallback = createModeDraft(mode)) {
    return {
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
        sale: normalizeModeDraft('sale', input.modes?.sale, fallback.modes.sale)
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
      rawText: String(input.rawText ?? ''),
      contentHash: text(input.contentHash),
      intakeSessionId: text(input.intakeSessionId),
      intakeDocumentId: text(input.intakeDocumentId),
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
    DELIVERY_HISTORY_KEY,
    APP_ID,
    MODES,
    INPUT_METHODS,
    STAGES,
    ROW_FIELDS,
    text,
    numberOrNull,
    createId,
    todayLocal,
    createDraft,
    normalizeDraft,
    normalizeRow,
    createBatch,
    applyParserResults,
    markUserEdit,
    markDuplicatePossibilities,
    summarizeRows,
    validateOrderDraft
  });
})(typeof window !== 'undefined' ? window : globalThis);
