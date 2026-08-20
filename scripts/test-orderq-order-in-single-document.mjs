import assert from 'node:assert/strict';
import fs from 'node:fs';

const engine = fs.readFileSync(new URL('../orderq/intake-engine.js', import.meta.url), 'utf8');
const adapter = fs.readFileSync(new URL('../orderq/intake-document-adapter.js', import.meta.url), 'utf8');
const workbench = fs.readFileSync(new URL('../orderq/intake-workbench.js', import.meta.url), 'utf8');
const parserHtml = fs.readFileSync(new URL('../orderq/parser.html', import.meta.url), 'utf8');

for (const name of [
  'captureTextIntake',
  'analyzeSingleOrderDocument',
  'parseStructuredOrderText',
  'saveExtractionReview',
  'confirmExtraction',
  'saveMatchingReview',
  'confirmMatching',
  'saveOrderCompletion',
  'commitIntakeOrder',
  'reopenIntakeStage'
]) assert.match(engine, new RegExp(name));

assert.match(adapter, /ORDERQ_INTAKE_MULTIPLE_DOCUMENTS_REQUIRES_STAGE4/);
assert.match(engine, /ORDERQ_INTAKE_CUSTOMER_REQUIRED/);
assert.match(engine, /SHOP_TABLE/);
assert.match(engine, /MASTER_CODE/);
assert.match(workbench, /분석 중/);
assert.match(workbench, /customerPreset/);
assert.match(workbench, /Tesseract/);
assert.match(workbench, /imageEvidence/);
assert.match(parserHtml, />분석 실행 /);
assert.match(parserHtml, /id="customerPreset"/);
assert.match(parserHtml, /id="imageInput"/);
assert.doesNotMatch(parserHtml, /id="sourceId"/);
assert.doesNotMatch(parserHtml, /id="sourceType"/);
assert.match(parserHtml, /tesseract\.js@6/);

console.log('ORDER IN single document + customer/photo intake PASS');
