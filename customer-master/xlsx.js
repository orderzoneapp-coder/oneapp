import { clean, parseDelimited } from './core.js';

const textDecoder = new TextDecoder('utf-8');

function findEndOfCentralDirectory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error('XLSX_ZIP_DIRECTORY_NOT_FOUND');
}

function zipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes);
  const totalEntries = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let index = 0; index < totalEntries; index += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('XLSX_ZIP_ENTRY_INVALID');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = textDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).replace(/\\/g, '/');
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readZipEntry(bytes, entries, name) {
  const entry = entries.get(name);
  if (!entry) return '';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) throw new Error('XLSX_ZIP_LOCAL_ENTRY_INVALID');
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return textDecoder.decode(compressed);
  if (entry.method !== 8 || typeof DecompressionStream !== 'function') throw new Error('XLSX_COMPRESSION_UNSUPPORTED');
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return textDecoder.decode(await new Response(stream).arrayBuffer());
}

function xmlDocument(text, label) {
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error(`XLSX_XML_INVALID:${label}`);
  return xml;
}

function normalizePath(base, relative) {
  const segments = `${base}/${relative}`.split('/');
  const output = [];
  segments.forEach((segment) => {
    if (!segment || segment === '.') return;
    if (segment === '..') output.pop();
    else output.push(segment);
  });
  return output.join('/');
}

function columnIndex(reference) {
  const letters = String(reference || '').match(/^[A-Z]+/i)?.[0]?.toUpperCase() || '';
  return [...letters].reduce((value, character) => (value * 26) + character.charCodeAt(0) - 64, 0) - 1;
}

function uniqueHeaders(values) {
  const seen = new Map();
  return values.map((value, index) => {
    const base = clean(value) || `열 ${index + 1}`;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

function sheetRows(document, sharedStrings) {
  const matrix = [];
  [...document.getElementsByTagName('row')].forEach((rowNode) => {
    const rowNumber = Math.max(1, Number(rowNode.getAttribute('r') || matrix.length + 1));
    const row = matrix[rowNumber - 1] || [];
    [...rowNode.getElementsByTagName('c')].forEach((cellNode) => {
      const index = Math.max(0, columnIndex(cellNode.getAttribute('r')));
      const type = cellNode.getAttribute('t') || '';
      const valueNode = cellNode.getElementsByTagName('v')[0];
      const raw = valueNode?.textContent ?? '';
      let value = raw;
      if (type === 's') value = sharedStrings[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = [...cellNode.getElementsByTagName('t')].map((node) => node.textContent || '').join('');
      else if (type === 'b') value = raw === '1';
      else if (!type && raw !== '' && Number.isFinite(Number(raw))) value = Number(raw);
      row[index] = value;
    });
    matrix[rowNumber - 1] = row;
  });
  while (matrix.length && (!matrix[0] || matrix[0].every((value) => clean(value) === ''))) matrix.shift();
  const headerValues = matrix.shift() || [];
  const headers = uniqueHeaders(headerValues);
  return {
    headers,
    rows: matrix.filter((row) => row?.some((value) => clean(value) !== ''))
      .map((row) => Object.fromEntries(headers.map((header, index) => [header, row?.[index] ?? '']))),
  };
}

export async function parseXlsxBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  const entries = zipEntries(bytes);
  const workbookText = await readZipEntry(bytes, entries, 'xl/workbook.xml');
  const relationshipsText = await readZipEntry(bytes, entries, 'xl/_rels/workbook.xml.rels');
  if (!workbookText || !relationshipsText) throw new Error('XLSX_WORKBOOK_PARTS_MISSING');
  const workbook = xmlDocument(workbookText, 'workbook');
  const relationships = xmlDocument(relationshipsText, 'relationships');
  const relationshipMap = new Map([...relationships.getElementsByTagName('Relationship')]
    .map((node) => [node.getAttribute('Id'), node.getAttribute('Target')]));
  const firstSheet = workbook.getElementsByTagName('sheet')[0];
  if (!firstSheet) throw new Error('XLSX_SHEET_MISSING');
  const relationshipId = firstSheet.getAttribute('r:id') || firstSheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  const target = relationshipMap.get(relationshipId);
  if (!target) throw new Error('XLSX_SHEET_RELATIONSHIP_MISSING');
  const sharedText = await readZipEntry(bytes, entries, 'xl/sharedStrings.xml');
  const sharedStrings = sharedText
    ? [...xmlDocument(sharedText, 'sharedStrings').getElementsByTagName('si')]
      .map((node) => [...node.getElementsByTagName('t')].map((text) => text.textContent || '').join(''))
    : [];
  const sheetPath = normalizePath('xl', target);
  const sheetText = await readZipEntry(bytes, entries, sheetPath);
  if (!sheetText) throw new Error('XLSX_SHEET_PART_MISSING');
  return { sheetName: firstSheet.getAttribute('name') || 'Sheet1', ...sheetRows(xmlDocument(sheetText, 'worksheet'), sharedStrings) };
}

export async function parseCustomerFile(file) {
  const extension = String(file?.name || '').split('.').pop().toLowerCase();
  if (extension === 'csv' || extension === 'tsv') {
    const parsed = parseDelimited(await file.text(), extension === 'tsv' ? '\t' : ',');
    return { sheetName: extension.toUpperCase(), ...parsed };
  }
  if (extension !== 'xlsx') throw new Error('지원 형식은 .xlsx, .csv, .tsv입니다.');
  return parseXlsxBuffer(await file.arrayBuffer());
}
