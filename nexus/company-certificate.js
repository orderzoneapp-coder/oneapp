const MAX_CERTIFICATE_BYTES = 12 * 1024 * 1024;
const OCR_TIMEOUT_MS = 90000;
const FIELD_LABELS = Object.freeze({
  companyName: '상호', businessNumber: '사업자등록번호', representativeName: '대표자', openingDate: '개업연월일',
  taxationType: '과세유형', businessTypes: '업태', businessItems: '종목', address1: '사업장 소재지',
  taxOfficeName: '관할세무서', certificateIssueReason: '발급사유', certificateIssuedDate: '발급일',
  unitTaxationEnabled: '사업자단위과세', jointBusinessEnabled: '공동사업자', taxInvoiceEmail: '전자세금계산서 이메일'
});

export function detectCertificateFileType(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((value, index) => data[index] === value)) return 'image/png';
  if (data.length >= 5 && String.fromCharCode(...data.slice(0, 5)) === '%PDF-') return 'application/pdf';
  return '';
}

export function validateCertificateFile(file, bytes) {
  if (!file || !Number.isFinite(Number(file.size)) || file.size < 1 || file.size > MAX_CERTIFICATE_BYTES) throw new Error('CERTIFICATE_FILE_SIZE_INVALID');
  const detectedType = detectCertificateFileType(bytes);
  if (!detectedType) throw new Error('CERTIFICATE_FILE_TYPE_INVALID');
  const declared = String(file.type || '').toLowerCase();
  if (declared && declared !== detectedType && !(declared === 'image/jpg' && detectedType === 'image/jpeg')) throw new Error('CERTIFICATE_FILE_SIGNATURE_MISMATCH');
  return detectedType;
}

export function sanitizeCertificateText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\b\d{6}\s*[-–—]\s*[1-4]\d{6}\b/g, '[민감정보 제거]')
    .replace(/(생년월일|주민등록번호)\s*[:：]?\s*\d{6}(?:\s*[-–—]?\s*[1-4]?\d{0,6})?/g, '$1 [민감정보 제거]')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const cleanValue = value => String(value ?? '').replace(/^[\s:：|]+|[\s|]+$/g, '').trim();
const cleanBusinessNumber = value => {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  return digits.length === 10 ? digits : null;
};
const cleanDate = value => {
  const match = String(value ?? '').match(/(19|20)\d{2}\D{0,3}(1[0-2]|0?[1-9])\D{0,3}(3[01]|[12]\d|0?[1-9])/);
  if (!match) return null;
  const date = `${match[0].match(/(19|20)\d{2}/)[0]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  const parsed = new Date(date + 'T00:00:00.000Z');
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10) !== date ? null : date;
};
const splitList = value => {
  const result = String(value ?? '').split(/[,，·ㆍ]|\s{2,}/).map(cleanValue).filter(Boolean);
  return result.length ? [...new Set(result)] : null;
};

function lineAfterLabel(lines, labelPattern) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(labelPattern);
    if (!match) continue;
    const inline = cleanValue(line.slice((match.index || 0) + match[0].length));
    if (inline) return inline;
    const next = cleanValue(lines[index + 1]);
    if (next) return next;
  }
  return '';
}

export function parseBusinessCertificateText(rawText, overallConfidence = 0.65) {
  const text = sanitizeCertificateText(rawText);
  const lines = text.split(/\r?\n/).map(cleanValue).filter(Boolean);
  const joined = lines.join('\n');
  const businessMatch = joined.match(/(?:사업자\s*등록\s*번호|등록번호)\s*[:：]?\s*([0-9OIl|\s-]{10,20})/i)
    || joined.match(/\b(\d{3}\s*-?\s*\d{2}\s*-?\s*\d{5})\b/);
  const businessNumber = cleanBusinessNumber(businessMatch && businessMatch[1]);
  const companyName = lineAfterLabel(lines, /(?:법인명\s*\(?단체명\)?|상\s*호\s*\(?법인명\)?|상\s*호)\s*[:：]?/);
  const representativeName = lineAfterLabel(lines, /대\s*표\s*(?:자|자명)\s*[:：]?/).replace(/\s*(?:생년월일|주민등록번호)?\s*\[민감정보 제거\].*$/, '').trim();
  const openingDate = cleanDate(lineAfterLabel(lines, /개\s*업\s*(?:연\s*월\s*일|일\s*자)\s*[:：]?/));
  const address1 = lineAfterLabel(lines, /(?:사업장\s*소재지|사업장\s*주소|소\s*재\s*지)\s*[:：]?/);
  const businessTypes = splitList(lineAfterLabel(lines, /업\s*태\s*[:：]?/));
  const businessItems = splitList(lineAfterLabel(lines, /종\s*목\s*[:：]?/));
  const taxationType = lineAfterLabel(lines, /과\s*세\s*유\s*형\s*[:：]?/) || (/일반\s*과세자/.test(joined) ? '일반과세자' : /간이\s*과세자/.test(joined) ? '간이과세자' : '');
  const taxOfficeRaw = lineAfterLabel(lines, /(?:관할\s*세무서|세\s*무\s*서)\s*[:：]?/);
  const taxOfficeName = taxOfficeRaw || (joined.match(/([가-힣]{2,12}세무서)/)?.[1] || '');
  const issueReason = lineAfterLabel(lines, /발\s*급\s*사\s*유\s*[:：]?/);
  const issuedDate = cleanDate(lineAfterLabel(lines, /발\s*급\s*(?:일|일자)\s*[:：]?/) || lines.slice(-4).join(' '));
  const unitTaxationRaw = lineAfterLabel(lines, /사업자\s*단위\s*과세(?:\s*적용\s*여부)?\s*[:：]?/);
  const jointRaw = lineAfterLabel(lines, /공\s*동\s*사\s*업\s*자\s*[:：]?/);
  const emailRaw = lineAfterLabel(lines, /전자\s*세금\s*계산서(?:\s*전용)?\s*(?:e-?mail|이메일)\s*[:：]?/i);
  const extractedFields = {};
  const candidates = {
    companyName: companyName || null,
    businessNumber,
    representativeName: representativeName || null,
    openingDate,
    taxationType: taxationType || null,
    businessTypes,
    businessItems,
    address1: address1 || null,
    taxOfficeName: taxOfficeName || null,
    certificateIssueReason: issueReason || null,
    certificateIssuedDate: issuedDate,
    unitTaxationEnabled: /^(부|미적용|아니오|n)$/i.test(unitTaxationRaw) ? false : /^(여|적용|예|y)$/i.test(unitTaxationRaw) ? true : null,
    jointBusinessEnabled: /^(부|없음|아니오|n)$/i.test(jointRaw) ? false : /^(여|있음|예|y)$/i.test(jointRaw) ? true : null,
    taxInvoiceEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw : null
  };
  Object.entries(candidates).forEach(([field, value]) => { if (value !== null && value !== '' && (!Array.isArray(value) || value.length)) extractedFields[field] = value; });
  const documentSignals = [];
  if (/사업자\s*등록증|사업자등록증명/.test(joined)) documentSignals.push('BUSINESS_REGISTRATION_CERTIFICATE');
  if (businessNumber) documentSignals.push('BUSINESS_NUMBER');
  if (companyName) documentSignals.push('COMPANY_NAME');
  const base = Math.max(0, Math.min(1, Number(overallConfidence || 0) / (Number(overallConfidence) > 1 ? 100 : 1)));
  const fieldConfidence = {};
  const sourceLabels = {};
  Object.keys(extractedFields).forEach(field => {
    const structural = ['businessNumber', 'openingDate', 'certificateIssuedDate'].includes(field) ? 0.12 : 0;
    fieldConfidence[field] = Math.max(0.2, Math.min(0.99, base + structural));
    sourceLabels[field] = FIELD_LABELS[field] || field;
  });
  return { extractedFields, fieldConfidence, sourceLabels, documentSignals };
}

async function pdfCanvas(bytes) {
  const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
  const pdf = await pdfjs.getDocument({ data: bytes }).promise;
  if (pdf.numPages < 1 || pdf.numPages > 20) throw new Error('CERTIFICATE_PDF_PAGE_INVALID');
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}

async function imageCanvas(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, 2600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas;
}

function preprocessCanvas(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width; canvas.height = source.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < image.data.length; index += 4) {
    const gray = image.data[index] * .299 + image.data[index + 1] * .587 + image.data[index + 2] * .114;
    const contrast = Math.max(0, Math.min(255, (gray - 128) * 1.35 + 128));
    image.data[index] = image.data[index + 1] = image.data[index + 2] = contrast;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function withTimeout(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CERTIFICATE_OCR_TIMEOUT')), timeoutMs); })
  ]);
}

export async function recognizeBusinessCertificate(file, { Tesseract = window.Tesseract, onProgress = () => {} } = {}) {
  if (!Tesseract?.createWorker && !Tesseract?.recognize) throw new Error('CERTIFICATE_OCR_UNAVAILABLE');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = validateCertificateFile(file, bytes);
  const source = type === 'application/pdf' ? await pdfCanvas(bytes) : await imageCanvas(file);
  const canvas = preprocessCanvas(source);
  let worker;
  const job = (async () => {
    const logger = message => {
      if (message?.status) onProgress({ status: String(message.status), progress: Math.max(0, Math.min(1, Number(message.progress || 0))) });
    };
    let result;
    if (Tesseract.createWorker) {
      worker = await Tesseract.createWorker('kor+eng', Tesseract.OEM?.LSTM_ONLY ?? 1, { logger });
      await worker.setParameters?.({ tessedit_pageseg_mode: Tesseract.PSM?.AUTO ?? '3', preserve_interword_spaces: '1' });
      result = await worker.recognize(canvas);
    } else result = await Tesseract.recognize(canvas, 'kor+eng', { logger });
    const parsed = parseBusinessCertificateText(result?.data?.text || '', result?.data?.confidence || 0);
    if (!parsed.documentSignals.includes('BUSINESS_REGISTRATION_CERTIFICATE')) throw new Error('CERTIFICATE_DOCUMENT_INVALID');
    if (!parsed.extractedFields.businessNumber && !parsed.extractedFields.companyName) throw new Error('CERTIFICATE_REQUIRED_FIELDS_MISSING');
    return parsed;
  })();
  try { return await withTimeout(job, OCR_TIMEOUT_MS); }
  finally { try { await worker?.terminate?.(); } catch {} }
}

export const certificateFieldLabels = FIELD_LABELS;
