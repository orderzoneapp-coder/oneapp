#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  buildEstimateF8Data,
  buildEstimateDuplicateGroups,
  buildEstimateF8RowsFromPlan,
  buildEstimateF8RowsFromDraft,
  calculateEstimateResolvedPrice,
  ESTIMATE_F8_HEADERS
} from '../smartinput/estimate-output.js';
import { buildEstimateF8DraftPlan } from '../smartinput/estimate-f8-source-plan.js';
import {
  applyEstimateF8PartialRecovery,
  createEstimateF8IndependentCopy,
  inspectEstimateF8Integrity
} from '../smartinput/estimate-f8-recovery.js';
import { splitEstimateBulkInputMapping } from '../smartinput/estimate-bulk-update.js';

const ERP_SOURCE_HEADERS = [
  '일자', '창고', '거래처명', '품목명', '규격', '품목코드', '입고가', '출고가', '입고B',
  '도매A', '도매B', '행사가', '적요2', '간단설명', '1종연산', '외주비', '경비', '노무비',
  '재료비', '1종규격', '1종코드', '1입고', '1출고'
];

function parsedValue(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function buildMappedDraft(sourceRows) {
  const mappings = ERP_SOURCE_HEADERS.map((sourceHeader, columnIndex) => ({
    state: 'MAPPED',
    sourceHeader,
    columnIndex,
    targetFieldId: `source_${columnIndex}`
  }));
  const rows = sourceRows.map((sourceRow, rowIndex) => {
    const rowId = `ERP-${rowIndex + 1}`;
    return {
      rowId,
      itemCode: `DIRECT-${rowIndex + 1}`,
      itemName: `직접값-${rowIndex + 1}`,
      unitPrice: 999999,
      fieldValues: Object.fromEntries(mappings.map(mapping => [mapping.targetFieldId, {
        currentDisplayValue: String(sourceRow[mapping.columnIndex] ?? ''),
        parsedValue: parsedValue(sourceRow[mapping.columnIndex])
      }]))
    };
  });
  return {
    rows,
    inputMapping: {
      schemaVersion: 'ONEAPP_SMARTINPUT_MAPPING_SESSION_V2',
      headers: ERP_SOURCE_HEADERS,
      sourceMatrix: [ERP_SOURCE_HEADERS, ...sourceRows],
      sourceCellMatrix: [ERP_SOURCE_HEADERS, ...sourceRows].map(row => row.map(value => ({ displayValue: String(value ?? '') }))),
      headerRowIndex: 0,
      mappings,
      workingRows: sourceRows.map((cells, rowIndex) => ({ rowId: `ERP-${rowIndex + 1}`, sourceRowIndex: rowIndex + 1, cells, manual: false })),
      editJournal: {},
      manualRows: []
    }
  };
}

function buildSourceBackedIndividualDraft({ estimateId, itemCode, itemName, inboundPrice, outPrice }) {
  const draft = buildMappedDraft([[
    '2026-09-05', '02', `거래처-${estimateId}`, itemName, '1박스', itemCode,
    String(inboundPrice), String(outPrice), '', '', '', '', '', `설명-${estimateId}`, '', '', '', '', '', '', '', '', ''
  ]]);
  draft.catalogRecordId = estimateId;
  draft.estimateKind = 'INDIVIDUAL';
  Object.assign(draft.rows[0], {
    marketPrice: 91000,
    brand: `유출금지브랜드-${estimateId}`,
    searchInfo: `유출금지태그-${estimateId}`,
    lastPurchasePrice: 92000
  });
  return draft;
}

function linkedWorkingRow(estimateId, values = {}, editedFields = {}) {
  return {
    rowId: `WORK-${estimateId}`,
    itemCode: `오래된코드-${estimateId}`,
    itemName: `오래된상품-${estimateId}`,
    outPrice: 99000,
    marketPrice: 99100,
    brand: `작업표브랜드-${estimateId}`,
    searchInfo: `작업표태그-${estimateId}`,
    lastPurchasePrice: 99200,
    linkedSourceEstimateId: estimateId,
    linkedSourceRowId: 'ERP-1',
    linkedSourceEstimateIds: [estimateId],
    linkedSourceRefs: [{ estimateId, rowId: 'ERP-1' }],
    editedFields,
    ...values
  };
}

const savedOpenDraft = { catalogRecordId: 'EST-OPEN', marker: 'saved', rows: [{ itemCode: 'SAVED-1' }] };
const unsavedOpenDraft = { catalogRecordId: 'EST-OPEN', marker: 'unsaved', rows: [{ itemCode: 'LIVE-1' }] };
const openEstimatePlan = buildEstimateF8DraftPlan({
  selectedRecords: [{ estimateId: 'EST-OPEN', estimateKind: 'INDIVIDUAL', draft: savedOpenDraft }],
  currentDraft: unsavedOpenDraft,
  individualRecords: [{ estimateId: 'EST-OPEN', estimateKind: 'INDIVIDUAL', draft: savedOpenDraft }]
});
assert.equal(openEstimatePlan.ok, true);
assert.equal(openEstimatePlan.entries[0].kind, 'DIRECT');
assert.equal(openEstimatePlan.entries[0].draft, unsavedOpenDraft,
  '열린 개별 견적서는 저장된 record.draft가 아니라 화면의 저장 전 currentDraft를 출력해야 한다.');
assert.equal(openEstimatePlan.validationDrafts[0], unsavedOpenDraft,
  '열린 개별 견적서 검증에도 실제 출력되는 저장 전 작업표를 사용해야 한다.');

const individualDraftA = buildSourceBackedIndividualDraft({
  estimateId: 'EST-A', itemCode: 'SOURCE-A', itemName: '최신원본상품-A', inboundPrice: 1100, outPrice: 3100
});
individualDraftA.rows[0].brand = '원본견적-사용자브랜드-A';
individualDraftA.rows[0].editedFields = { brand: true };
const individualDraftB = buildSourceBackedIndividualDraft({
  estimateId: 'EST-B', itemCode: 'SOURCE-B', itemName: '최신원본상품-B', inboundPrice: 1200, outPrice: 4200
});
const individualRecords = [
  { estimateId: 'EST-A', estimateKind: 'INDIVIDUAL', draft: individualDraftA },
  { estimateId: 'EST-B', estimateKind: 'INDIVIDUAL', draft: individualDraftB }
];
const compositionPreview = {
  estimateKind: 'COMPOSITION_PREVIEW',
  marker: 'composition-preview',
  linkedEstimateSources: [{ estimateId: 'EST-A' }, { estimateId: 'EST-B' }],
  rows: [
    linkedWorkingRow('EST-A', { outPrice: 7300, marketPrice: 7400 }, { outPrice: true, marketPrice: true }),
    linkedWorkingRow('EST-B')
  ]
};
const compositionPlan = buildEstimateF8DraftPlan({
  creation: { selectedIds: ['EST-A', 'EST-B'] },
  currentDraft: compositionPreview,
  individualRecords
});
assert.equal(compositionPlan.ok, true);
assert.equal(compositionPlan.entries[0].kind, 'DERIVED');
assert.equal(compositionPlan.entries[0].workingDraft, compositionPreview,
  '견적서 조합 미리보기는 현재 화면의 저장 전 작업표를 파생 출력 기준으로 사용해야 한다.');
assert.deepEqual(compositionPlan.entries[0].sourceDrafts, [individualDraftA, individualDraftB],
  '조합 미리보기의 파생 출력과 중복 검증은 병합 전 선택 개별 원본 모두를 사용해야 한다.');
assert.deepEqual(compositionPlan.validationDrafts, [individualDraftA, individualDraftB]);
assert.equal(compositionPlan.selectionCount, 2);

const compositionOutput = buildEstimateF8Data(buildEstimateF8RowsFromPlan(compositionPlan));
assert.equal(compositionOutput.ok, true);
const compositionShopA = compositionOutput.shopData.find(row => row[0] === 'SOURCE-A');
const compositionShopB = compositionOutput.shopData.find(row => row[0] === 'SOURCE-B');
const compositionErpA = compositionOutput.erpData.find(row => row[0] === 'SOURCE-A');
const compositionErpB = compositionOutput.erpData.find(row => row[0] === 'SOURCE-B');
assert.equal(compositionShopA?.[1], '최신원본상품-A', '파생 출력은 조합 작업표의 오래된 값이 아니라 최신 원본값을 사용해야 한다.');
assert.equal(compositionShopB?.[3], 1500, '명시적으로 수정하지 않은 원본 가격은 머치옵스 마진룰로 다시 계산해야 한다.');
assert.equal(compositionShopA?.[3], 7300, 'currentDraft에서 editedFields로 명시한 수정만 최신 원본 위에 반영해야 한다.');
assert.equal(compositionShopA?.[5], 7400, '원본에 없더라도 editedFields로 명시한 시중가 수정은 반영해야 한다.');
assert.equal(compositionShopA?.[12], '원본견적-사용자브랜드-A',
  '개별 원본의 명시 편집은 파생 작업표에서 다른 필드를 편집해도 소실되면 안 된다.');
assert.deepEqual(
  [compositionShopB?.[5], compositionShopB?.[12], compositionShopB?.[21]],
  [1500, '', ''],
  '시중가는 입고가 기준으로 생성하되 브랜드·상품태그는 작업표나 마스터성 직접값에서 유출되면 안 된다.'
);
assert.equal(compositionShopA?.[21], '', 'editedFields로 명시하지 않은 파생 작업표 값은 출력에 반영하면 안 된다.');

const clearedCompositionDraft = structuredClone(compositionPreview);
clearedCompositionDraft.rows[0].outPrice = null;
clearedCompositionDraft.rows[0].editedFields = { outPrice: true };
const clearedCompositionPlan = buildEstimateF8DraftPlan({
  creation: { selectedIds: ['EST-A', 'EST-B'] },
  currentDraft: clearedCompositionDraft,
  individualRecords
});
assert.equal(clearedCompositionPlan.ok, true);
const clearedCompositionOutput = buildEstimateF8Data(buildEstimateF8RowsFromPlan(clearedCompositionPlan));
assert.equal(clearedCompositionOutput.ok, true);
const clearedCompositionShopA = clearedCompositionOutput.shopData.find(row => row[0] === 'SOURCE-A');
const clearedCompositionErpA = clearedCompositionOutput.erpData.find(row => row[0] === 'SOURCE-A');
assert.equal(clearedCompositionShopA?.[3], '',
  '파생 작업표에서 명시적으로 지운 출고가는 과거 원본값으로 되살아나면 안 된다.');
assert.equal(clearedCompositionErpA?.[3], '',
  'ERP업데이트에도 명시적 가격 공란을 그대로 보존해야 한다.');

const savedLinkedDraft = {
  catalogRecordId: 'LINKED-1',
  estimateKind: 'LINKED_GROUP',
  marker: 'linked-saved',
  linkedEstimateSources: [{ estimateId: 'EST-A' }, { estimateId: 'EST-B' }],
  rows: [linkedWorkingRow('EST-A'), linkedWorkingRow('EST-B')]
};
const liveLinkedDraft = {
  ...savedLinkedDraft,
  marker: 'linked-live',
  rows: [
    linkedWorkingRow('EST-A', { outPrice: 8300 }, { outPrice: true }),
    linkedWorkingRow('EST-B')
  ]
};
const linkedRecord = {
  estimateId: 'LINKED-1',
  estimateKind: 'LINKED_GROUP',
  linkedEstimateSources: [{ estimateId: 'EST-A' }, { estimateId: 'EST-B' }],
  draft: savedLinkedDraft
};
const liveLinkedPlan = buildEstimateF8DraftPlan({
  selectedRecords: [linkedRecord],
  currentDraft: liveLinkedDraft,
  individualRecords,
  allRecords: [linkedRecord, ...individualRecords]
});
assert.equal(liveLinkedPlan.ok, true);
assert.equal(liveLinkedPlan.entries[0].kind, 'DERIVED');
assert.equal(liveLinkedPlan.entries[0].workingDraft, liveLinkedDraft,
  '열린 LINKED_GROUP은 화면의 저장 전 연결 작업표를 사용해야 한다.');
assert.deepEqual(liveLinkedPlan.entries[0].sourceDrafts, [individualDraftA, individualDraftB]);
assert.equal(buildEstimateF8Data(buildEstimateF8RowsFromPlan(liveLinkedPlan)).shopData
  .find(row => row[0] === 'SOURCE-A')?.[3], 8300,
  '열린 LINKED_GROUP의 editedFields 수정만 최신 원본 위에 반영해야 한다.');

const staleIndividualDraftA = buildSourceBackedIndividualDraft({
  estimateId: 'EST-A', itemCode: 'SOURCE-A', itemName: '과거원본상품-A', inboundPrice: 100, outPrice: 300
});
const staleIndividualDraftB = buildSourceBackedIndividualDraft({
  estimateId: 'EST-B', itemCode: 'SOURCE-B', itemName: '과거원본상품-B', inboundPrice: 200, outPrice: 400
});
const staleIndividualRecords = [
  { estimateId: 'EST-A', estimateKind: 'INDIVIDUAL', draft: staleIndividualDraftA },
  { estimateId: 'EST-B', estimateKind: 'INDIVIDUAL', draft: staleIndividualDraftB }
];
const savedLinkedPlan = buildEstimateF8DraftPlan({
  selectedRecords: [linkedRecord],
  currentDraft: { catalogRecordId: 'OTHER', marker: 'other', rows: [{ itemCode: 'OTHER-1' }] },
  individualRecords: staleIndividualRecords,
  allRecords: [linkedRecord, ...staleIndividualRecords],
  workingDrafts: new Map([['EST-A', individualDraftA], ['EST-B', individualDraftB]])
});
assert.equal(savedLinkedPlan.ok, true);
assert.equal(savedLinkedPlan.entries[0].kind, 'DERIVED');
assert.equal(savedLinkedPlan.entries[0].workingDraft, savedLinkedDraft,
  '열려 있지 않은 LINKED_GROUP은 저장된 연결 작업표를 출력 기준으로 사용해야 한다.');
assert.deepEqual(savedLinkedPlan.entries[0].sourceDrafts, [individualDraftA, individualDraftB],
  '저장된 LINKED_GROUP도 stale record.draft 대신 최신 개별 원본 작업본 전체를 사용해야 한다.');
const savedLinkedOutput = buildEstimateF8Data(buildEstimateF8RowsFromPlan(savedLinkedPlan));
assert.equal(savedLinkedOutput.shopData.find(row => row[0] === 'SOURCE-A')?.[1], '최신원본상품-A');
assert.equal(savedLinkedOutput.shopData.find(row => row[0] === 'SOURCE-B')?.[3], 1500);

const missingLinkedSourcePlan = buildEstimateF8DraftPlan({
  selectedRecords: [{
    estimateId: 'LINKED-MISSING',
    estimateKind: 'LINKED_GROUP',
    linkedEstimateSources: [{ estimateId: 'EST-A' }, { estimateId: 'EST-MISSING' }],
    draft: {
      estimateKind: 'LINKED_GROUP',
      linkedEstimateSources: [{ estimateId: 'EST-A' }, { estimateId: 'EST-MISSING' }],
      rows: [linkedWorkingRow('EST-A'), linkedWorkingRow('EST-MISSING')]
    }
  }],
  currentDraft: null,
  individualRecords
});
assert.equal(missingLinkedSourcePlan.ok, false, '연결 개별 원본이 하나라도 누락되면 F8 출력을 fail closed 해야 한다.');
assert.match(missingLinkedSourcePlan.error, /EST-MISSING/);
assert.deepEqual(missingLinkedSourcePlan.entries, []);
assert.deepEqual(missingLinkedSourcePlan.validationDrafts, []);

const missingLinkedRecord = missingLinkedSourcePlan.ok ? null : {
  estimateId: 'LINKED-MISSING',
  catalogName: '누락 연결 견적서',
  estimateKind: 'LINKED_GROUP',
  linkedEstimateSources: [{ estimateId: 'EST-A', catalogName: '원본 A' }, { estimateId: 'EST-MISSING', catalogName: '삭제 원본' }],
  amount: 2200,
  updatedAt: '2026-09-10T01:00:00.000Z',
  draft: {
    catalogRecordId: 'LINKED-MISSING',
    estimateKind: 'LINKED_GROUP',
    linkedEstimateSources: [{ estimateId: 'EST-A', catalogName: '원본 A' }, { estimateId: 'EST-MISSING', catalogName: '삭제 원본' }],
    rows: [
      linkedWorkingRow('EST-A'),
      linkedWorkingRow('EST-MISSING'),
      { rowId: 'MANUAL-1', itemCode: 'MANUAL', itemName: '수기 보존 품목', quantity: 1, unitPrice: 900, inputOwnership: 'USER' }
    ]
  }
};
const partialIntegrity = inspectEstimateF8Integrity({ record: missingLinkedRecord, allRecords: individualRecords });
assert.equal(partialIntegrity.status, 'PARTIAL_MISSING');
assert.deepEqual(partialIntegrity.missingSourceIds, ['EST-MISSING']);
assert.equal(partialIntegrity.removedRows.length, 1);
assert.equal(partialIntegrity.manualRows.length, 1);
assert.match(partialIntegrity.impactFingerprint, /^F8I-/);

const partialRecovered = applyEstimateF8PartialRecovery({
  linkedRecord: missingLinkedRecord,
  allRecords: individualRecords,
  diagnosis: partialIntegrity,
  operationId: 'SIF8REC-1',
  actorId: 'ADMIN',
  occurredAt: '2026-09-10T02:00:00.000Z'
});
assert.deepEqual(partialRecovered.linkedEstimateSources.map(source => source.estimateId), ['EST-A']);
assert.equal(partialRecovered.draft.rows.some(row => row.itemCode === 'MANUAL'), true,
  '일부 누락 자동 정리는 원본 참조가 없는 수기 행을 보존해야 한다.');
assert.equal(partialRecovered.draft.rows.some(row => row.linkedSourceEstimateId === 'EST-MISSING'), false);
assert.equal(partialRecovered.estimateAutomationHistory.at(-1).operationId, 'SIF8REC-1');
assert.equal(inspectEstimateF8Integrity({
  record: partialRecovered,
  allRecords: [partialRecovered, ...individualRecords]
}).status, 'READY', '일부 누락 정리 postimage는 F8 재검사에서 READY여야 한다.');

const rowMissingRecord = structuredClone(linkedRecord);
rowMissingRecord.estimateId = 'LINKED-ROW-MISSING';
rowMissingRecord.catalogName = '행 누락 연동';
rowMissingRecord.draft.catalogRecordId = rowMissingRecord.estimateId;
rowMissingRecord.draft.rows[0].linkedSourceRowId = 'DELETED-ROW';
rowMissingRecord.draft.rows[0].linkedSourceRefs = [{ estimateId: 'EST-A', rowId: 'DELETED-ROW' }];
const rowMissingIntegrity = inspectEstimateF8Integrity({ record: rowMissingRecord, allRecords: individualRecords });
assert.equal(rowMissingIntegrity.status, 'PARTIAL_MISSING', '원본 레코드가 있어도 참조 행이 사라지면 일부 누락이어야 한다.');
assert.deepEqual(rowMissingIntegrity.missingSourceIds, []);
assert.equal(rowMissingIntegrity.missingRowRefs[0].rowId, 'DELETED-ROW');

const allMissingRecord = structuredClone(missingLinkedRecord);
allMissingRecord.estimateId = 'LINKED-ALL-MISSING';
allMissingRecord.catalogName = '전체 누락 연동';
allMissingRecord.linkedEstimateSources = [{ estimateId: 'GONE-A', catalogName: '삭제 A' }, { estimateId: 'GONE-B', catalogName: '삭제 B' }];
allMissingRecord.draft.catalogRecordId = allMissingRecord.estimateId;
allMissingRecord.draft.linkedEstimateSources = structuredClone(allMissingRecord.linkedEstimateSources);
allMissingRecord.draft.rows = [
  { ...linkedWorkingRow('GONE-A'), rowId: 'LINKED:GONE-A:ERP-1' },
  { ...linkedWorkingRow('GONE-B'), rowId: 'LINKED:GONE-B:ERP-1' }
];
const allMissingIntegrity = inspectEstimateF8Integrity({ record: allMissingRecord, allRecords: [] });
assert.equal(allMissingIntegrity.status, 'ALL_MISSING');
assert.deepEqual(allMissingIntegrity.missingSourceIds, ['GONE-A', 'GONE-B']);
const independentCopy = createEstimateF8IndependentCopy({
  linkedRecord: allMissingRecord,
  diagnosis: allMissingIntegrity,
  estimateId: 'SIEST-RECOVERED',
  catalogName: '전체 누락 연동 독립 복구 사본',
  sortOrder: 9,
  operationId: 'SIF8REC-2',
  actorId: 'ADMIN',
  occurredAt: '2026-09-10T03:00:00.000Z'
});
assert.equal(independentCopy.estimateKind, 'INDIVIDUAL');
assert.equal(independentCopy.draft.estimateKind, 'INDIVIDUAL');
assert.deepEqual(independentCopy.linkedEstimateSources, []);
assert.equal(independentCopy.draft.rows.every(row => !('linkedSourceRefs' in row) && !('linkedSourceEstimateId' in row)), true);
assert.equal(independentCopy.recoveryOrigin.type, 'LINKED_SNAPSHOT_WITHOUT_SOURCES');
assert.equal(independentCopy.recoveryOrigin.sourceLinkedEstimateId, 'LINKED-ALL-MISSING');
assert.equal(independentCopy.estimateAutomationHistory.at(-1).operationId, 'SIF8REC-2');
assert.equal(allMissingRecord.estimateKind, 'LINKED_GROUP', '독립 사본 생성은 원본 stale 연동견적서를 변경하면 안 된다.');
const independentPlan = buildEstimateF8DraftPlan({ selectedRecords: [independentCopy], individualRecords: [independentCopy] });
assert.equal(independentPlan.ok, true, '독립 복구 사본은 저장 직후 DIRECT F8 출력이 가능해야 한다.');

const changedAvailableSource = structuredClone(individualRecords[0]);
changedAvailableSource.draft.rows[0].itemName = '동시 변경된 최신 품목';
const changedImpact = inspectEstimateF8Integrity({ record: missingLinkedRecord, allRecords: [changedAvailableSource] });
assert.notEqual(changedImpact.impactFingerprint, partialIntegrity.impactFingerprint,
  '확인 뒤 유지될 원본 값이 달라지면 기존 관리자 확인 지문을 재사용하면 안 된다.');

const compositionMismatchPlan = buildEstimateF8DraftPlan({
  creation: { selectedIds: ['EST-A', 'EST-B'] },
  currentDraft: {
    ...compositionPreview,
    linkedEstimateSources: [{ estimateId: 'EST-A' }]
  },
  individualRecords
});
assert.equal(compositionMismatchPlan.ok, false, '현재 조합 미리보기 원본과 선택 원본이 다르면 fail closed 해야 한다.');
assert.match(compositionMismatchPlan.error, /현재 선택과 일치하지 않습니다/);

const linkedMetadataMismatchPlan = buildEstimateF8DraftPlan({
  selectedRecords: [{
    ...linkedRecord,
    draft: { ...savedLinkedDraft, linkedEstimateSources: [{ estimateId: 'EST-A' }] }
  }],
  individualRecords
});
assert.equal(linkedMetadataMismatchPlan.ok, false, '연동견적서 record와 draft의 원본 구성이 다르면 fail closed 해야 한다.');
assert.match(linkedMetadataMismatchPlan.error, /저장 정보와 작업표 원본 구성이 일치하지 않습니다/);

const linkedZeroSourcePlan = buildEstimateF8DraftPlan({
  selectedRecords: [{
    estimateId: 'LINKED-ZERO',
    estimateKind: 'LINKED_GROUP',
    linkedEstimateSources: [],
    draft: { estimateKind: 'LINKED_GROUP', linkedEstimateSources: [], rows: [] }
  }],
  individualRecords
});
assert.equal(linkedZeroSourcePlan.ok, false, '연동견적서 원본이 0건이면 fail closed 해야 한다.');
assert.match(linkedZeroSourcePlan.error, /원본 견적서 구성을 확인할 수 없습니다/);

const duplicateLinkedRefPlan = buildEstimateF8DraftPlan({
  selectedRecords: [{
    ...linkedRecord,
    draft: {
      ...savedLinkedDraft,
      rows: [
        linkedWorkingRow('EST-A', { outPrice: 200 }, { outPrice: true }),
        linkedWorkingRow('EST-A', { outPrice: 300 }, { outPrice: true })
      ]
    }
  }],
  individualRecords,
  allRecords: [linkedRecord, ...individualRecords]
});
assert.equal(duplicateLinkedRefPlan.ok, false,
  '같은 원본 행을 여러 작업행이 가리키면 마지막 편집을 임의 선택하지 말고 fail closed 해야 한다.');
assert.match(duplicateLinkedRefPlan.error, /원본 행 EST-A:ERP-1.*중복 연결/);

const malformedLinkedRefPlan = linkedSourceRefs => buildEstimateF8DraftPlan({
  selectedRecords: [{
    ...linkedRecord,
    draft: {
      ...savedLinkedDraft,
      rows: [{
        ...linkedWorkingRow('EST-A', { outPrice: 999 }, { outPrice: true }),
        linkedSourceRefs
      }]
    }
  }],
  individualRecords,
  allRecords: [linkedRecord, ...individualRecords]
});
const duplicateRefInOneRowPlan = malformedLinkedRefPlan([
  { estimateId: 'EST-A', rowId: 'ERP-1' },
  { estimateId: 'EST-A', rowId: 'ERP-1' }
]);
assert.equal(duplicateRefInOneRowPlan.ok, false);
assert.match(duplicateRefInOneRowPlan.error, /같은 원본 행 참조가 중복/);
const blankRefRowIdPlan = malformedLinkedRefPlan([{ estimateId: 'EST-A', rowId: '' }]);
assert.equal(blankRefRowIdPlan.ok, false);
assert.match(blankRefRowIdPlan.error, /견적서 ID 또는 행 ID가 없습니다/);
const blankRefEstimateIdPlan = malformedLinkedRefPlan([{ estimateId: '', rowId: 'ERP-1' }]);
assert.equal(blankRefEstimateIdPlan.ok, false);
assert.match(blankRefEstimateIdPlan.error, /견적서 ID 또는 행 ID가 없습니다/);
const extraLegacyOwnerPlan = buildEstimateF8DraftPlan({
  selectedRecords: [{
    ...linkedRecord,
    draft: {
      ...savedLinkedDraft,
      rows: [{
        ...linkedWorkingRow('EST-A', { outPrice: 999 }, { outPrice: true }),
        linkedSourceRefs: [],
        linkedSourceEstimateIds: ['EST-A', 'EST-B']
      }]
    }
  }],
  individualRecords,
  allRecords: [linkedRecord, ...individualRecords]
});
assert.equal(extraLegacyOwnerPlan.ok, false,
  'legacy 단일 ref에 연결되지 않은 추가 owner ID가 있으면 편집 적용 대상을 임의 축소하면 안 된다.');
assert.match(extraLegacyOwnerPlan.error, /원본 견적서 목록과 단일 원본 참조가 일치하지 않습니다/);

const multiRefWorkingRow = {
  ...linkedWorkingRow('EST-A', { outPrice: 999 }, { outPrice: true }),
  linkedSourceEstimateIds: ['EST-A', 'EST-B'],
  linkedSourceRefs: [
    { estimateId: 'EST-A', rowId: 'ERP-1' },
    { estimateId: 'EST-B', rowId: 'ERP-1' }
  ]
};
const editedMultiRefPlan = buildEstimateF8DraftPlan({
  selectedRecords: [{
    ...linkedRecord,
    draft: { ...savedLinkedDraft, rows: [multiRefWorkingRow] }
  }],
  individualRecords,
  allRecords: [linkedRecord, ...individualRecords]
});
assert.equal(editedMultiRefPlan.ok, false,
  '한 편집행이 여러 원본 행을 가리키면 어느 원본에 적용할지 임의 선택하지 말고 fail closed 해야 한다.');
assert.match(editedMultiRefPlan.error, /편집값이 여러 원본 행.*적용 대상을 결정할 수 없습니다/);

const uneditedMultiRefPlan = buildEstimateF8DraftPlan({
  selectedRecords: [{
    ...linkedRecord,
    draft: {
      ...savedLinkedDraft,
      rows: [{ ...multiRefWorkingRow, outPrice: 99000, editedFields: {}, linkedSyncFields: [] }]
    }
  }],
  individualRecords,
  allRecords: [linkedRecord, ...individualRecords]
});
assert.equal(uneditedMultiRefPlan.ok, true,
  '편집이 없는 다중 원본 표시행은 최신 개별 원본을 각각 출력할 수 있어야 한다.');
const uneditedMultiRefOutput = buildEstimateF8Data(buildEstimateF8RowsFromPlan(uneditedMultiRefPlan));
assert.equal(uneditedMultiRefOutput.ok, true);
assert.deepEqual(uneditedMultiRefOutput.shopData.slice(1).map(row => row[0]), ['SOURCE-A', 'SOURCE-B']);

const duplicateRowIdDraftA = structuredClone(individualDraftA);
duplicateRowIdDraftA.rows.push({
  ...structuredClone(duplicateRowIdDraftA.rows[0]),
  itemCode: 'SOURCE-A-SECOND',
  itemName: '중복 행 ID 두 번째 상품'
});
const duplicateSourceRowIdPlan = buildEstimateF8DraftPlan({
  selectedRecords: [linkedRecord],
  individualRecords: [
    { estimateId: 'EST-A', estimateKind: 'INDIVIDUAL', draft: duplicateRowIdDraftA },
    individualRecords[1]
  ],
  allRecords: [linkedRecord, ...individualRecords]
});
assert.equal(duplicateSourceRowIdPlan.ok, false,
  '개별 원본 내부의 rowId가 중복되면 연동 편집 대상을 임의로 확장하지 말고 fail closed 해야 한다.');
assert.match(duplicateSourceRowIdPlan.error, /원본 행 식별자가 유일하지 않습니다\(EST-A:ERP-1\)/);

const missingRowIdDraftA = structuredClone(individualDraftA);
delete missingRowIdDraftA.rows[0].rowId;
const missingSourceRowIdPlan = buildEstimateF8DraftPlan({
  selectedRecords: [linkedRecord],
  individualRecords: [
    { estimateId: 'EST-A', estimateKind: 'INDIVIDUAL', draft: missingRowIdDraftA },
    individualRecords[1]
  ],
  allRecords: [linkedRecord, ...individualRecords]
});
assert.equal(missingSourceRowIdPlan.ok, false,
  '연동 원본의 rowId가 비어 있으면 위치 기반 임시 ID로 추정하지 말고 fail closed 해야 한다.');
assert.match(missingSourceRowIdPlan.error, /원본 행 식별자가 유일하지 않습니다\(EST-A:행ID없음\)/);

const targetKindMismatchPlan = buildEstimateF8DraftPlan({
  selectedRecords: [{ ...linkedRecord, estimateKind: 'INDIVIDUAL' }],
  individualRecords,
  allRecords: [linkedRecord, ...individualRecords]
});
assert.equal(targetKindMismatchPlan.ok, false,
  'top-level 개별 견적과 LINKED_GROUP 작업표의 유형 불일치를 DERIVED로 승격하면 안 된다.');
assert.match(targetKindMismatchPlan.error, /저장 유형과 작업표 유형이 일치하지 않습니다/);

const disguisedLinkedSourcePlan = buildEstimateF8DraftPlan({
  selectedRecords: [linkedRecord],
  individualRecords: [{
    estimateId: 'EST-A',
    estimateKind: 'INDIVIDUAL',
    draft: { ...individualDraftA, estimateKind: 'LINKED_GROUP', linkedEstimateSources: [{ estimateId: 'EST-B' }] }
  }, individualRecords[1]],
  allRecords: [linkedRecord, ...individualRecords]
});
assert.equal(disguisedLinkedSourcePlan.ok, false,
  '연동견적의 원본으로 위장된 LINKED_GROUP 작업표를 개별 원본으로 사용하면 안 된다.');
assert.match(disguisedLinkedSourcePlan.error, /유형이 저장 정보와 작업표에서 일치하지 않습니다/);

const mismatchedWorkingKeyPlan = buildEstimateF8DraftPlan({
  selectedRecords: [{ estimateId: 'EST-WORK', estimateKind: 'INDIVIDUAL', draft: savedOpenDraft }],
  workingDrafts: new Map([['EST-WORK', { catalogRecordId: 'EST-OTHER', rows: [{ itemCode: 'WRONG-1' }] }]])
});
assert.equal(mismatchedWorkingKeyPlan.ok, false, 'working map의 key와 draft 식별자가 다르면 fail closed 해야 한다.');
assert.match(mismatchedWorkingKeyPlan.error, /작업본 식별자가 일치하지 않습니다/);

const blankWorkingIdentityPlan = buildEstimateF8DraftPlan({
  selectedRecords: [{ estimateId: 'EST-WORK', estimateKind: 'INDIVIDUAL', draft: savedOpenDraft }],
  workingDrafts: new Map([['EST-WORK', { catalogRecordId: '', rows: [{ itemCode: 'OWNERLESS-1' }] }]])
});
assert.equal(blankWorkingIdentityPlan.ok, false,
  '선택 견적서 key에 연결된 무소유 작업본을 저장본 대신 채택하면 안 된다.');
assert.match(blankWorkingIdentityPlan.error, /작업본 식별자가 일치하지 않습니다/);

const mappedDraft = buildMappedDraft([
  ['2026-09-05', '02', '거래처A', '원본상품A', '1kg', '000101', '1,000', '2,500', '0', '900', '800', '2,000', '', '원본설명A', '0', '', '', '', '', '', '', '', ''],
  ['2026-09-05', '02', '거래처B', '원본상품B', '', '000102', '', '', '1,000', '', '500', '', '', '', '0', '', '', '', '', '', '', '', '']
]);
mappedDraft.rows[0].finalTransmission = 0;
mappedDraft.rows[0].bSalePrice = 0;
mappedDraft.rows[0].stockQuantity = 0;
mappedDraft.rows[0].marketPrice = 999999;
mappedDraft.rows[0].brand = '직접브랜드';
mappedDraft.rows[0].searchInfo = '직접태그';
mappedDraft.rows[1].lastPurchasePrice = 0;
mappedDraft.rows[1].inboundPrice = 777777;
mappedDraft.rows[1].bSalePrice = '';

const mappedRows = buildEstimateF8RowsFromDraft(mappedDraft);
const mappedOutput = buildEstimateF8Data(mappedRows, {
  productCatalog: [{ itemCode: '000101', itemName: '마스터상품명', brand: '마스터브랜드', marketPrice: 999999 }]
});
const merchMarginRules = [
  { id: 'warehouse-02-box', whCode: '02', unit: 'BOX', rate: 15, type: 'divide' },
  { id: 'default', whCode: '*', unit: '*', rate: 20, type: 'divide' }
];
const merchParityDraft = buildMappedDraft([
  ['2026-09-02', '02', '거래처A', 'EA 가격상품', 'EA', 'PRICE-EA', 13000, 15900, '', '', '', '', '', '', '', 300, 100, 200, '', '', '', '', ''],
  ['2026-09-02', '02', '거래처A', 'BOX 가격상품', 'BOX', 'PRICE-BOX', 30000, 38900, '', '', '', '', '', '', '', 1000, 500, 2000, '', '', '', '', ''],
  ['2026-09-02', '02', '거래처A', '행사 가격상품', 'EA', 'PRICE-PROMO', 2800, 3600, '', '', '', 3300, '', '', '', 100, 100, 100, '', '', '', '', ''],
  ['2026-09-02', '02', '거래처A', '소분 원물', 'BOX', 'PRICE-PARENT', 14000, 19500, '', '', '', '', '', '', 5, 2000, 500, 500, '', '소분', 'PRICE-SUB', '', '']
]);
const merchParityOutput = buildEstimateF8Data(buildEstimateF8RowsFromDraft(merchParityDraft), {
  marginRules: merchMarginRules,
  productCatalog: [
    { itemCode: 'PRICE-EA', finalUnit: 'EA' },
    { itemCode: 'PRICE-BOX', finalUnit: 'BOX' },
    { itemCode: 'PRICE-PROMO', finalUnit: 'EA' },
    { itemCode: 'PRICE-PARENT', finalUnit: 'EA' },
    { itemCode: 'PRICE-SUB', itemName: '소분상품', specification: '소분' }
  ]
});
assert.equal(merchParityOutput.erpData.find(row => row[0] === 'PRICE-EA')?.[3], 16900,
  '견적 원본 출고가는 입고가+외주비+노무비에 머치옵스 기본 마진룰을 적용해 다시 계산해야 한다.');
assert.equal(merchParityOutput.erpData.find(row => row[0] === 'PRICE-BOX')?.[3], 38800,
  '견적 규격명이 아니라 상품 기준단위로 저장된 창고·단위별 마진룰을 선택해야 한다.');
assert.equal(merchParityOutput.erpData.find(row => row[0] === 'PRICE-PROMO')?.[3], 3800);
assert.equal(merchParityOutput.shopData.find(row => row[0] === 'PRICE-PROMO')?.[3], 3300,
  'ERP 출고가는 재계산하되 쇼핑몰 출고가는 양수 행사가를 우선해야 한다.');
assert.equal(merchParityOutput.erpData.find(row => row[0] === 'PRICE-SUB')?.[1], 3200);
assert.equal(merchParityOutput.erpData.find(row => row[0] === 'PRICE-SUB')?.[3], 4100,
  '기본 견적 매핑에 없는 경비는 소분 판매가에 임의로 더하지 않아야 한다.');
const mappedExpenseOutput = buildEstimateF8Data(buildEstimateF8RowsFromDraft(merchParityDraft), {
  marginRules: merchMarginRules,
  estimateMappings: { estimate: { 경비: '경비' } },
  productCatalog: [
    { itemCode: 'PRICE-EA', finalUnit: 'EA' },
    { itemCode: 'PRICE-BOX', finalUnit: 'BOX' },
    { itemCode: 'PRICE-PROMO', finalUnit: 'EA' },
    { itemCode: 'PRICE-PARENT', finalUnit: 'EA' },
    { itemCode: 'PRICE-SUB', itemName: '소분상품', specification: '소분' }
  ]
});
assert.equal(mappedExpenseOutput.erpData.find(row => row[0] === 'PRICE-SUB')?.[3], 4600,
  '머치옵스 견적 매핑에서 경비를 명시한 경우에는 소분 판매가에 반영해야 한다.');
const sortedEstimateUploadOutput = buildEstimateF8Data([
  { rowCustomerName: '나 거래처', itemCode: 'N-2', itemName: '나 상품' },
  { rowCustomerName: '가 거래처', itemCode: 'C-10', itemName: '가 상품 10' },
  { rowCustomerName: '가 거래처', itemCode: 'C-2', itemName: '가 상품 2' }
]);
assert.deepEqual(sortedEstimateUploadOutput.estimateUploadData.slice(1).map(row => [row[3], row[8]]), [
  ['가 거래처', 'C-2'], ['가 거래처', 'C-10'], ['나 거래처', 'N-2']
], '견적서 업로드는 거래처명 다음 품목코드 순으로 정렬해야 한다.');
assert.deepEqual(sortedEstimateUploadOutput.shopData.slice(1).map(row => row[0]), ['N-2', 'C-10', 'C-2'],
  '견적서 업로드 정렬이 쇼핑몰 업로드 행 순서를 바꾸면 안 된다.');
assert.equal(mappedOutput.ok, true);
assert.deepEqual(ESTIMATE_F8_HEADERS.shop, [
  '상품코드\n코드', '상품명', '규격', '출고가', '도매A', '시중가', 'B판매가', '도매B',
  'C 판매가', 'C 도매가', 'D 판매가', 'D 도매가', '브랜드', '기본설명', '판매여부',
  '재고수량', '테마1', '테마2', '테마3', '테마4', '테마5', '상품태그'
]);
assert.deepEqual(ESTIMATE_F8_HEADERS.erp, [
  '품목코드', '입고가', '0', '출고가', '0', '입고B', 'n', '도매A', 'n', '도매B', 'n'
]);
assert.deepEqual(ESTIMATE_F8_HEADERS.upload, [
  '일자', '순번', '거래처코드', '거래처명', '출하창고', '거래유형', '참조', '담당자',
  '품목코드', '품목명', '규격', '수량', '단가', 'B단가', 'A판매', 'B판매', '적요', '지시사항', '적요2'
]);
assert.equal(mappedOutput.shopData[1].length, 22);
assert.equal(mappedOutput.erpData[1].length, 11);
assert.equal(mappedOutput.shopData[1][0], '000101', '문자 품목코드와 선행 0을 보존해야 한다.');
assert.equal(mappedOutput.shopData[1][1], '원본상품A', '기준상품 마스터값으로 원본 상품명을 덮어쓰면 안 된다.');
assert.equal(mappedOutput.shopData[1][3], 2000, '행사가가 있으면 쇼핑몰 출고가에 우선 적용해야 한다.');
assert.equal(mappedOutput.shopData[1][5], 1300,
  '불러온 견적서의 시중가도 원본·마스터값이 아니라 입고가 기준 계산 출고가와 같이 생성해야 한다.');
assert.equal(mappedOutput.shopData[1][6], '', '원본에 없는 B판매가는 직접값으로 보강하면 안 된다.');
assert.deepEqual(mappedOutput.shopData[1].slice(8, 12), [0, 0, 0, 0],
  'C/D 판매가·도매가는 원본이나 직접값과 무관하게 숫자 0으로 출력해야 한다.');
assert.equal(mappedOutput.shopData[1][12], '', '원본에 없는 브랜드를 직접값이나 마스터값으로 보강하면 안 된다.');
assert.equal(mappedOutput.shopData[1][14], 1, '원본 출고가가 있으면 판매여부는 숫자 1이어야 한다.');
assert.equal(mappedOutput.shopData[2][14], 0, '원본 출고가가 공란이면 판매여부는 숫자 0이어야 한다.');
assert.equal(mappedOutput.shopData[1][15], 999, '모든 쇼핑몰 출력행의 재고수량은 숫자 999여야 한다.');
assert.equal(mappedOutput.shopData[1][21], '', '원본에 없는 상품태그를 직접값이나 마스터값으로 보강하면 안 된다.');
assert.equal(mappedOutput.erpData[1][1], 1000, '입고가는 단가(unitPrice)가 아니라 원본 입고가를 사용해야 한다.');
assert.equal(mappedOutput.erpData[1][5], 0, '입고B의 명시적 0을 보존해야 한다.');
assert.equal(mappedOutput.erpData[2][1], '', '원본 입고가 공란은 직접값이나 마스터값으로 보강하면 안 된다.');
assert.equal(mappedOutput.estimateUploadData[1].length, 19);
assert.deepEqual(mappedOutput.estimateUploadData[1].slice(0, 6), ['2026-09-05', '', '', '거래처A', '02', '']);
assert.deepEqual(mappedOutput.estimateUploadData[1].slice(8, 16), ['000101', '원본상품A', '1kg', '', 1300, 0, 900, 800],
  '불러온 견적서의 업로드 단가도 원본 출고가가 아니라 입고가(견적단가) 기준 계산값이어야 한다.');
assert.deepEqual(mappedOutput.estimateUploadData[1].slice(16), ['', '원본설명A', '']);
assert.equal(mappedOutput.confirmData.length, 3, '입고가보다 낮은 도매A/도매B 두 건만 확인요청에 포함해야 한다.');
const manualUploadOutput = buildEstimateF8Data(buildEstimateF8RowsFromDraft({
  header: {
    voucherDate: '2026-09-07', customerCode: 'C-7', customerName: '수기거래처',
    warehouseCode: '02', transactionType: '일반', managerName: '담당A'
  },
  rows: [{ itemCode: 'MANUAL-1', itemName: '수기상품', specification: 'EA', quantity: 3, outPrice: 4500 }]
}));
assert.deepEqual(manualUploadOutput.estimateUploadData[1].slice(0, 8),
  ['2026-09-07', '', 'C-7', '수기거래처', '02', '일반', '', '담당A'],
  '원본 Excel이 없는 수기 견적은 선택 전표 상단정보를 업로드 양식에 사용해야 한다.');
assert.deepEqual(manualUploadOutput.estimateUploadData[1].slice(8, 13), ['MANUAL-1', '수기상품', 'EA', 3, 4500]);
const splitMapped = splitEstimateBulkInputMapping({ session: mappedDraft.inputMapping, rows: [mappedDraft.rows[1]] });
const splitMappedOutput = buildEstimateF8Data(buildEstimateF8RowsFromDraft({
  rows: splitMapped.rows,
  inputMapping: splitMapped.session
}));
assert.equal(splitMappedOutput.erpData[1][0], '000102',
  '거래처별 분할 저장 뒤에도 remap된 rowId로 원본 매핑 증적을 읽어야 한다.');
assert.equal(splitMappedOutput.erpData[1][1], '', '거래처별 분할 뒤에도 원본 공란을 보존해야 한다.');
const matrixFallbackDraft = structuredClone({ rows: splitMapped.rows, inputMapping: splitMapped.session });
delete matrixFallbackDraft.rows[0].fieldValues;
delete matrixFallbackDraft.inputMapping.workingRows[0].cells;
const matrixFallbackOutput = buildEstimateF8Data(buildEstimateF8RowsFromDraft(matrixFallbackDraft));
assert.equal(matrixFallbackOutput.erpData[1][0], '000102',
  '행 projection과 working cell이 없어도 검증된 매핑 헤더와 sourceMatrix 증적으로 원본 코드를 읽어야 한다.');
assert.equal(matrixFallbackOutput.erpData[1][1], '', 'sourceMatrix fallback도 원본 공란을 보존해야 한다.');

const invalidNumericDraft = buildMappedDraft([
  ['2026-09-05', '02', '거래처C', '숫자확인상품', '1박스', 'INVALID-1', '입고가미확인', '출고가미확인', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']
]);
const invalidNumericOutput = buildEstimateF8Data(buildEstimateF8RowsFromDraft(invalidNumericDraft));
assert.equal(invalidNumericOutput.ok, true);
assert.equal(invalidNumericOutput.erpData[1][1], 0, '원본 숫자 항목의 비숫자 값은 MerchOps와 같이 숫자 0으로 출력해야 한다.');
assert.equal(invalidNumericOutput.erpData[1][3], 0, '원본 출고가의 비숫자 값도 숫자 0으로 출력해야 한다.');
assert.equal(invalidNumericOutput.shopData[1][3], 0, '쇼핑몰 출고가도 같은 비숫자 변환 규칙을 적용해야 한다.');

const unitAliasOutput = buildEstimateF8Data([{ itemCode: 'UNIT-1', itemName: '단위 별칭 상품', unit: '10kg' }]);
assert.equal(unitAliasOutput.ok, true);
assert.equal(unitAliasOutput.shopData[1][2], '10kg', '직접 행의 단위 값은 쇼핑몰 규격으로 출력해야 한다.');

const saleFromOutPriceOutput = buildEstimateF8Data([
  {
    itemCode: 'SALE-STATE-1', itemName: '출고가 있음', estimateF8SourceOnly: true,
    estimateF8SourceFields: {
      품목코드: { currentDisplayValue: 'SALE-STATE-1' },
      품목명: { currentDisplayValue: '출고가 있음' },
      출고가: { currentDisplayValue: '1000' },
      판매상태: { currentDisplayValue: '판매중단' }
    }
  },
  { itemCode: 'SALE-STOP-1', itemName: '출고가 공란', outPrice: '', saleAvailability: '판매중' },
  { itemCode: 'SALE-STOP-2', itemName: '출고가 0', outPrice: 0, saleCode: '판매중' },
  { itemCode: 'SALE-NUMERIC-1', itemName: '출고가 양수', outPrice: 1, saleAvailability: '판매불가' }
]);
assert.equal(saleFromOutPriceOutput.ok, true);
assert.deepEqual(saleFromOutPriceOutput.shopData.slice(1).map(row => row[14]), [1, 0, 0, 1],
  '판매여부는 판매상태가 아니라 원본 출고가 양수 여부로만 결정해야 한다.');
assert.ok(saleFromOutPriceOutput.shopData.slice(1).every(row => row[15] === 999),
  '판매여부와 무관하게 모든 행의 재고수량은 숫자 999여야 한다.');

const subdivisionOutput = buildEstimateF8Data([
  {
    itemCode: 'PARENT-1', itemName: '원물1', inboundPrice: 10000, outPrice: 20000,
    type1Code: 'SUB-NEW', type1Operation: 2, type1Specification: '500g',
    outsourcingStandardCost: 2000, expenseStandardCost: 500
  },
  {
    itemCode: 'PARENT-2', itemName: '원물2', inboundPrice: 8000, outPrice: 16000,
    type1Code: 'SUB-EXIST', type1Operation: 2
  },
  { itemCode: 'SUB-EXIST', itemName: '기존 소분', inboundPrice: 1, outPrice: 1 }
], {
  productCatalog: [{
    itemCode: 'SUB-NEW', itemName: '신규 소분', specification: '마스터규격', brand: '브랜드',
    productDescription: '설명', searchInfo: '검색어'
  }]
});
assert.equal(subdivisionOutput.ok, true);
assert.equal(subdivisionOutput.shopData.filter(row => row[0] === 'SUB-NEW').length, 1);
assert.equal(subdivisionOutput.erpData.find(row => row[0] === 'SUB-NEW')?.[1], 6000);
assert.equal(subdivisionOutput.shopData.find(row => row[0] === 'SUB-NEW')?.[3], 10500);
assert.deepEqual(subdivisionOutput.shopData.filter(row => ['SUB-NEW', 'SUB-EXIST'].includes(row[0])).map(row => [row[14], row[15]]), [[1, 999], [1, 999]],
  '신규·기존 소분행도 판매여부 1과 재고수량 999를 적용해야 한다.');
assert.equal(subdivisionOutput.shopData.find(row => row[0] === 'SUB-EXIST')?.[3], 8000,
  '이미 기준행에 있는 소분코드는 행을 늘리지 않고 계산 단가만 갱신해야 한다.');

const missingSubdivisionMaster = buildEstimateF8Data([{
  itemCode: 'PARENT-X', itemName: '원물', inboundPrice: 10000, outPrice: 20000,
  type1Code: 'SUB-MISSING', type1Operation: 2
}]);
assert.equal(missingSubdivisionMaster.ok, false);
assert.ok(missingSubdivisionMaster.errors.some(error => error.code === 'SUBDIVISION_PRODUCT_REQUIRED'));

const ambiguousSubdivision = buildEstimateF8Data([
  { itemCode: 'PARENT-A', itemName: '원물A', inboundPrice: 10000, outPrice: 20000, type1Code: 'SUB-SAME', type1Operation: 2 },
  { itemCode: 'PARENT-B', itemName: '원물B', inboundPrice: 12000, outPrice: 22000, type1Code: 'SUB-SAME', type1Operation: 2 }
], { productCatalog: [{ itemCode: 'SUB-SAME', itemName: '소분' }] });
assert.equal(ambiguousSubdivision.ok, false);
assert.ok(ambiguousSubdivision.errors.some(error => error.code === 'SUBDIVISION_SOURCE_SELECTION_REQUIRED'));

const normalizedDuplicate = buildEstimateF8Data([
  { itemCode: 'CODE 1', itemName: '공백 코드' },
  { itemCode: 'CODE1', itemName: '공백 없는 코드' }
]);
assert.equal(normalizedDuplicate.ok, false);
assert.deepEqual([...new Set(normalizedDuplicate.errors
  .filter(error => error.code === 'DUPLICATE_RESOLUTION_REQUIRED')
  .map(error => error.originalValue))], ['CODE1'],
  'MerchOps와 같이 코드 공백을 제거한 뒤 중복 선택을 요구해야 한다.');
const normalizedDuplicateRows = [
  { itemCode: 'CODE 1', itemName: '공백 코드', rowCustomerName: '거래처A', inboundPrice: 1000, outPrice: 9000 },
  { itemCode: 'CODE1', itemName: '공백 없는 코드', rowCustomerName: '거래처B', inboundPrice: 2000, outPrice: 8000 }
];
const normalizedDuplicateGroups = buildEstimateDuplicateGroups(normalizedDuplicateRows);
assert.equal(normalizedDuplicateGroups.length, 1);
assert.deepEqual(normalizedDuplicateGroups[0].candidates.map(candidate => candidate.customerName), ['거래처A', '거래처B'],
  '같은 품목코드의 거래처별 원본은 한 그룹에 모아 보여야 한다.');
assert.deepEqual(normalizedDuplicateGroups[0].candidates.map(candidate => candidate.calculatedOutPrice), [1300, 2500],
  '중복 후보 미리보기부터 기존 출고가가 아니라 각 행의 입고가를 기준으로 계산해야 한다.');
assert.equal(calculateEstimateResolvedPrice(normalizedDuplicateRows[1], 3000).outPrice, 3800,
  '직접 수정한 입고가도 머치옵스 기본 마진 규칙으로 즉시 재계산해야 한다.');
const resolvedNormalizedDuplicate = buildEstimateF8Data(normalizedDuplicateRows, {
  duplicateResolutions: new Map([['CODE1', { rowIndex: 1, inboundPrice: 3000 }]])
});
assert.equal(resolvedNormalizedDuplicate.ok, true);
assert.equal(resolvedNormalizedDuplicate.shopData.length, 2,
  '쇼핑몰·ERP용 상품 마스터에는 선택한 대표 품목 한 행만 생성해야 한다.');
assert.deepEqual(resolvedNormalizedDuplicate.erpData[1].slice(0, 4), ['CODE1', 3000, '0', 3800]);
assert.deepEqual(resolvedNormalizedDuplicate.shopData[1].slice(3, 6), [3800, '', 3800],
  '직접 수정한 입고가의 계산 출고가를 쇼핑몰 출고가·시중가에 함께 사용해야 한다.');
assert.equal(resolvedNormalizedDuplicate.estimateUploadData.length, 3,
  '견적서 업로드에는 거래처별 원본 거래 행을 모두 유지해야 한다.');
assert.equal(resolvedNormalizedDuplicate.estimateUploadData.find(row => row[3] === '거래처B')?.[12], 3800,
  '대표 행에서 직접 수정한 입고가의 계산 단가는 해당 견적서 업로드 거래행에도 반영해야 한다.');

const decimalSuffixCodes = buildEstimateF8Data([
  { itemCode: 'CODE1.0', itemName: '소수점 접미 코드' },
  { itemCode: 'CODE1', itemName: '일반 코드' }
]);
assert.equal(decimalSuffixCodes.ok, true, '코드 끝의 .0은 제거하지 않아 CODE1과 별도 코드로 유지해야 한다.');
assert.deepEqual(decimalSuffixCodes.shopData.slice(1).map(row => row[0]), ['CODE1.0', 'CODE1']);

const customerNames = Array.from({ length: 10 }, (_, index) => `거래처-${index + 1}`);
const erp277Rows = Array.from({ length: 273 }, (_, index) => ({
  itemCode: String(100000000 + index),
  itemName: `상품-${index + 1}`,
  customerName: customerNames[index % customerNames.length]
}));
erp277Rows.push(...[0, 1, 2, 3].map(index => ({ ...erp277Rows[index], customerName: customerNames[9] })));
assert.equal(erp277Rows.length, 277);
assert.equal(new Set(erp277Rows.map(row => row.customerName)).size, 10);
const duplicateOutput = buildEstimateF8Data(erp277Rows);
assert.equal(duplicateOutput.ok, false, 'ERP 전체 277행의 중복코드 네 건은 대표 입고가 확정 전까지만 생성을 보류해야 한다.');
assert.deepEqual([...new Set(duplicateOutput.errors
  .filter(error => error.code === 'DUPLICATE_RESOLUTION_REQUIRED')
  .map(error => error.originalValue))].sort(), erp277Rows.slice(0, 4).map(row => row.itemCode).sort());
const duplicateResolutions = new Map(erp277Rows.slice(0, 4).map((row, rowIndex) => [
  row.itemCode, { rowIndex, inboundPrice: 1000 + rowIndex * 100 }
]));
const resolvedDuplicateOutput = buildEstimateF8Data(erp277Rows, { duplicateResolutions });
assert.equal(resolvedDuplicateOutput.ok, true, '모든 중복코드의 대표 입고가를 확정하면 F8 파일을 생성해야 한다.');
assert.equal(resolvedDuplicateOutput.shopData.length, 274, '상품 마스터 시트는 273개 고유코드만 포함해야 한다.');
assert.equal(resolvedDuplicateOutput.estimateUploadData.length, 278, '견적서 업로드 시트는 원본 277개 거래 행을 보존해야 한다.');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const xlsxSource = fs.readFileSync(path.join(root, 'customer-master/vendor/xlsx.full.min.js'), 'utf8');
const xlsxContext = vm.createContext({
  console, Date, Math, Number, String, Object, Array, Map, Set, Uint8Array, ArrayBuffer,
  setTimeout, clearTimeout
});
xlsxContext.window = xlsxContext;
xlsxContext.self = xlsxContext;
xlsxContext.globalThis = xlsxContext;
vm.runInContext(xlsxSource, xlsxContext, { filename: 'xlsx.full.min.js' });
const XLSX = xlsxContext.XLSX;
assert.ok(XLSX?.utils, '저장소 SheetJS 자산을 불러와야 한다.');
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(mappedOutput.shopData), '쇼핑몰업로드');
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(mappedOutput.erpData), 'ERP업데이트');
if (mappedOutput.confirmData.length > 1) {
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(mappedOutput.confirmData), '확인요청');
}
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(mappedOutput.estimateUploadData), '견적서 업로드');
const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
const reopened = XLSX.read(new Uint8Array(bytes), { type: 'array' });
assert.deepEqual(Array.from(reopened.SheetNames), ['쇼핑몰업로드', 'ERP업데이트', '확인요청', '견적서 업로드']);
const reopenedShop = XLSX.utils.sheet_to_json(reopened.Sheets['쇼핑몰업로드'], { header: 1, raw: true, defval: '' });
const reopenedErp = XLSX.utils.sheet_to_json(reopened.Sheets['ERP업데이트'], { header: 1, raw: true, defval: '' });
assert.equal(reopenedShop[1][0], '000101', '실제 XLSX 저장·재열기 뒤에도 선행 0 코드를 보존해야 한다.');
assert.equal(reopenedShop[1][6], '', '실제 XLSX 저장·재열기 뒤에도 원본에 없는 B판매가는 공란이어야 한다.');
assert.deepEqual(Array.from(reopenedShop[1].slice(8, 12)), [0, 0, 0, 0],
  '실제 XLSX 저장·재열기 뒤에도 C/D 판매가·도매가는 숫자 0이어야 한다.');
assert.equal(reopenedErp[1][1], 1000);
assert.equal(reopenedErp[2][1], '', '실제 XLSX 저장·재열기 뒤에도 공란을 보존해야 한다.');
assert.equal(reopenedErp[0].length, 11, '실제 XLSX 재열기 뒤 ERP업데이트는 11열이어야 한다.');
assert.equal(XLSX.utils.decode_range(reopened.Sheets['ERP업데이트']['!ref']).e.c, 10,
  'ERP업데이트 사용범위에 삭제한 후행 5열이 남으면 안 된다.');

const noWarningWorkbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(noWarningWorkbook, XLSX.utils.aoa_to_sheet(subdivisionOutput.shopData), '쇼핑몰업로드');
XLSX.utils.book_append_sheet(noWarningWorkbook, XLSX.utils.aoa_to_sheet(subdivisionOutput.erpData), 'ERP업데이트');
if (subdivisionOutput.confirmData.length > 1) {
  XLSX.utils.book_append_sheet(noWarningWorkbook, XLSX.utils.aoa_to_sheet(subdivisionOutput.confirmData), '확인요청');
}
XLSX.utils.book_append_sheet(noWarningWorkbook, XLSX.utils.aoa_to_sheet(subdivisionOutput.estimateUploadData), '견적서 업로드');
const noWarningBytes = XLSX.write(noWarningWorkbook, { type: 'array', bookType: 'xlsx' });
const noWarningReopened = XLSX.read(new Uint8Array(noWarningBytes), { type: 'array' });
assert.deepEqual(Array.from(noWarningReopened.SheetNames), ['쇼핑몰업로드', 'ERP업데이트', '견적서 업로드'],
  '경고가 없는 실제 XLSX에는 확인요청 없이 견적서 업로드가 마지막이어야 한다.');

console.log('SmartInput estimate F8 adapter and XLSX contract tests passed.');
