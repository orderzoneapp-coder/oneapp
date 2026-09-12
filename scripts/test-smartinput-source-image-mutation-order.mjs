#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const smartInputSource = readFileSync(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8');
const functionNames = [
  'restoreSourceImageForMode',
  'queueSourceImageMutation',
  'beginSourceImageMutationIntent',
  'sourceImageMutationIntentIsCurrent',
  'finishSourceImageMutationIntent',
  'setPendingSourceImageDelete',
  'finishPendingSourceImageDelete',
  'queueSourceImageDelete',
  'resumePendingSourceImageDeletes',
  'persistSourceImageForMode',
  'clearParserWorkspace'
];
const actualFunctions = functionNames.map(name => {
  const match = smartInputSource.match(new RegExp(`(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `actual SmartInput function ${name} must exist`);
  return match[0];
}).join('\n');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const clone = value => JSON.parse(JSON.stringify(value));
const documentId = 'source-image-mutation-order-document';
const oldImage = {
  documentId,
  dataUrl: 'data:image/png;base64,old-photo',
  sourceImageId: 'photo-old'
};

function createState({ pendingDeletes = [], sourceImage = oldImage } = {}) {
  return {
    draft: {
      activeMode: 'order',
      ui: { pendingSourceImageDeletes: [...pendingDeletes] },
      modes: {
        order: {
          documentId,
          rows: [],
          batches: [],
          sourceText: '',
          activeMethod: 'text'
        }
      }
    },
    sourceImages: { order: sourceImage, purchase: null, sale: null, estimate: null },
    sourceImageRecords: new Map(),
    sourceImageWriteQueues: new Map(),
    sourceImageMutationIntents: new Map(),
    clearedSourceImageDocumentIds: new Set(pendingDeletes),
    selectedRowIds: new Set(),
    analysisRequestId: 0,
    photoCaptureSequence: 0,
    shoppingInspectionRequestId: 0,
    autoAnalyzeTimer: null,
    shoppingInspectionTimer: null,
    busy: false,
    listening: false
  };
}

function createRuntime({ state, saveSourceImage, deleteSourceImage }) {
  const draftSaves = [];
  const statuses = [];
  const node = {
    value: '',
    hidden: false,
    textContent: '',
    querySelector() { return this; },
    focus() {}
  };
  const modeUiState = {};
  const context = vm.createContext({
    state,
    Map,
    Set,
    Promise,
    Date,
    Object,
    clearTimeout,
    modeDraft: () => state.draft.modes.order,
    modeUi: () => modeUiState,
    sourceTextInput: node,
    $: () => node,
    contract: { markDuplicatePossibilities: rows => rows },
    saveSourceImage,
    deleteSourceImage,
    saveDraftNow: () => draftSaves.push(clone(state.draft)),
    setAppStatus: (...args) => statuses.push(args),
    referencesReady: () => true,
    referenceStatusMessage: () => '',
    toast() {},
    invalidateOptionalOperations() {},
    invalidateGridPasteUndo() {},
    resetPhotoView() {},
    updateMethod() {},
    setActiveActivity() {},
    renderReferenceControls() {},
    renderMode() {}
  });
  vm.runInContext(actualFunctions, context);
  return { context, draftSaves, statuses };
}

async function settleUntil(predicate, message) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.ok(predicate(), message);
}

{
  const saveGate = deferred();
  const deleteGate = deferred();
  const disk = new Map();
  let deleteStarted = false;
  const state = createState();
  const runtime = createRuntime({
    state,
    saveSourceImage: async record => {
      await saveGate.promise;
      disk.set(record.documentId, record);
    },
    deleteSourceImage: async id => {
      deleteStarted = true;
      await deleteGate.promise;
      disk.delete(id);
    }
  });

  const oldSave = runtime.context.persistSourceImageForMode('order');
  await Promise.resolve();
  runtime.context.clearParserWorkspace();
  assert.equal(state.draft.ui.pendingSourceImageDeletes.includes(documentId), true,
    'clearing while a save is pending must durably record the later delete intent');

  saveGate.resolve();
  assert.equal(await oldSave, true);
  await settleUntil(() => deleteStarted, 'the queued delete must start after the older save settles');
  assert.equal(state.draft.ui.pendingSourceImageDeletes.includes(documentId), true,
    'an older save acknowledgement must not clear a newer delete marker');
  assert.equal(state.clearedSourceImageDocumentIds.has(documentId), true,
    'an older save acknowledgement must not clear the in-session resurrection guard');

  deleteGate.reject(new Error('injected source-image delete failure'));
  await settleUntil(
    () => !state.sourceImageWriteQueues.has(documentId),
    'the failed delete queue must settle without losing its durable marker'
  );
  assert.equal(disk.has(documentId), true, 'the fixture must retain the old photo after the injected delete failure');
  assert.equal(runtime.draftSaves.at(-1).ui.pendingSourceImageDeletes.includes(documentId), true,
    'a failed delete must leave the marker in the latest persisted draft');

  const reloadedState = createState({
    pendingDeletes: runtime.draftSaves.at(-1).ui.pendingSourceImageDeletes,
    sourceImage: null
  });
  const reloadedRuntime = createRuntime({
    state: reloadedState,
    saveSourceImage: async record => disk.set(record.documentId, record),
    deleteSourceImage: async id => disk.delete(id)
  });
  reloadedRuntime.context.resumePendingSourceImageDeletes();
  await settleUntil(
    () => !reloadedState.draft.ui.pendingSourceImageDeletes.includes(documentId),
    'reload must resume and finish the durable delete intent'
  );
  assert.equal(disk.has(documentId), false, 'reload must remove the old photo instead of resurrecting it');
  assert.equal(reloadedState.clearedSourceImageDocumentIds.has(documentId), true,
    'the session guard must continue hiding the cleared image after cleanup');
}

{
  const oldSaveGate = deferred();
  const replacementSaveGates = [deferred(), deferred()];
  const deleteGate = deferred();
  const disk = new Map();
  let deleteStarted = false;
  let replacementSaveStarted = 0;
  const replacementImage = {
    documentId,
    dataUrl: 'data:image/png;base64,replacement-photo',
    sourceImageId: 'photo-replacement'
  };
  const state = createState();
  const runtime = createRuntime({
    state,
    saveSourceImage: async record => {
      if (record.sourceImageId === oldImage.sourceImageId) await oldSaveGate.promise;
      else {
        const gate = replacementSaveGates[replacementSaveStarted];
        replacementSaveStarted += 1;
        await gate.promise;
      }
      disk.set(record.documentId, record);
    },
    deleteSourceImage: async id => {
      deleteStarted = true;
      await deleteGate.promise;
      disk.delete(id);
    }
  });

  const oldSave = runtime.context.persistSourceImageForMode('order');
  await Promise.resolve();
  runtime.context.clearParserWorkspace();
  state.sourceImages.order = replacementImage;
  const firstReplacementSave = runtime.context.persistSourceImageForMode('order');
  const secondReplacementSave = runtime.context.persistSourceImageForMode('order');

  oldSaveGate.resolve();
  assert.equal(await oldSave, true);
  await settleUntil(() => deleteStarted, 'replacement flow must preserve save-delete-save serialization');
  assert.equal(state.draft.ui.pendingSourceImageDeletes.includes(documentId), true,
    'the old save must retain the delete marker while replacement persistence is pending');

  deleteGate.resolve();
  await settleUntil(() => replacementSaveStarted === 1, 'the replacement save must start after deletion settles');
  assert.equal(state.draft.ui.pendingSourceImageDeletes.includes(documentId), true,
    'delete acknowledgement must not clear the marker owned by a later replacement save');
  replacementSaveGates[0].resolve();
  assert.equal(await firstReplacementSave, true);
  await settleUntil(() => replacementSaveStarted === 2, 'the repeated save for the same replacement must remain serialized');
  replacementSaveGates[1].reject(new Error('injected repeated replacement save failure'));
  assert.equal(await secondReplacementSave, false,
    'a later failed persistence attempt must report failure without invalidating an earlier durable replacement');
  assert.equal(disk.get(documentId)?.sourceImageId, replacementImage.sourceImageId,
    'the latest replacement photo must be the durable record');
  assert.equal(state.draft.ui.pendingSourceImageDeletes.includes(documentId), false,
    'only the latest replacement save acknowledgement may clear the marker');
  assert.equal(state.clearedSourceImageDocumentIds.has(documentId), false,
    'a durable replacement may re-enable source-image restoration');

  const reloadedState = createState({ sourceImage: null });
  reloadedState.sourceImageRecords.set(documentId, disk.get(documentId));
  const reloadedRuntime = createRuntime({
    state: reloadedState,
    saveSourceImage: async record => disk.set(record.documentId, record),
    deleteSourceImage: async id => disk.delete(id)
  });
  reloadedRuntime.context.restoreSourceImageForMode('order');
  assert.equal(reloadedState.sourceImages.order?.sourceImageId, replacementImage.sourceImageId,
    'reload must restore the already durable replacement after a repeated save fails');
}

{
  const oldSaveGate = deferred();
  const deleteGate = deferred();
  const disk = new Map();
  let saveCount = 0;
  let deleteStarted = false;
  const state = createState();
  const runtime = createRuntime({
    state,
    saveSourceImage: async record => {
      saveCount += 1;
      if (saveCount === 1) await oldSaveGate.promise;
      disk.set(record.documentId, record);
    },
    deleteSourceImage: async id => {
      deleteStarted = true;
      await deleteGate.promise;
      disk.delete(id);
    }
  });

  const oldSave = runtime.context.persistSourceImageForMode('order');
  await Promise.resolve();
  runtime.context.clearParserWorkspace();
  state.sourceImages.order = { ...oldImage };
  const sameImageReplacement = runtime.context.persistSourceImageForMode('order');
  oldSaveGate.resolve();
  assert.equal(await oldSave, true);
  await settleUntil(() => deleteStarted, 'same-image replacement must wait behind the newer delete intent');
  assert.equal(state.draft.ui.pendingSourceImageDeletes.includes(documentId), true,
    'the old acknowledgement for the same sourceImageId must remain stale across clear');
  deleteGate.reject(new Error('injected delete failure before same-image replacement'));
  assert.equal(await sameImageReplacement, true,
    'a replacement save must continue after the preceding delete attempt fails');
  assert.equal(saveCount, 2);
  assert.equal(disk.get(documentId)?.sourceImageId, oldImage.sourceImageId,
    'the explicitly reselected same photo must remain durable');
  assert.equal(state.draft.ui.pendingSourceImageDeletes.includes(documentId), false,
    'the new same-image generation may clear the failed delete marker after its own save succeeds');
  assert.equal(state.clearedSourceImageDocumentIds.has(documentId), false);
}

{
  const firstDeleteGate = deferred();
  const finalDeleteGate = deferred();
  const disk = new Map([[documentId, oldImage]]);
  let deleteCount = 0;
  const replacementImage = {
    documentId,
    dataUrl: 'data:image/png;base64,replacement-before-final-clear',
    sourceImageId: 'photo-before-final-clear'
  };
  const state = createState();
  const runtime = createRuntime({
    state,
    saveSourceImage: async record => disk.set(record.documentId, record),
    deleteSourceImage: async id => {
      deleteCount += 1;
      if (deleteCount === 1) await firstDeleteGate.promise;
      else await finalDeleteGate.promise;
      disk.delete(id);
    }
  });

  runtime.context.clearParserWorkspace();
  state.sourceImages.order = replacementImage;
  const replacementSave = runtime.context.persistSourceImageForMode('order');
  runtime.context.clearParserWorkspace();
  firstDeleteGate.resolve();
  assert.equal(await replacementSave, true);
  await settleUntil(() => deleteCount === 2, 'the final clear must enqueue its own delete generation');
  assert.equal(state.draft.ui.pendingSourceImageDeletes.includes(documentId), true,
    'a replacement save acknowledgement must not clear the final delete marker');
  assert.equal(state.clearedSourceImageDocumentIds.has(documentId), true,
    'the final clear must keep the in-session resurrection guard');
  finalDeleteGate.reject(new Error('injected final delete failure'));
  await settleUntil(
    () => !state.sourceImageWriteQueues.has(documentId),
    'the final failed delete must settle while retaining its marker'
  );
  assert.equal(disk.get(documentId)?.sourceImageId, replacementImage.sourceImageId,
    'the fixture must retain the replacement only because the final delete was injected to fail');
  assert.equal(runtime.draftSaves.at(-1).ui.pendingSourceImageDeletes.includes(documentId), true,
    'reload must retain enough intent to retry the final clear');
}

console.log('SmartInput source-image mutation ordering PASS');
