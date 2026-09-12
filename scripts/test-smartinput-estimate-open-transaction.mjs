#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8');

function sourceSection(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `SmartInput source must contain ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `SmartInput source must contain ${endMarker} after ${startMarker}`);
  return source.slice(start, end).trim();
}

function assertInOrder(actual, markers, message) {
  let cursor = -1;
  for (const marker of markers) {
    const next = actual.indexOf(marker, cursor + 1);
    assert.notEqual(next, -1, `${message}: missing ${marker}`);
    assert.ok(next > cursor, `${message}: ${marker} must follow the preceding stage`);
    cursor = next;
  }
}

function compile(snippets, exports, values = {}) {
  const context = vm.createContext({ console, ...values });
  const exportSource = exports.map(name => `${JSON.stringify(name)}: ${name}`).join(',');
  vm.runInContext(`${snippets.join('\n\n')}\nglobalThis.__tested = { ${exportSource} };`, context, {
    filename: 'smartinput-estimate-open-transaction.vm.js'
  });
  return { context, tested: context.__tested };
}

const prepareSource = sourceSection(
  'function prepareEstimateOpenRecovery(',
  '\nfunction normalizeCatalogCandidateRows('
);
const buildSource = sourceSection(
  'function buildCatalogRecordCandidate(',
  '\nfunction applyCatalogRecordCandidate('
);
const sourceRowValidationSource = sourceSection(
  'function validateCatalogSourceRowIds(',
  '\nfunction normalizeCatalogCandidateRows('
);
const trialSource = sourceSection(
  'const ESTIMATE_OPEN_TRIAL_RENDER_OPTIONS',
  '\nfunction sameOrderedIds('
);
const restoreSource = sourceSection(
  'function restoreEstimateOpenRecovery(',
  '\nfunction restoreEstimateOpenFocusAndScroll('
);
const rescheduleSource = sourceSection(
  'function rescheduleEstimateOpenRecovery(',
  '\nfunction renderEstimateOpenFeedback('
);
const mappingValidationSource = sourceSection(
  'function validateCatalogCandidateMapping(',
  '\nfunction buildCatalogRecordCandidate('
);
const recoveryMappingAlignmentSource = sourceSection(
  'function linkedCatalogRowReferenceKeys(',
  '\nfunction validateCatalogCandidateMapping('
);
const reportSource = sourceSection(
  'function reportCatalogOpenFailure(',
  '\nfunction finalizeCatalogRecordOpen('
);
const finalizeSource = sourceSection(
  'function finalizeCatalogRecordOpen(',
  '\nfunction loadCatalogRecord('
);
const loadSource = sourceSection(
  'function loadCatalogRecord(',
  '\nfunction startNewCatalog('
);
const cancelSaveSource = sourceSection(
  'function cancelScheduledSave(',
  '\nfunction queueAutosaveSnapshot('
);
const scheduleSaveSource = sourceSection(
  'function scheduleSave(',
  '\nasync function initializeAutosave('
);
const selectionSource = sourceSection(
  'function handleEstimateCardSelection(',
  "\n[...[$('catalogPickerList'), $('linkedEstimateList')]].forEach(list => {"
);

assertInOrder(buildSource, [
  'validateCatalogSourceRowIds(draftSource.rows || []);',
  'catalogDraft = createCatalogOnlyDraft(draftSource, record.estimateId);',
  'const expectedRowIds = normalizeCatalogCandidateRows(catalogDraft);',
  'validateCatalogCandidateMapping(catalogDraft, expectedRowIds, {',
  'snapshotRows: recordDraft?.rows || []',
  'return {'
], 'the candidate must be fully built and validated before it can leave the build stage');

assertInOrder(loadSource, [
  'recovery = prepareEstimateOpenRecovery(pointerSnapshot);',
  'const candidate = buildCatalogRecordCandidate(currentRecord);',
  'applyCatalogRecordCandidate(candidate, recovery.draft.modes.estimate?.catalogRecordId || \'\');',
  'renderCatalogRecordTrial();',
  'verifyCatalogRecordTrial(candidate);',
  'return finalizeCatalogRecordOpen(currentRecord, candidate, { preserveSelection });'
], 'estimate opening must keep the approved transactional stage order');

assertInOrder(prepareSource, [
  'const recovery = captureEstimateOpenRecovery(timerState);',
  'cancelScheduledSave();',
  'cancelScheduledAutoAnalysis();',
  'state.autosaveStatusGeneration += 1;',
  'return recovery;'
], 'the previous work and timer state must be captured before transition timers are cancelled');

assert.match(rescheduleSource,
  /recovery\.saveScheduled \|\| recovery\.autosavePending \|\| recovery\.draftDirty \|\| recovery\.mappingProjectionScheduled\) scheduleSave\(\)/,
  'a restored scheduled/in-flight save, dirty draft, or pending mapping projection must re-arm autosave');
assert.doesNotMatch(loadSource.slice(0, loadSource.indexOf('return finalizeCatalogRecordOpen')),
  /saveDraftNow\(|scheduleSave\(/,
  'candidate build, validation, state replacement, trial render, and row verification must not save');

// A PARTIAL linked row may change representative ID only through one unambiguous surviving source-row reference.
{
  const linkedRow = ({ rowId, refs, sourceRowIndex = 1 }) => ({
    rowId,
    itemCode: 'SHARED-01',
    linkedSourceRefs: refs.map(([estimateId, refRowId]) => ({ estimateId, rowId: refRowId })),
    sourceRowIndex,
    cells: ['SHARED-01'],
    manual: false
  });
  const { tested } = compile([recoveryMappingAlignmentSource], [
    'catalogRecoveryRowIdAliases',
    'alignCatalogCandidateRecoveryMapping'
  ], {
    rowHasLinkedSource: row => Boolean(row?.linkedSourceRefs?.length),
    rebuildCatalogCandidateWorkingRows: session => session.workingRows
  });
  const oldRow = linkedRow({ rowId: 'LINKED:A:A-ROW', refs: [['A', 'A-ROW'], ['B', 'B-ROW']] });
  const survivingRow = linkedRow({ rowId: 'LINKED:B:B-ROW', refs: [['B', 'B-ROW']] });
  const sharedAliases = tested.catalogRecoveryRowIdAliases([oldRow], [survivingRow]);
  assert.deepEqual(JSON.parse(JSON.stringify([...sharedAliases.entries()])), [['LINKED:A:A-ROW', 'LINKED:B:B-ROW']]);
  const aligned = tested.alignCatalogCandidateRecoveryMapping({
    workingRows: [oldRow],
    manualRows: [],
    deletedSourceRows: []
  }, ['LINKED:B:B-ROW'], 'PARTIAL_MISSING', sharedAliases);
  assert.deepEqual(JSON.parse(JSON.stringify(aligned.workingRows.map(row => row.rowId))), ['LINKED:B:B-ROW']);

  const unrelatedSameProduct = linkedRow({ rowId: 'LINKED:B:NEW-B-ROW', refs: [['B', 'NEW-B-ROW']] });
  const unsafeAliases = tested.catalogRecoveryRowIdAliases([oldRow], [unrelatedSameProduct]);
  assert.deepEqual(JSON.parse(JSON.stringify([...unsafeAliases.entries()])), [],
    'the same product without a shared source-row reference must fail closed instead of inheriting mapping evidence');
}

// An applied mapping may not silently discard a target removed from the current registry.
{
  const headers = ['품목코드'];
  const { tested } = compile([mappingValidationSource], ['validateCatalogCandidateMapping'], {
    inputMappingSession: draft => draft.inputMapping,
    inputMappingDefinitions: () => [{ id: 'voucher.estimate.line.productCode' }],
    MAPPING_DECISION: { MAPPED: 'MAPPED', RECOMMENDED: 'RECOMMENDED' },
    MAPPING_SESSION_STATUS: { TEMPLATE_APPLIED: 'TEMPLATE_APPLIED' },
    sameOrderedIds: (left, right) => left.length === right.length && left.every((value, index) => value === right[index]),
    state: { companyId: 'ONEAPP' },
    validateTemplateDraft: () => ({ valid: true }),
    estimateOpenError: (code, message, stage = 'VALIDATE') => Object.assign(new Error(message), { code, stage })
  });
  assert.throws(() => tested.validateCatalogCandidateMapping({
    rows: [],
    inputMapping: {
      schemaVersion: 'ONEAPP_SMARTINPUT_MAPPING_SESSION_V2',
      companyId: 'ONEAPP',
      voucherMode: 'estimate',
      headerRowIndex: 0,
      headers,
      headerSignature: JSON.stringify(headers),
      signature: JSON.stringify({ companyId: 'ONEAPP', voucherMode: 'estimate', headers }),
      sourceMatrix: [headers],
      workingRows: [],
      status: 'TEMPLATE_APPLIED',
      mappings: [{
        columnIndex: 0,
        sourceHeader: headers[0],
        state: 'MAPPED',
        targetFieldId: 'voucher.estimate.line.removedField'
      }]
    }
  }, []), error => error?.code === 'SMARTINPUT_ESTIMATE_OPEN_MAPPING_MISMATCH');
}

// Invalid persisted row identity must fail before normalizeRow can invent a new ID.
{
  const { tested } = compile([sourceRowValidationSource], ['validateCatalogSourceRowIds'], {
    estimateOpenError: (code, message) => Object.assign(new Error(message), { code })
  });
  assert.throws(() => tested.validateCatalogSourceRowIds([{ rowId: '' }]),
    error => error?.code === 'SMARTINPUT_ESTIMATE_OPEN_DRAFT_INVALID');
  assert.throws(() => tested.validateCatalogSourceRowIds([{ rowId: 'ROW-1' }, { rowId: 'ROW-1' }]),
    error => error?.code === 'SMARTINPUT_ESTIMATE_OPEN_DRAFT_INVALID');
}

// An already-running previous autosave is stale for candidate UI, so failure must schedule a fresh prior-work save.
{
  let saves = 0;
  const { tested } = compile([rescheduleSource], ['rescheduleEstimateOpenRecovery'], {
    sourceTextInput: { value: '' },
    inputMappingSession: () => null,
    shoppingOrderImport: () => null,
    scheduleAutoAnalysis: () => assert.fail('analysis was not pending'),
    scheduleSave: () => { saves += 1; }
  });
  tested.rescheduleEstimateOpenRecovery({
    saveScheduled: false,
    autosavePending: true,
    draftDirty: false,
    mappingProjectionScheduled: false,
    analysisScheduled: false
  });
  assert.equal(saves, 1, 'an in-flight previous autosave must be re-armed after failure without another input');
}

// Execute the real load orchestrator with stage spies so accidental reordering is observable.
{
  const events = [];
  const record = { estimateId: 'EST-B', estimateKind: 'INDIVIDUAL', draft: { rows: [] } };
  const candidate = {
    cardKey: { estimateId: 'EST-B', estimateKind: 'INDIVIDUAL' },
    draft: { catalogRecordId: 'EST-B' },
    expectedRowIds: ['ROW-B']
  };
  const { tested } = compile([loadSource], ['loadCatalogRecord'], {
    estimateRecordKind: value => value?.estimateKind === 'LINKED_GROUP' ? 'LINKED_GROUP' : 'INDIVIDUAL',
    estimateRecordForCardKey: () => { events.push('resolve-current-record'); return record; },
    prepareEstimateOpenRecovery: () => {
      events.push('capture-and-cancel');
      return { draft: { modes: { estimate: { catalogRecordId: 'EST-A' } } } };
    },
    buildCatalogRecordCandidate: () => {
      events.push('build-candidate');
      events.push('validate-candidate');
      return candidate;
    },
    applyCatalogRecordCandidate: () => events.push('replace-state'),
    renderCatalogRecordTrial: () => events.push('render-without-persistence'),
    verifyCatalogRecordTrial: () => events.push('verify-rendered-rows'),
    finalizeCatalogRecordOpen: () => {
      events.push('confirm-selection');
      events.push('autosave-once');
      return { status: 'OPENED' };
    },
    reportCatalogOpenFailure: () => assert.fail('the success path must not report a failure'),
    estimateOpenError: (code, message, stage) => Object.assign(new Error(message), { code, stage })
  });

  assert.deepEqual(tested.loadCatalogRecord(record), { status: 'OPENED' });
  assert.deepEqual(events, [
    'resolve-current-record',
    'capture-and-cancel',
    'build-candidate',
    'validate-candidate',
    'replace-state',
    'render-without-persistence',
    'verify-rendered-rows',
    'confirm-selection',
    'autosave-once'
  ]);
}

// Execute the real trial renderer and assert every persistence/side-effect switch is disabled.
{
  const calls = [];
  const { context, tested } = compile([trialSource], [
    'renderCatalogRecordTrial',
    'ESTIMATE_OPEN_TRIAL_RENDER_OPTIONS'
  ], {
    Object,
    renderMode: options => calls.push(JSON.parse(JSON.stringify(options)))
  });
  tested.renderCatalogRecordTrial();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    persistCleanup: false,
    scheduleAnalysis: false,
    announce: false,
    normalizeRows: false,
    loadActivity: false,
    restoreFocus: false,
    restoreScroll: false,
    mutateState: false,
    renderReferences: false
  });
  assert.equal(context.__tested.ESTIMATE_OPEN_TRIAL_RENDER_OPTIONS.persistCleanup, false);
  assert.doesNotMatch(trialSource, /saveDraftNow\(|scheduleSave\(|scheduleAutoAnalysis\(/,
    'the trial renderer must have no direct save or analysis entry point');
}

// Execute finalization separately: selection becomes authoritative before the one permitted save.
{
  const events = [];
  const state = {
    noticeEstimateIds: [],
    estimateWorkingCopyBaselines: new Map()
  };
  const record = { estimateId: 'EST-B', estimateKind: 'INDIVIDUAL' };
  const candidate = {
    cardKey: { estimateId: 'EST-B', estimateKind: 'INDIVIDUAL' },
    draft: { header: { customerId: '' } },
    expectedRowIds: ['ROW-B'],
    hasWorkingCopy: true,
    integrity: null
  };
  let saves = 0;
  const { tested } = compile([finalizeSource], ['finalizeCatalogRecordOpen'], {
    state,
    rememberEstimateLibrarySelection: () => {
      assert.deepEqual(Array.from(state.noticeEstimateIds), ['EST-B']);
      events.push('selection-confirmed');
    },
    estimateTitle: () => 'B 견적서',
    renderEstimateOpenFeedback: () => events.push('success-feedback'),
    renderDelivery: () => events.push('delivery-rendered'),
    $: () => ({ textContent: '' }),
    saveDraftNow: () => {
      saves += 1;
      assert.deepEqual(Array.from(state.noticeEstimateIds), ['EST-B']);
      events.push('autosaved');
    },
    cloneGridValue: value => structuredClone(value),
    toast: () => events.push('success-toast')
  });

  assert.deepEqual(JSON.parse(JSON.stringify(tested.finalizeCatalogRecordOpen(record, candidate))), {
    status: 'OPENED', integrityStatus: 'READY', rowCount: 1
  });
  assert.equal(saves, 1, 'a successful open must autosave exactly once');
  assert.ok(events.indexOf('selection-confirmed') < events.indexOf('autosaved'),
    'selection confirmation must precede autosave');
}

// T07: a rendered-row failure restores A, re-arms A's cancelled autosave, and never saves B.
{
  const events = [];
  const timers = new Map();
  const savedDraftMarkers = [];
  let timerSequence = 0;
  let renderCount = 0;
  const state = {
    estimates: [{ estimateId: 'EST-B', estimateKind: 'INDIVIDUAL', draft: { rows: [] } }],
    draft: { marker: 'previous-A' },
    noticeEstimateIds: ['EST-A'],
    estimateLibrarySelections: {},
    estimateMultiSelectKind: '',
    estimateSelectionReturnDraft: null,
    lastEstimateSave: null,
    estimateOpenFeedback: null,
    tableViewPreferences: {},
    tableViewScrollPositions: {},
    inputListSearch: { open: true, query: 'A edit' },
    inputListSearchReturnFocus: null,
    selectedRowIds: new Set(['ROW-A']),
    sourceImages: { estimate: null },
    pendingImageEvidence: null,
    pendingOcrReview: null,
    pendingSourceName: '',
    pendingStructuredImport: null,
    activeActivity: '',
    photoView: {},
    mappingValidation: null,
    gridPasteUndo: null,
    draftDirty: true,
    saveTimer: null,
    autoAnalyzeTimer: null,
    mappingProjectionTimer: null
  };
  const recovery = {
    draft: { marker: 'previous-A', modes: { estimate: { catalogRecordId: 'EST-A' } } },
    noticeEstimateIds: ['EST-A'],
    estimateLibrarySelections: {},
    estimateMultiSelectKind: '',
    estimateSelectionReturnDraft: null,
    lastEstimateSave: null,
    estimateOpenFeedback: null,
    tableViewPreferences: {},
    tableViewScrollPositions: {},
    inputListSearch: { open: true, query: 'A edit' },
    inputListSearchReturnFocus: null,
    selectedRowIds: ['ROW-A'],
    sourceImages: { estimate: null },
    pendingImageEvidence: null,
    pendingOcrReview: null,
    pendingSourceName: '',
    pendingStructuredImport: null,
    activeActivity: '',
    photoView: {},
    mappingValidation: null,
    gridPasteUndo: null,
    draftDirty: true,
    saveScheduled: true,
    analysisScheduled: false,
    mappingProjectionScheduled: false,
    focus: { selector: '[data-row-id="ROW-A"] input' },
    scroll: [{ id: 'tableScroll', top: 72, left: 14 }]
  };
  const windowValue = {
    setTimeout(callback) {
      const id = ++timerSequence;
      timers.set(id, callback);
      return id;
    }
  };
  const { tested } = compile([
    cancelSaveSource,
    scheduleSaveSource,
    restoreSource,
    rescheduleSource,
    loadSource
  ], ['loadCatalogRecord'], {
    state,
    window: windowValue,
    clearTimeout: id => timers.delete(id),
    setSaveState: () => events.push('autosave-rearmed'),
    saveDraftNow: () => savedDraftMarkers.push(state.draft.marker),
    cloneGridValue: value => structuredClone(value),
    sourceTextInput: { value: '' },
    inputMappingSession: () => null,
    shoppingOrderImport: () => null,
    scheduleAutoAnalysis: () => assert.fail('analysis was not pending'),
    estimateRecordKind: record => record?.estimateKind === 'LINKED_GROUP' ? 'LINKED_GROUP' : 'INDIVIDUAL',
    estimateRecordForCardKey: cardKey => state.estimates.find(record => record.estimateId === cardKey.estimateId) || null,
    prepareEstimateOpenRecovery: () => recovery,
    buildCatalogRecordCandidate: () => ({
      cardKey: { estimateId: 'EST-B', estimateKind: 'INDIVIDUAL' },
      draft: { catalogRecordId: 'EST-B' },
      expectedRowIds: ['ROW-B']
    }),
    applyCatalogRecordCandidate: () => {
      state.draft = { marker: 'failed-target-B', modes: { estimate: { catalogRecordId: 'EST-B' } } };
      events.push('target-state-applied');
    },
    renderCatalogRecordTrial: () => {
      renderCount += 1;
      if (renderCount === 1) {
        assert.equal(state.draft.marker, 'failed-target-B');
        events.push('target-trial-rendered');
      } else {
        assert.equal(state.draft.marker, 'previous-A');
        events.push('previous-state-rendered');
      }
    },
    verifyCatalogRecordTrial: () => {
      events.push('row-verification-failed');
      throw Object.assign(new Error('injected rendered-row mismatch'), {
        code: 'SMARTINPUT_ESTIMATE_OPEN_RENDER_FAILED'
      });
    },
    finalizeCatalogRecordOpen: () => assert.fail('a failed target must never be selected or saved'),
    reportCatalogOpenFailure: (_cardKey, _error, { restoreView = null } = {}) => {
      events.push('failure-reported');
      assert.equal(restoreView, recovery);
      events.push('focus-and-scroll-restored');
      return { status: 'OPEN_FAILED' };
    },
    estimateOpenError: (code, message, stage) => Object.assign(new Error(message), { code, stage })
  });

  assert.deepEqual(tested.loadCatalogRecord(state.estimates[0]), { status: 'OPEN_FAILED' });
  assert.deepEqual(savedDraftMarkers, [], 'failure handling must not synchronously save either target');
  assert.equal(state.draft.marker, 'previous-A');
  assert.equal(timers.size, 1, 'the restored pending/dirty autosave must be scheduled again');
  assert.deepEqual(events, [
    'target-state-applied',
    'target-trial-rendered',
    'row-verification-failed',
    'previous-state-rendered',
    'autosave-rearmed',
    'failure-reported',
    'focus-and-scroll-restored'
  ]);

  const [timer] = timers.values();
  timer();
  assert.deepEqual(savedDraftMarkers, ['previous-A'],
    'without any additional input, the re-armed timer must save only the restored prior work');
  assert.ok(!savedDraftMarkers.includes('failed-target-B'), 'the failed target must never reach autosave');
}

// A stale card whose record disappeared before its queued turn must re-render feedback, then restore view state.
{
  const events = [];
  const pointerView = {
    focus: { selector: '[data-row-id="ROW-A"] input', selectionStart: 2, selectionEnd: 5 },
    scroll: [{ id: 'tableScroll', top: 91, left: 7 }]
  };
  const fallbackFocus = { selector: '[data-row-id="ROW-A"] input', selectionStart: 1, selectionEnd: 1 };
  const fallbackScroll = [{ id: 'tableScroll', top: 33, left: 4 }];
  const state = {
    estimates: [],
    estimateSelectionQueue: Promise.resolve(),
    estimateOpenPointerSnapshot: {
      cardKey: { estimateKind: 'INDIVIDUAL', estimateId: 'EST-GONE' },
      ...pointerView
    }
  };
  let restoredView = null;
  const { tested } = compile([reportSource, loadSource, selectionSource], [
    'loadCatalogRecord',
    'handleEstimateCardSelection'
  ], {
    state,
    estimateRecordKind: record => record?.estimateKind === 'LINKED_GROUP' ? 'LINKED_GROUP' : 'INDIVIDUAL',
    estimateRecordForCardKey: () => null,
    estimateOpenError: (code, message, stage) => Object.assign(new Error(message), { code, stage }),
    estimateTitle: () => '없어진 견적서',
    renderEstimateOpenFeedback: feedback => {
      events.push(`feedback:${feedback.status}`);
    },
    restoreEstimateOpenFocusAndScroll: view => {
      restoredView = view;
      events.push('view-restored');
    },
    prepareEstimateOpenRecovery: () => assert.fail('record-not-found must stop before transition setup'),
    consumeEstimateSyntheticClick: () => false,
    captureEstimateOpenFocus: () => fallbackFocus,
    captureEstimateOpenScroll: () => fallbackScroll,
    estimateMultiSelectActive: () => false,
    beginEstimateMultiSelect: () => assert.fail('a missing record cannot start multi-select'),
    estimateCreation: () => null,
    individualEstimateRecords: () => [],
    estimateRecordsForKind: () => [],
    previewEstimateCreation: () => assert.fail('a missing record cannot create a preview'),
    renderCatalogControls: () => assert.fail('failure feedback owns the catalog rerender'),
    renderDelivery: () => assert.fail('a missing record cannot change delivery'),
    CSS: { escape: value => String(value) }
  });

  const directResult = tested.loadCatalogRecord(
    { estimateId: 'EST-GONE', estimateKind: 'INDIVIDUAL' },
    { pointerSnapshot: pointerView }
  );
  assert.deepEqual(JSON.parse(JSON.stringify(directResult)), {
    status: 'OPEN_FAILED', errorCode: 'SMARTINPUT_ESTIMATE_OPEN_RECORD_NOT_FOUND'
  });
  assert.equal(restoredView, pointerView);
  assert.deepEqual(events, ['feedback:OPEN_FAILED', 'view-restored']);

  events.length = 0;
  restoredView = null;
  const card = { dataset: { estimateKind: 'INDIVIDUAL', estimateId: 'EST-GONE' } };
  const event = {
    ctrlKey: false,
    metaKey: false,
    target: {
      closest(selector) {
        if (selector === '[data-estimate-drag-handle]') return null;
        if (selector === '.estimate-card[data-estimate-id]') return card;
        return null;
      }
    }
  };
  tested.handleEstimateCardSelection(event);
  await state.estimateSelectionQueue;
  assert.deepEqual(JSON.parse(JSON.stringify(restoredView)), pointerView,
    'the queued record-not-found path must use the pre-click focus, selection, and scroll snapshot');
  assert.deepEqual(events, ['feedback:OPEN_FAILED', 'view-restored']);

  events.length = 0;
  restoredView = null;
  state.estimateOpenPointerSnapshot = null;
  tested.handleEstimateCardSelection(event);
  await state.estimateSelectionQueue;
  assert.equal(restoredView.focus, fallbackFocus,
    'keyboard activation must capture a current focus fallback when no pointer snapshot exists');
  assert.equal(restoredView.scroll, fallbackScroll,
    'keyboard activation must capture a current scroll fallback when no pointer snapshot exists');
  assert.deepEqual(events, ['feedback:OPEN_FAILED', 'view-restored']);
}

assert.match(loadSource,
  /if \(!currentRecord\)[\s\S]*restoreView: pointerSnapshot/,
  'direct stale-record resolution must forward the captured view to failure recovery');
assert.match(selectionSource,
  /const record = estimateRecordForCardKey\(cardKey\);[\s\S]*if \(!record\)[\s\S]*restoreView: pointerSnapshot/,
  'the serialized selection callback must re-resolve the record and restore view state if it disappeared');

console.log('SmartInput estimate open transaction ordering, no-write trial, failure autosave recovery, and stale-card view restoration PASS');
