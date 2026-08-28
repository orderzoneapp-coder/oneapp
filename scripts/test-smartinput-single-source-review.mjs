import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, css, app] = await Promise.all([
  readFile(new URL('../smartinput/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../smartinput/smartinput.css', import.meta.url), 'utf8'),
  readFile(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8')
]);

function between(startNeedle, endNeedle) {
  const start = app.indexOf(startNeedle);
  const end = app.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0 && end > start, `${startNeedle} block missing`);
  return app.slice(start, end);
}

assert.equal([...html.matchAll(/class="parser-input-row"/g)].length, 1,
  'the parser must contain one source review viewport');
assert.doesNotMatch(html, /mobileParserDragHandle|data-mobile-parser-preset/);
assert.doesNotMatch(css, /mobile-parser-drag-handle|mobile-parser-resizer|MOBILE_PARSER_/i);
assert.match(css, /\.parser-card \{[^}]*display: flex;[^}]*flex-direction: column/);

for (const id of [
  'sourceSelect', 'previousSourceButton', 'nextSourceButton', 'sourceStatus',
  'sourceStagingSummary', 'sourceStagingRows', 'applyStagedRowsButton', 'authorizeReapplyButton'
]) assert.match(html, new RegExp(`id="${id}"`));

assert.match(html, /id="inputTemplateOpenButton"[^>]*aria-expanded="false"[^>]*aria-controls="inputTemplateOverlay"/);
assert.match(html, /id="inputTemplateOverlay"[^>]*hidden/);
assert.match(css, /\.input-template-overlay \{[^}]*position: fixed;[^}]*inset: 0/,
  'Excel template controls must overlay the page instead of consuming source viewport height');
assert.match(css, /\.parser-card:has\(\.input-template-overlay:not\(\[hidden\]\)\) \{[^}]*z-index: 200/,
  'the open template overlay must escape the parser sticky stacking order above worktable headers');
assert.match(css, /\.source-staging__rows \{[^}]*position: absolute/,
  'staged row selection must open as an overlay instead of splitting the source viewport');

const analyze = between('async function analyzeSource', 'function applyActiveSourceStaging');
assert.match(analyze, /const workTableBytesBefore = JSON\.stringify\(current\.rows\)/);
assert.match(analyze, /await stageSourceRows\(/);
assert.match(analyze, /WORKTABLE_CHANGED_BEFORE_EXPLICIT_APPLY/);
assert.doesNotMatch(analyze,
  /applyParserResults|current\.rows\s*=|createOrder\(|postPurchaseGroup\(|postSaleGroup\(|updateEstimateAtomically\(|captureTextIntake|analyzeSingleOrderDocument/,
  'source analysis must not mutate the worktable or call an official writer');

const templateStage = between('async function applyInputTemplateData', 'function loadDraft');
assert.match(templateStage, /await stageSourceRows\(/);
assert.match(templateStage, /frozenRecordBytes/);
assert.doesNotMatch(templateStage, /applyParserResults|current\.rows\s*=|updateInputTemplateStructure|createInputTemplate/,
  'mapped Excel values must remain staged and existing-template structure must stay locked');
assert.match(app, /typedSourceIdentityBytes\(html \? 'HTML_TABLE' : 'TSV', new TextEncoder\(\)\.encode\(rawClipboard\)\)/,
  'Excel paste identity must hash the received bytes together with the HTML/TSV input kind');

const explicitApply = between('function applyActiveSourceStaging', 'function retryActiveSourceAnalysis');
assert.match(explicitApply, /contract\.applyParserResults\(/);
assert.match(explicitApply, /recordSourceApplications\(/);
assert.match(explicitApply, /sourceRole: 'APPLIED_SOURCE'/);

const clearSource = between('function clearParserWorkspace', 'async function sha256Text');
assert.match(clearSource, /removeSource\(current, source\.sourceId, \{ discardPending: true \}\)/);
assert.match(clearSource, /SOURCE_REMOVE_CHANGED_WORKTABLE/);
assert.doesNotMatch(clearSource, /current\.rows\s*=|sourceApplicationLedger\s*=/);

const selectedDelete = between('function deleteSelectedGridRows', 'function selectedManualGroupContext');
assert.ok(selectedDelete.indexOf('markWorkRowsDeleted') < selectedDelete.indexOf('removeRowsById'),
  'work-row deletion must record ledger deletion before removing the row');

const recognizeImage = between('async function recognizeImage', 'function toggleVoice');
const previewAt = recognizeImage.indexOf('URL.createObjectURL(file)');
const renderAt = recognizeImage.indexOf('renderSourceSurface();');
const bytesAt = recognizeImage.indexOf('await fileToImageEvidence(file, previewUrl)');
const ocrAt = recognizeImage.indexOf('await recognizeOcrDocument(file');
assert.ok(previewAt >= 0 && previewAt < renderAt && renderAt < bytesAt && bytesAt < ocrAt,
  'image preview must render before raw-byte hashing and OCR');

const renderMode = between('function renderMode', 'function setMode');
assert.match(renderMode, /renderSourceWorkspace\(\)/,
  'draft and mode recovery must restore source navigation, status, and staging UI');

console.log('SmartInput single-source review and explicit-staging UI contract PASS');
