#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const VOUCHER_MODE = Object.freeze({ 주문: 'order', 견적: 'estimate', 구매: 'purchase', 판매: 'sale' });
const OWNER_DOMAIN = Object.freeze({
  PRODUCT_MASTER: 'PRODUCT_MASTER',
  CUSTOMER_MASTER: 'CUSTOMER_MASTER',
  WAREHOUSE_MASTER: 'WAREHOUSE_MASTER',
  EMPLOYEE_MASTER: 'EMPLOYEE_MASTER',
  PROJECT_MASTER: 'PROJECT_MASTER',
  PAYABLE_LEDGER: 'LEDGER',
  RECEIVABLE_LEDGER: 'LEDGER'
});

const text = value => String(value ?? '').normalize('NFKC').trim();
const env = name => text(process.env[name]);

async function artifactTool() {
  try { return await import('@oai/artifact-tool'); }
  catch (error) {
    const modulePath = env('CODEX_ARTIFACT_TOOL_MODULE');
    if (!modulePath) throw new Error(`ARTIFACT_TOOL_MODULE_REQUIRED:${error.message}`);
    return import(modulePath.startsWith('file:') ? modulePath : pathToFileURL(modulePath).href);
  }
}

function valueType(label, conceptId) {
  const token = `${text(label)} ${text(conceptId)}`.toUpperCase();
  if (/일자|DATE/.test(token)) return 'DATE';
  if (/수량|단가|금액|합계|공급가|부가세|환율|비율|원가|시간|기간|NUMBER|QUANTITY|PRICE|AMOUNT|RATE|COST/.test(token)) return 'DECIMAL';
  return 'TEXT';
}

function scopeOf(area, role) {
  const normalizedArea = text(area).toUpperCase();
  const normalizedRole = text(role).toUpperCase();
  if (normalizedArea === 'HEADER') return 'HEADER';
  if (normalizedArea === 'LINE' || normalizedArea === 'SUMMARY') return 'LINE';
  if (normalizedArea.startsWith('MASTER')) return 'REFERENCE';
  if (normalizedArea.startsWith('RELATED') || normalizedArea === 'TRACE') return 'RELATED';
  if (normalizedArea === 'LEDGER' || normalizedArea === 'AUDIT' || ['DERIVED', 'RESULT_LEDGER', 'AUDIT', 'SYSTEM'].includes(normalizedRole)) return 'RESULT';
  if (normalizedArea === 'UNKNOWN' || normalizedRole === 'CUSTOM_INPUT') return 'CUSTOM';
  return 'REFERENCE';
}

function ownerDomain(owner) {
  const normalized = text(owner).toUpperCase();
  if (normalized.startsWith('SMARTINPUT:')) return 'SMARTINPUT_VOUCHER';
  return OWNER_DOMAIN[normalized] || 'SYSTEM';
}

function definitionFromRow(row, generatedAt) {
  const [occurrenceNo, voucher, itemType, relationship, area, sourceFieldCode, fullPath, dataRole,
    owner, writable, exposure, mapping, proposedFieldId, conceptId, rationale, confidence, reviewStatus] = row;
  const mode = VOUCHER_MODE[text(voucher)];
  const status = text(reviewStatus) === '검토필요' ? 'REVIEW_REQUIRED' : 'ACTIVE';
  const scope = scopeOf(area, dataRole);
  const writeAllowed = text(writable) === 'YES';
  const mappingAllowed = ['AUTO_CANDIDATE', 'MANUAL_CANDIDATE', 'TRANSFORM_CANDIDATE'].includes(text(mapping)) && status === 'ACTIVE';
  return {
    schemaVersion: 'ONEAPP_SMARTINPUT_FIELD_DEFINITION_V2',
    generationId: 'FIELD-SEED-V2',
    fieldId: text(proposedFieldId),
    ownerDomain: ownerDomain(owner),
    relationshipPath: [mode.toUpperCase(), text(relationship), text(area), text(itemType)],
    voucherModes: [mode],
    scope,
    role: text(conceptId || dataRole),
    sourceFieldCode: text(sourceFieldCode),
    displayLabel: text(sourceFieldCode),
    advancedLabel: text(fullPath),
    valueType: valueType(sourceFieldCode, conceptId),
    writable: writeAllowed,
    mappable: mappingAllowed,
    outputOnly: !writeAllowed || ['SYSTEM', 'AUDIT', 'DERIVED', 'REFERENCE', 'RESULT_LEDGER', 'SOURCE_DOCUMENT'].includes(text(dataRole)),
    systemRequired: false,
    effectRole: '',
    aliases: [text(sourceFieldCode)],
    status,
    reviewReason: status === 'REVIEW_REQUIRED' ? text(rationale) : '',
    definitionRevision: 1,
    ownerRevision: 'ERP-FIELD-ANALYSIS-V1',
    updatedAt: generatedAt,
    sourceOccurrences: [{
      occurrenceNo: Number(occurrenceNo),
      voucher: text(voucher),
      itemType: text(itemType),
      relationship: text(relationship),
      area: text(area),
      dataRole: text(dataRole),
      ownerCandidate: text(owner),
      writable: text(writable),
      exposurePolicy: text(exposure),
      mappingPolicy: text(mapping),
      confidence: text(confidence),
      reviewStatus: text(reviewStatus)
    }]
  };
}

const sourcePath = path.resolve(process.argv[2] || env('SMARTINPUT_FIELD_SOURCE_XLSX'));
const outputPath = path.resolve(process.argv[3] || 'smartinput/field-catalog-seed.v2.json');
if (!sourcePath) throw new Error('SOURCE_XLSX_REQUIRED');

const { FileBlob, SpreadsheetFile } = await artifactTool();
const input = await FileBlob.load(sourcePath);
const bytes = await fs.readFile(sourcePath);
const sourceSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem('전체항목');
if (!sheet) throw new Error('FIELD_SOURCE_SHEET_REQUIRED:전체항목');
const rows = sheet.getRange('A5:S2182').values.filter(row => Number(row?.[0]) > 0);
if (rows.length !== 2178) throw new Error(`FIELD_SOURCE_ROW_COUNT_INVALID:${rows.length}`);
const generatedAt = new Date().toISOString();
const definitions = rows.map(row => definitionFromRow(row, generatedAt));
const reviewRequiredCount = definitions.filter(row => row.status === 'REVIEW_REQUIRED').length;
if (reviewRequiredCount !== 63) throw new Error(`FIELD_SOURCE_REVIEW_COUNT_INVALID:${reviewRequiredCount}`);
const modeCounts = Object.fromEntries(Object.values(VOUCHER_MODE).map(mode => [mode,
  definitions.filter(row => row.voucherModes.includes(mode)).length]));
const expectedModeCounts = { order: 477, estimate: 614, purchase: 468, sale: 619 };
if (JSON.stringify(modeCounts) !== JSON.stringify(expectedModeCounts)) throw new Error(`FIELD_SOURCE_MODE_COUNTS_INVALID:${JSON.stringify(modeCounts)}`);

const result = {
  schemaVersion: 'ONEAPP_SMARTINPUT_FIELD_CATALOG_SEED_V2',
  generationId: 'FIELD-SEED-V2',
  sourceFile: path.basename(sourcePath),
  sourceSha256,
  generatedAt,
  occurrenceCount: rows.length,
  definitionCount: definitions.length,
  reviewRequiredCount,
  modeCounts,
  definitions
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
// This seed is fetched only when an administrator performs a full refresh.
// Keep the deployed payload compact; the workbook and this generator remain
// the reviewable source of truth.
await fs.writeFile(outputPath, `${JSON.stringify(result)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, sourceSha256, rowCount: rows.length, reviewRequiredCount, modeCounts }));
