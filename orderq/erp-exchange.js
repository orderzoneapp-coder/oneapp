export const ERP_DOCUMENT_TYPE = Object.freeze({ SALES: 'SALES', PURCHASE: 'PURCHASE' });
export const ERP_MATCH_STATUS = Object.freeze({
  EXACT: 'EXACT',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  CONTENT_CONFLICT: 'CONTENT_CONFLICT',
  NOT_FOUND: 'NOT_FOUND'
});

const TRANSITIONS = Object.freeze({
  READY: ['EXPORTED', 'CORRECTION_REQUIRED'],
  EXPORTED: ['POSTED', 'CORRECTION_REQUIRED'],
  POSTED: ['RECONCILED', 'CORRECTION_REQUIRED'],
  RECONCILED: ['CORRECTION_REQUIRED'],
  CORRECTION_REQUIRED: ['EXPORTED']
});

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function numberOrBlank(value) {
  if (value === '' || value === null || value === undefined) return '';
  const number = Number(value);
  return Number.isFinite(number) ? number : '';
}

function sameNumber(left, right) {
  if (left === '' || right === '') return left === right;
  return Math.abs(Number(left) - Number(right)) <= 1e-9;
}

function documentRows(documentType, documents, lines, statuses = ['READY']) {
  const idField = documentType === ERP_DOCUMENT_TYPE.SALES ? 'salesDocumentId' : 'purchaseDocumentId';
  const lineIdField = documentType === ERP_DOCUMENT_TYPE.SALES ? 'salesLineId' : 'purchaseLineId';
  const dateField = documentType === ERP_DOCUMENT_TYPE.SALES ? 'salesDate' : 'purchaseDate';
  const quantityField = documentType === ERP_DOCUMENT_TYPE.SALES ? 'actualQuantity' : 'quantity';
  const allowedStatuses = new Set((Array.isArray(statuses) ? statuses : [statuses]).map(value => text(value).toUpperCase()));
  return documents.filter(document => allowedStatuses.has(text(document.erpPostingStatus).toUpperCase())).flatMap(document =>
    lines.filter(line => text(line[idField]) === text(document[idField])).map((line, index) => ({
      documentType,
      orderqDocumentId: text(document[idField]),
      orderqLineId: text(line[lineIdField]),
      originSystem: text(document.originSystem || 'ORDER_Q'),
      originTransactionId: text(document.originTransactionId || document[idField]),
      originLineId: text(line.originTransactionId || line[lineIdField]),
      businessDate: text(document.businessDate || document[dateField]),
      externalDocumentNo: text(document.externalDocumentNo ?? document.erpDocumentNo),
      externalLineNo: line.externalLineNo === undefined || line.externalLineNo === null ? '' : String(line.externalLineNo),
      customerOrSupplierId: text(document.customerId || document.supplierId),
      customerOrSupplierName: text(document.customerName || document.supplierName),
      productId: text(line.productId || line.actualProductId),
      productCode: text(line.productCode),
      productName: text(line.productName),
      warehouseId: text(line.warehouseId || document.warehouseId),
      warehouseCode: text(line.warehouseCode || document.warehouseCode),
      quantity: numberOrBlank(line[quantityField]),
      actualQuantity: numberOrBlank(line.actualQuantity ?? line.quantity),
      actualBaseQuantity: numberOrBlank(line.actualBaseQuantity ?? line.baseQuantity),
      recognizedOrderQuantity: documentType === ERP_DOCUMENT_TYPE.SALES
        ? numberOrBlank(line.recognizedOrderQuantity ?? line.actualQuantity ?? line.quantity)
        : '',
      unitPriceWon: numberOrBlank(line.appliedUnitPriceWon ?? line.unitCostWon ?? line.unitPriceWon),
      supplyAmountWon: numberOrBlank(line.supplyAmountWon ?? line.amountWon),
      vatAmountWon: numberOrBlank(line.vatAmountWon),
      totalAmountWon: numberOrBlank(line.totalAmountWon ?? line.amountWon),
      importBatchId: text(document.importBatchId),
      sourceFingerprint: text(document.sourceFingerprint),
      sourceLineFingerprint: text(line.sourceLineFingerprint),
      erpPostingStatus: text(document.erpPostingStatus).toUpperCase()
    }))
  );
}

export function buildErpExportRows({ salesDocuments = [], salesLines = [], purchaseDocuments = [], purchaseLines = [] } = {}, statuses = ['READY']) {
  return {
    sales: documentRows(ERP_DOCUMENT_TYPE.SALES, salesDocuments, salesLines, statuses),
    purchases: documentRows(ERP_DOCUMENT_TYPE.PURCHASE, purchaseDocuments, purchaseLines, statuses)
  };
}

export function createErpWorkbookBuffer(rows, XLSXRef = globalThis.XLSX) {
  if (!XLSXRef?.utils?.book_new || !XLSXRef?.write) throw new Error('ORDERQ_ERP_XLSX_LIBRARY_REQUIRED');
  const workbook = XLSXRef.utils.book_new();
  const salesSheet = XLSXRef.utils.json_to_sheet(rows.sales || [], { raw: true });
  const purchaseSheet = XLSXRef.utils.json_to_sheet(rows.purchases || [], { raw: true });
  XLSXRef.utils.book_append_sheet(workbook, salesSheet, '판매');
  XLSXRef.utils.book_append_sheet(workbook, purchaseSheet, '구매');
  return XLSXRef.write(workbook, { bookType: 'xlsx', type: 'array', cellDates: false });
}

export function transitionErpPostingStatus(document, nextStatus, evidence = {}) {
  const current = text(document?.erpPostingStatus).toUpperCase();
  const next = text(nextStatus).toUpperCase();
  if (!(TRANSITIONS[current] || []).includes(next)) throw new Error(`ORDERQ_ERP_STATUS_TRANSITION_INVALID:${current}:${next}`);
  const erpDocumentNo = text(evidence.erpDocumentNo || document.erpDocumentNo);
  if (['POSTED', 'RECONCILED', 'CORRECTION_REQUIRED'].includes(next) && !erpDocumentNo) {
    throw new Error(`ORDERQ_ERP_DOCUMENT_NO_REQUIRED:${next}`);
  }
  const at = text(evidence.at || new Date().toISOString());
  const actorId = text(evidence.actorId || 'ADMIN');
  return {
    ...document,
    erpPostingStatus: next,
    erpDocumentNo,
    erpExportBatchId: text(evidence.erpExportBatchId || document.erpExportBatchId),
    erpExportedAt: next === 'EXPORTED' ? at : text(document.erpExportedAt),
    erpExportedBy: next === 'EXPORTED' ? actorId : text(document.erpExportedBy),
    erpPostedAt: next === 'POSTED' ? at : text(document.erpPostedAt),
    erpPostedBy: next === 'POSTED' ? actorId : text(document.erpPostedBy),
    erpReconciledAt: next === 'RECONCILED' ? at : text(document.erpReconciledAt),
    erpReconciledBy: next === 'RECONCILED' ? actorId : text(document.erpReconciledBy),
    originalErpDocumentNo: next === 'CORRECTION_REQUIRED'
      ? text(document.originalErpDocumentNo || erpDocumentNo)
      : text(document.originalErpDocumentNo),
    erpAutoCancelRequested: false,
    erpAutoRetransmitRequested: false,
    history: [...(Array.isArray(document.history) ? document.history : []), {
      eventType:`ERP_${next}`,
      previousStatus:current,
      nextStatus:next,
      actorId,
      occurredAt:at,
      erpDocumentNo
    }]
  };
}

const ERP_TEXT_CONTENT_FIELDS = Object.freeze([
  'documentType', 'orderqDocumentId', 'orderqLineId', 'originSystem', 'originTransactionId', 'originLineId',
  'businessDate', 'customerOrSupplierId', 'customerOrSupplierName', 'productId', 'productCode', 'productName',
  'warehouseId', 'warehouseCode', 'importBatchId', 'sourceFingerprint', 'sourceLineFingerprint'
]);
const ERP_NUMBER_CONTENT_FIELDS = Object.freeze([
  'quantity', 'actualQuantity', 'actualBaseQuantity', 'recognizedOrderQuantity', 'unitPriceWon',
  'supplyAmountWon', 'vatAmountWon', 'totalAmountWon'
]);

function rowContentMatches(imported, candidate) {
  return ERP_TEXT_CONTENT_FIELDS.every(field => text(imported[field]) === text(candidate[field]))
    && ERP_NUMBER_CONTENT_FIELDS.every(field => sameNumber(numberOrBlank(imported[field]), numberOrBlank(candidate[field])));
}

function exactIdentity(imported, candidate) {
  if (text(imported.orderqDocumentId) && text(imported.orderqLineId)) {
    return text(imported.orderqDocumentId) === text(candidate.orderqDocumentId)
      && text(imported.orderqLineId) === text(candidate.orderqLineId);
  }
  if (text(imported.originTransactionId) && text(imported.originLineId)) {
    return text(imported.originTransactionId) === text(candidate.originTransactionId)
      && text(imported.originLineId) === text(candidate.originLineId);
  }
  if (text(imported.externalDocumentNo) && text(imported.externalLineNo)) {
    return text(imported.externalDocumentNo) === text(candidate.externalDocumentNo)
      && text(imported.externalLineNo) === text(candidate.externalLineNo);
  }
  return false;
}

function similar(imported, candidate) {
  return text(imported.documentType).toUpperCase() === text(candidate.documentType).toUpperCase()
    && text(imported.businessDate) === text(candidate.businessDate)
    && text(imported.customerOrSupplierId || imported.customerOrSupplierName)
      === text(candidate.customerOrSupplierId || candidate.customerOrSupplierName)
    && text(imported.productId || imported.productCode) === text(candidate.productId || candidate.productCode)
    && sameNumber(numberOrBlank(imported.quantity), numberOrBlank(candidate.quantity));
}

export function reconcileErpImportRows(importRows = [], candidates = []) {
  return importRows.map((source, index) => {
    const imported = { ...source, documentType: text(source.documentType).toUpperCase() };
    const exact = candidates.filter(candidate => exactIdentity(imported, candidate));
    if (exact.length === 1) {
      return {
        importIndex: index,
        status: rowContentMatches(imported, exact[0]) ? ERP_MATCH_STATUS.EXACT : ERP_MATCH_STATUS.CONTENT_CONFLICT,
        imported,
        candidates: exact
      };
    }
    if (exact.length > 1) return { importIndex:index, status:ERP_MATCH_STATUS.REVIEW_REQUIRED, imported, candidates:exact };
    const reviews = candidates.filter(candidate => similar(imported, candidate));
    return {
      importIndex:index,
      status: reviews.length ? ERP_MATCH_STATUS.REVIEW_REQUIRED : ERP_MATCH_STATUS.NOT_FOUND,
      imported,
      candidates:reviews
    };
  });
}

function erpDocumentKey(row) {
  const documentType = text(row?.documentType).toUpperCase();
  const documentId = text(row?.orderqDocumentId);
  return documentType && documentId ? `${documentType}:${documentId}` : '';
}

function erpLineKey(row) {
  const documentKey = erpDocumentKey(row);
  const lineId = text(row?.orderqLineId);
  return documentKey && lineId ? `${documentKey}:${lineId}` : '';
}

export function evaluateErpDocumentMatches(reconciledRows = [], candidates = []) {
  const expectedByDocument = new Map();
  candidates.forEach(candidate => {
    const key = erpDocumentKey(candidate);
    if (!key) return;
    if (!expectedByDocument.has(key)) expectedByDocument.set(key, []);
    expectedByDocument.get(key).push(candidate);
  });
  return [...expectedByDocument.entries()].map(([key, expectedRows]) => {
    const related = reconciledRows.filter(result => {
      if (erpDocumentKey(result.imported) === key) return true;
      return (result.candidates || []).some(candidate => erpDocumentKey(candidate) === key);
    });
    const exactRows = related.filter(result => result.status === ERP_MATCH_STATUS.EXACT
      && result.candidates.length === 1 && erpDocumentKey(result.candidates[0]) === key);
    const exactCounts = new Map();
    exactRows.forEach(result => {
      const lineKey = erpLineKey(result.candidates[0]);
      exactCounts.set(lineKey, Number(exactCounts.get(lineKey) || 0) + 1);
    });
    const expectedLineKeys = expectedRows.map(erpLineKey);
    const lineSetComplete = expectedLineKeys.length > 0
      && expectedLineKeys.every(lineKey => exactCounts.get(lineKey) === 1)
      && [...exactCounts.keys()].every(lineKey => expectedLineKeys.includes(lineKey));
    const issueRows = related.filter(result => result.status !== ERP_MATCH_STATUS.EXACT || result.candidates.length !== 1);
    const erpDocumentNos = [...new Set(exactRows.map(result => text(result.imported.externalDocumentNo)).filter(Boolean))];
    const exact = lineSetComplete && exactRows.length === expectedRows.length && issueRows.length === 0
      && erpDocumentNos.length === 1;
    return {
      key,
      documentType:text(expectedRows[0]?.documentType).toUpperCase(),
      orderqDocumentId:text(expectedRows[0]?.orderqDocumentId),
      status:exact ? ERP_MATCH_STATUS.EXACT : ERP_MATCH_STATUS.REVIEW_REQUIRED,
      expectedCount:expectedRows.length,
      exactCount:exactRows.length,
      issueCount:issueRows.length + Math.max(0, expectedRows.length - exactRows.length),
      erpDocumentNo:exact ? erpDocumentNos[0] : '',
      currentStatus:text(expectedRows[0]?.erpPostingStatus).toUpperCase(),
      exactRows
    };
  });
}
