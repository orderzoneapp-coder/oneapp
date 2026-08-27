import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, css, app] = await Promise.all([
  readFile(new URL('../smartinput/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../smartinput/smartinput.css', import.meta.url), 'utf8'),
  readFile(new URL('../smartinput/smartinput.js', import.meta.url), 'utf8')
]);

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function functionBlock(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = app.indexOf('\nfunction ', start + 10);
  return app.slice(start, next < 0 ? app.length : next);
}

assert.match(html, /smartinput\.css\?v=0\.4\.36/, 'worktable CSS cache key must invalidate the previous combined-screen asset');
assert.match(html, /smartinput\.js\?v=0\.4\.43/, 'worktable JS cache key must invalidate the previous combined-screen asset');
assert.doesNotMatch(html, /smartinput\.css\?v=0\.4\.(?:30|35)/,
  'the deployed page must not reuse a stale CSS cache key');
assert.doesNotMatch(html, /smartinput\.js\?v=0\.4\.(?:36|42)/,
  'the deployed page must not reuse a stale JS cache key');

assert.equal(occurrences(html, /class="document-fields"/g), 1, 'mobile must move, not clone, the document information DOM');
assert.match(html, /id="documentFieldsAnchor"/);
assert.match(app, /if \(mobile\) parserCard\.before\(fields\);\s*else anchor\.after\(fields\);/);
assert.match(functionBlock('placeDocumentFieldsForLayout'), /captureFocusedField\(\)/);
assert.match(functionBlock('placeDocumentFieldsForLayout'), /restoreFocusedField\(focus\)/);

for (const id of [
  'mobileStageNav',
  'mobileInfoToggle',
  'mobileInfoSummary',
  'mobileParserToolbar',
  'mobileAnalyzeButton',
  'mobileClearParserButton',
  'sourceFullscreenButton',
  'mobileParserDragHandle'
]) assert.match(html, new RegExp(`id="${id}"`));
for (const stage of ['info', 'source', 'grid']) {
  assert.match(html, new RegExp(`data-mobile-stage="${stage}"`));
}
for (const preset of ['collapsed', 'default', 'expanded']) {
  assert.match(html, new RegExp(`data-mobile-parser-preset="${preset}"`));
}

assert.match(functionBlock('mobileUi'), /state\.draft\.ui\.mobile/);
assert.match(functionBlock('mobileUi'), /infoCollapsed/);
assert.match(functionBlock('mobileUi'), /parserPreset/);
assert.match(functionBlock('mobileUi'), /parserRatio/);
assert.match(functionBlock('mobileUi'), /stageByMode/);
assert.match(functionBlock('currentMobileStage'), /stageByMode/);
assert.match(functionBlock('setMobileStage'), /mobileUi\(\)\.stageByMode\[state\.draft\.activeMode\] = stage/);
assert.match(functionBlock('syncMobileStage'), /document\.body\.dataset\.mobileStage = stage/);
assert.doesNotMatch(functionBlock('setMobileStage'), /analyzeSource|renderRows|replaceRows|\.rows\s*=/,
  'mobile stage changes must preserve source, analysis results and item rows');
assert.match(app, /mobileStageNav'\)\.addEventListener\('click'/);
assert.doesNotMatch(app, /localStorage\.(?:getItem|setItem)\([^\n]*(?:mobile|parserPreset|infoCollapsed)/i,
  'mobile UI state must not use a separate storage key');
assert.match(app, /MOBILE_PARSER_COLLAPSED_HEIGHT = 68/);
assert.match(app, /MOBILE_PARSER_DEFAULT_RATIO = \.325/);
assert.match(app, /MOBILE_PARSER_EXPANDED_RATIO = \.65/);
assert.match(app, /MOBILE_GRID_MIN_HEIGHT = 185/);
assert.match(app, /parserPreset === 'custom'[\s\S]*viewportHeight \* mobile\.parserRatio/);

const forbiddenHeightSideEffects = /analyzeSource|scheduleAutoAnalysis|renderSourceSurface|renderRows|replaceRows|\.rows\s*=/;
for (const name of [
  'mobileParserBounds',
  'applyMobileParserHeight',
  'setMobileParserPreset',
  'beginMobileParserDrag',
  'moveMobileParserDrag',
  'finishMobileParserDrag',
  'resizeMobileParserWithKeyboard',
  'syncMobileViewportLayout'
]) {
  assert.doesNotMatch(functionBlock(name), forbiddenHeightSideEffects,
    `${name} must change layout/state only`);
}

assert.match(app, /mobileParserDragHandle'\)\.addEventListener\('pointercancel', finishMobileParserDrag\)/);
assert.match(app, /photoViewport'\)\.addEventListener\('pointercancel', finishPhotoGesture\)/);
assert.match(css, /\.mobile-parser-drag-handle[^}]*min-height:\s*44px/);
assert.match(css, /\.mobile-parser-resizer:not\(\[hidden\]\)[^}]*height:\s*44px/);
assert.match(css, /\.photo-viewer__viewport[^}]*touch-action:\s*none/);
assert.match(css, /\.workspace\.has-tabular-source[^}]*touch-action:\s*pan-x pan-y/);
assert.equal(occurrences(app, /addEventListener\('pointerdown', beginPhotoGesture/g), 1,
  'pinch/pan must be installed only once');
assert.match(app, /\$\('photoViewport'\)\.addEventListener\('pointerdown', beginPhotoGesture/);

assert.match(app, /visualViewport\?\.addEventListener\('resize', scheduleMobileViewportLayout/);
assert.match(app, /visualViewport\?\.addEventListener\('scroll', scheduleMobileViewportLayout/);
assert.match(app, /visualViewport\?\.removeEventListener\('resize', scheduleMobileViewportLayout\)/);
assert.match(app, /visualViewport\?\.removeEventListener\('scroll', scheduleMobileViewportLayout\)/);
assert.match(app, /window\.cancelAnimationFrame\(state\.mobileLayout\.frame\)/);
assert.match(functionBlock('syncMobileViewportLayout'), /revealGridInput\(activeCell\)/);
assert.doesNotMatch(functionBlock('revealGridInput'), /window\.scroll|scrollIntoView|document\.documentElement\.scroll/,
  'keyboard reveal must stay within the table scroller');

assert.match(app, /function openSourceFullscreen\(/);
assert.match(app, /function closeSourceFullscreen\(/);
assert.match(app, /event\.key === 'Escape'[\s\S]*closeSourceFullscreen\(\)/);
assert.match(functionBlock('openSourceFullscreen'), /captureFocusedField\(\)/);
assert.match(functionBlock('openSourceFullscreen'), /captureMobileSourceView/);
assert.match(functionBlock('closeSourceFullscreen'), /restoreMobileSourceView/);
assert.match(functionBlock('closeSourceFullscreen'), /restoreFocusedField/);
assert.match(css, /\.parser-card\.is-source-fullscreen/);
assert.match(css, /body\.is-source-fullscreen #completeButton/);

assert.match(css, /#completeButton[^}]*position:\s*fixed/);
assert.match(css, /#completeButton[^}]*env\(safe-area-inset-bottom\)/);
assert.match(css, /\.source-highlight, \.source-editor textarea[^}]*font-size:\s*16px/);
assert.match(css, /\.table-scroll, \.workspace\.has-photo-source \.table-scroll[^}]*overflow:\s*auto/);
assert.match(css, /\.workbench, \.workspace\.has-photo-source \.workbench[^}]*min-height:\s*var\(--smartinput-mobile-grid-min-height/);
assert.match(css, /@media \(max-width: 820px\), \(max-width: 1024px\) and \(max-height: 540px\)/);
assert.match(css, /\.mobile-stage-nav:not\(\[hidden\]\)[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
assert.match(css, /body\[data-mobile-stage="info"\][\s\S]*\.parser-card[\s\S]*\.workbench \{ display: none; \}/);
assert.match(css, /body\[data-mobile-stage="source"\][\s\S]*\.document-fields[\s\S]*\.workbench \{ display: none; \}/);
assert.match(css, /body\[data-mobile-stage="grid"\][\s\S]*\.document-fields[\s\S]*\.parser-card[\s\S]*display: none/);
assert.match(css, /body\[data-mobile-stage="grid"\] \.workspace\.has-photo-source \.document-fields/,
  'photo mode must obey the same exclusive mobile stage visibility');
assert.match(css, /body\[data-mobile-stage="grid"\] \.workspace\.has-photo-source \.parser-card/,
  'photo parser must not leak into the item-entry stage');
assert.match(css, /body:not\(\[data-mobile-stage="grid"\]\) #completeButton \{ display: none; \}/);
assert.match(css, /\.voucher-footer-actions \{ min-height: 0;[^}]*display: grid/,
  'mobile grid stage must expose voucher save/output/reset actions without horizontal overflow');
assert.match(css, /@media \(min-width: 1481px\)/, 'desktop fixed-height layout must remain present');
assert.match(css, /html\[data-nexus-theme="dark"\]/, 'mobile must consume the existing theme contract');

console.log('SmartInput mobile UI/UX fixture PASS');
