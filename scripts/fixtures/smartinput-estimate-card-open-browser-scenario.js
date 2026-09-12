const TIMESTAMP = '2026-09-12T00:00:00.000Z';

function row({ rowId, itemCode, itemName, quantity = 1, sourceEstimateId = '' }) {
  const linked = Boolean(sourceEstimateId);
  return {
    rowId,
    itemCode,
    itemName,
    specification: '',
    quantity,
    unit: 'EA',
    unitPrice: 1000,
    sourceUnitPrice: '1000',
    outPrice: 1200,
    matchStatus: 'MATCHED',
    reviewStatus: 'CONFIRMED',
    productIdentityStatus: 'MASTER_LINKED',
    inputOwnership: linked ? 'SOURCE' : 'USER',
    editedFields: {},
    linkedSourceEstimateId: sourceEstimateId,
    linkedSourceEstimateName: sourceEstimateId,
    linkedSourceRowId: linked ? 'SOURCE-ROW-1' : '',
    linkedSourceEstimateIds: linked ? [sourceEstimateId] : [],
    linkedSourceRefs: linked ? [{ estimateId: sourceEstimateId, rowId: 'SOURCE-ROW-1' }] : []
  };
}

function individualEstimate({ estimateId, catalogName, prefix, rowCount, sortOrder }) {
  const rows = Array.from({ length: rowCount }, (_, index) => row({
    rowId: `${estimateId}-ROW-${index + 1}`,
    itemCode: `${prefix}-${String(index + 1).padStart(2, '0')}`,
    itemName: `${catalogName} 품목 ${index + 1}`,
    quantity: index + 1
  }));
  return {
    estimateId,
    catalogName,
    estimateKind: 'INDIVIDUAL',
    linkedEstimateSources: [],
    rowCount: rows.length,
    amount: rows.reduce((total, item) => total + (Number(item.quantity) * Number(item.unitPrice)), 0),
    sortOrder,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    draft: {
      catalogRecordId: estimateId,
      estimateKind: 'INDIVIDUAL',
      linkedEstimateSources: [],
      header: {},
      sourceText: '',
      activeMethod: 'direct',
      batches: [],
      rows,
      updatedAt: TIMESTAMP
    }
  };
}

function staleMappedEstimate() {
  const headers = ['품목코드', '품목명', '수량'];
  const sourceMatrix = [
    headers,
    ['MAP-01', '매핑 품목 1', '2'],
    ['MAP-02', '매핑 품목 2', '4']
  ];
  const mappings = [
    { columnIndex: 0, sourceHeader: headers[0], state: 'MAPPED', targetFieldId: 'voucher.estimate.line.productCode', reviewed: true },
    { columnIndex: 1, sourceHeader: headers[1], state: 'MAPPED', targetFieldId: 'voucher.estimate.line.productName', reviewed: true },
    { columnIndex: 2, sourceHeader: headers[2], state: 'MAPPED', targetFieldId: 'voucher.estimate.line.quantity', reviewed: true }
  ];
  const rows = [
    row({ rowId: 'source-1', itemCode: 'MAP-01', itemName: '매핑 품목 1', quantity: 2 }),
    row({ rowId: 'source-2', itemCode: 'MAP-02', itemName: '매핑 품목 2', quantity: 4 })
  ];
  return {
    estimateId: 'EST-MAPPED',
    catalogName: '원본형 매핑 견적',
    estimateKind: 'INDIVIDUAL',
    linkedEstimateSources: [],
    rowCount: rows.length,
    amount: 6000,
    sortOrder: 3,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    draft: {
      catalogRecordId: 'EST-MAPPED',
      estimateKind: 'INDIVIDUAL',
      linkedEstimateSources: [],
      header: {},
      sourceText: sourceMatrix.map(sourceRow => sourceRow.join('\t')).join('\n'),
      activeMethod: 'excel',
      batches: [],
      rows,
      inputMapping: {
        schemaVersion: 'ONEAPP_SMARTINPUT_MAPPING_SESSION_V2',
        sessionId: 'SIMAP-STALE-FIXTURE',
        companyId: 'ONEAPP',
        voucherMode: 'estimate',
        fileName: 'stale-mapping.xlsx',
        sheetName: '원본',
        fileFingerprint: 'fixture-stale-mapping',
        sourceMatrix,
        sourceCellMatrix: [],
        headerRowIndex: 0,
        headers,
        headerSignature: JSON.stringify(headers),
        signature: JSON.stringify({ companyId: 'ONEAPP', voucherMode: 'estimate', headers }),
        status: 'TEMPLATE_APPLIED',
        templateId: 'FIXTURE-TEMPLATE',
        templateName: '견적 매핑 fixture',
        templateRevision: 1,
        mappings,
        issues: [],
        editJournal: {},
        manualRows: [],
        hiddenColumns: [2],
        // Deliberately stale: source-2 is absent although sourceMatrix and draft rows still contain it.
        workingRows: [{
          rowId: 'source-1',
          sourceRowIndex: 1,
          cells: ['STALE-CODE', '오래된 파생행', '99'],
          sourceCells: [],
          manual: false
        }],
        updatedAt: TIMESTAMP
      },
      updatedAt: TIMESTAMP
    }
  };
}

function invalidMappedTargetEstimate() {
  const estimate = staleMappedEstimate();
  return {
    ...estimate,
    estimateId: 'EST-MAPPING-INVALID',
    catalogName: '삭제된 연결 대상 매핑',
    sortOrder: 4,
    draft: {
      ...estimate.draft,
      catalogRecordId: 'EST-MAPPING-INVALID',
      inputMapping: {
        ...estimate.draft.inputMapping,
        sessionId: 'SIMAP-INVALID-TARGET-FIXTURE',
        mappings: estimate.draft.inputMapping.mappings.map((mapping, index) => index === 0
          ? { ...mapping, targetFieldId: 'voucher.estimate.line.removedField' }
          : { ...mapping })
      }
    }
  };
}

function staleHeaderMappedEstimate() {
  const estimate = staleMappedEstimate();
  const sourceMatrix = estimate.draft.inputMapping.sourceMatrix.map((sourceRow, index) => [
    ...sourceRow,
    index === 0 ? '거래처명' : '과거 거래처'
  ]);
  const headers = [...sourceMatrix[0]];
  return {
    ...estimate,
    estimateId: 'EST-HEADER-MAPPING-STALE',
    catalogName: '상단 매핑 불일치',
    sortOrder: 5,
    draft: {
      ...estimate.draft,
      catalogRecordId: 'EST-HEADER-MAPPING-STALE',
      sourceText: sourceMatrix.map(sourceRow => sourceRow.join('\t')).join('\n'),
      rows: estimate.draft.rows.map(item => ({ ...item, rowCustomerName: '현재 거래처' })),
      inputMapping: {
        ...estimate.draft.inputMapping,
        sessionId: 'SIMAP-STALE-HEADER-FIXTURE',
        sourceMatrix,
        headers,
        headerSignature: JSON.stringify(headers),
        signature: JSON.stringify({ companyId: 'ONEAPP', voucherMode: 'estimate', headers }),
        mappings: [
          ...estimate.draft.inputMapping.mappings.map(mapping => ({ ...mapping })),
          { columnIndex: 3, sourceHeader: headers[3], state: 'MAPPED', targetFieldId: 'customer', reviewed: true }
        ],
        workingRows: estimate.draft.inputMapping.workingRows.map(item => ({
          ...item,
          cells: [...item.cells, '과거 거래처']
        }))
      }
    }
  };
}

function invalidRowIdentityEstimate() {
  const estimate = individualEstimate({
    estimateId: 'EST-ROW-ID-INVALID',
    catalogName: '행 식별자 누락',
    prefix: 'INVALID-ROW',
    rowCount: 1,
    sortOrder: 6
  });
  estimate.draft.rows[0].rowId = '';
  return estimate;
}

function allMissingLinkedEstimate() {
  const sources = [
    { estimateId: 'SOURCE-GONE-A', catalogName: '삭제된 원본 A' },
    { estimateId: 'SOURCE-GONE-B', catalogName: '삭제된 원본 B' }
  ];
  const rows = sources.map((source, index) => row({
    rowId: `LINKED:${source.estimateId}:SOURCE-ROW-1`,
    itemCode: `SNAP-${index + 1}`,
    itemName: `저장 Snapshot 품목 ${index + 1}`,
    quantity: index + 1,
    sourceEstimateId: source.estimateId
  }));
  const headers = ['품목코드', '품목명', '수량'];
  const sourceMatrix = [headers, ...rows.map(item => [item.itemCode, item.itemName, String(item.quantity)])];
  const mappings = [
    { columnIndex: 0, sourceHeader: headers[0], state: 'MAPPED', targetFieldId: 'voucher.estimate.line.productCode', reviewed: true },
    { columnIndex: 1, sourceHeader: headers[1], state: 'MAPPED', targetFieldId: 'voucher.estimate.line.productName', reviewed: true },
    { columnIndex: 2, sourceHeader: headers[2], state: 'MAPPED', targetFieldId: 'voucher.estimate.line.quantity', reviewed: true }
  ];
  return {
    estimateId: 'EST-LINKED-ALL',
    catalogName: '전체 원본 누락 연동',
    estimateKind: 'LINKED_GROUP',
    linkedEstimateSources: sources,
    rowCount: rows.length,
    amount: rows.reduce((total, item) => total + (Number(item.quantity) * Number(item.unitPrice)), 0),
    sortOrder: 9,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    draft: {
      catalogRecordId: 'EST-LINKED-ALL',
      estimateKind: 'LINKED_GROUP',
      linkedEstimateSources: sources,
      header: {},
      sourceText: sourceMatrix.map(sourceRow => sourceRow.join('\t')).join('\n'),
      activeMethod: 'excel',
      batches: [],
      rows,
      inputMapping: {
        schemaVersion: 'ONEAPP_SMARTINPUT_MAPPING_SESSION_V2',
        sessionId: 'SIMAP-ALL-MISSING-FIXTURE',
        companyId: 'ONEAPP',
        voucherMode: 'estimate',
        fileName: 'all-missing-linked.xlsx',
        sheetName: '원본',
        fileFingerprint: 'fixture-all-missing-linked',
        sourceMatrix,
        sourceCellMatrix: [],
        headerRowIndex: 0,
        headers,
        headerSignature: JSON.stringify(headers),
        signature: JSON.stringify({ companyId: 'ONEAPP', voucherMode: 'estimate', headers }),
        status: 'TEMPLATE_APPLIED',
        templateId: 'FIXTURE-ALL-MISSING-TEMPLATE',
        templateName: '전체 누락 매핑 fixture',
        templateRevision: 1,
        mappings,
        issues: [],
        editJournal: {},
        manualRows: [],
        hiddenColumns: [2],
        deletedSourceRows: [],
        // Deliberately stale: the second source row is absent from the derived cache.
        workingRows: rows.slice(0, 1).map((item, index) => ({
          rowId: item.rowId,
          sourceRowIndex: index + 1,
          cells: [item.itemCode, item.itemName, String(item.quantity)],
          sourceCells: [],
          manual: false
        })),
        updatedAt: TIMESTAMP
      },
      updatedAt: TIMESTAMP
    }
  };
}

function partialMissingMappedScenario() {
  const sourceEstimate = individualEstimate({
    estimateId: 'EST-PARTIAL-SOURCE-B',
    catalogName: '남은 동일 품목 원본 B',
    prefix: 'SHARED',
    rowCount: 1,
    sortOrder: 7
  });
  const sourceRow = sourceEstimate.draft.rows[0];
  const missingEstimateId = 'SOURCE-GONE-SHARED-A';
  const missingRowId = 'SOURCE-GONE-SHARED-A-ROW-1';
  const snapshotRow = row({
    rowId: `LINKED:${missingEstimateId}:${missingRowId}`,
    itemCode: sourceRow.itemCode,
    itemName: sourceRow.itemName,
    quantity: 9,
    sourceEstimateId: missingEstimateId
  });
  snapshotRow.linkedSourceRowId = missingRowId;
  snapshotRow.linkedSourceEstimateIds = [missingEstimateId, sourceEstimate.estimateId];
  snapshotRow.linkedSourceRefs = [
    { estimateId: missingEstimateId, estimateName: '삭제된 동일 품목 원본 A', rowId: missingRowId },
    { estimateId: sourceEstimate.estimateId, estimateName: sourceEstimate.catalogName, rowId: sourceRow.rowId }
  ];
  snapshotRow.linkedSourceEstimateName = '2개 견적서';
  const headers = ['품목코드', '품목명', '수량'];
  const sourceMatrix = [headers, [snapshotRow.itemCode, snapshotRow.itemName, String(snapshotRow.quantity)]];
  const mappings = [
    { columnIndex: 0, sourceHeader: headers[0], state: 'MAPPED', targetFieldId: 'voucher.estimate.line.productCode', reviewed: true },
    { columnIndex: 1, sourceHeader: headers[1], state: 'MAPPED', targetFieldId: 'voucher.estimate.line.productName', reviewed: true },
    { columnIndex: 2, sourceHeader: headers[2], state: 'MAPPED', targetFieldId: 'voucher.estimate.line.quantity', reviewed: true }
  ];
  const linkedEstimate = {
    estimateId: 'EST-LINKED-PARTIAL-SHARED',
    catalogName: '동일 품목 대표 원본 부분 누락',
    estimateKind: 'LINKED_GROUP',
    linkedEstimateSources: [
      { estimateId: missingEstimateId, catalogName: '삭제된 동일 품목 원본 A' },
      { estimateId: sourceEstimate.estimateId, catalogName: sourceEstimate.catalogName }
    ],
    rowCount: 1,
    amount: Number(snapshotRow.quantity) * Number(snapshotRow.unitPrice),
    sortOrder: 10,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    draft: {
      catalogRecordId: 'EST-LINKED-PARTIAL-SHARED',
      estimateKind: 'LINKED_GROUP',
      linkedEstimateSources: [
        { estimateId: missingEstimateId, catalogName: '삭제된 동일 품목 원본 A' },
        { estimateId: sourceEstimate.estimateId, catalogName: sourceEstimate.catalogName }
      ],
      header: {},
      sourceText: sourceMatrix.map(sourceMatrixRow => sourceMatrixRow.join('\t')).join('\n'),
      activeMethod: 'excel',
      batches: [],
      rows: [snapshotRow],
      inputMapping: {
        schemaVersion: 'ONEAPP_SMARTINPUT_MAPPING_SESSION_V2',
        sessionId: 'SIMAP-PARTIAL-SHARED-FIXTURE',
        companyId: 'ONEAPP',
        voucherMode: 'estimate',
        fileName: 'partial-shared-linked.xlsx',
        sheetName: '원본',
        fileFingerprint: 'fixture-partial-shared-linked',
        sourceMatrix,
        sourceCellMatrix: [],
        headerRowIndex: 0,
        headers,
        headerSignature: JSON.stringify(headers),
        signature: JSON.stringify({ companyId: 'ONEAPP', voucherMode: 'estimate', headers }),
        status: 'TEMPLATE_APPLIED',
        templateId: 'FIXTURE-PARTIAL-SHARED-TEMPLATE',
        templateName: '부분 누락 동일 품목 매핑 fixture',
        templateRevision: 1,
        mappings,
        issues: [],
        editJournal: { '1:0': snapshotRow.itemCode },
        manualRows: [],
        hiddenColumns: [2],
        deletedSourceRows: [],
        workingRows: [{
          rowId: snapshotRow.rowId,
          sourceRowIndex: 1,
          cells: [snapshotRow.itemCode, snapshotRow.itemName, String(snapshotRow.quantity)],
          sourceCells: [],
          manual: false
        }],
        updatedAt: TIMESTAMP
      },
      updatedAt: TIMESTAMP
    }
  };
  return { sourceEstimate, linkedEstimate };
}

export function createEstimateCardOpenScenario() {
  const estimateA = individualEstimate({
    estimateId: 'EST-A',
    catalogName: '견적서 A',
    prefix: 'A-CODE',
    rowCount: 12,
    sortOrder: 1
  });
  const estimateB = individualEstimate({
    estimateId: 'EST-B',
    catalogName: '견적서 B',
    prefix: 'B-CODE',
    rowCount: 3,
    sortOrder: 2
  });
  const missingDraft = {
    estimateId: 'EST-NO-DRAFT',
    catalogName: '작업 데이터 누락',
    estimateKind: 'INDIVIDUAL',
    linkedEstimateSources: [],
    rowCount: 0,
    amount: 0,
    sortOrder: 8,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP
  };
  const partialMissing = partialMissingMappedScenario();
  return {
    timestamp: TIMESTAMP,
    estimates: [
      estimateA,
      estimateB,
      staleMappedEstimate(),
      invalidMappedTargetEstimate(),
      staleHeaderMappedEstimate(),
      invalidRowIdentityEstimate(),
      partialMissing.sourceEstimate,
      missingDraft,
      allMissingLinkedEstimate(),
      partialMissing.linkedEstimate
    ]
  };
}
