const NUMBER_TOKEN = /[-+]?\d[\d,.]*/g;
const HEADER_WORDS = /(품목|품명|상품명|규격|수량|단가|금액|공급가액|합계|총계)/;
const TOTAL_WORDS = /(?:합계|총계|소계|(?:^|\s)계)(?=\s|\d|[:：]|$)/;

function numberValue(value) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/[원₩\s]/g, '')
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/,/g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeLine(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/(?:합|총|소)\s+계/g, value => value.replace(/\s+/g, ''))
    .replace(/(?<=\d)\s*,\s*(?=\d)/g, ',')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function tokensWithOffsets(line) {
  return [...line.matchAll(NUMBER_TOKEN)].map(match => ({
    raw: match[0],
    value: numberValue(match[0]),
    start: Number(match.index || 0),
    end: Number(match.index || 0) + match[0].length
  })).filter(token => token.value !== null);
}

function rowName(line, firstNumberAt) {
  return line.slice(0, firstNumberAt)
    .replace(/^\s*(?:No\.?|번호)?\s*\d+\s*[.)-]?\s*/i, '')
    .replace(/^[|:;·•\-\s]+|[|:;·•\-\s]+$/g, '')
    .trim();
}

function parseTsv(tsv) {
  const groups = new Map();
  String(tsv || '').split(/\r?\n/).forEach((raw, index) => {
    if (!raw.trim() || index === 0 && /^level\t/i.test(raw)) return;
    const cells = raw.split('\t');
    if (cells.length < 12 || Number(cells[0]) !== 5) return;
    const text = normalizeLine(cells.slice(11).join('\t'));
    if (!text) return;
    const word = {
      text,
      left: Number(cells[6]) || 0,
      top: Number(cells[7]) || 0,
      width: Number(cells[8]) || 0,
      height: Number(cells[9]) || 0,
      confidence: Number(cells[10])
    };
    const key = cells.slice(1, 5).join(':');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(word);
  });
  return [...groups.values()].map(words => {
    words.sort((left, right) => left.left - right.left);
    const confidences = words.map(word => word.confidence).filter(Number.isFinite);
    return {
      text: normalizeLine(words.map(word => word.text).join(' ')),
      confidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
      bbox: {
        left: Math.min(...words.map(word => word.left)),
        top: Math.min(...words.map(word => word.top)),
        right: Math.max(...words.map(word => word.left + word.width)),
        bottom: Math.max(...words.map(word => word.top + word.height))
      },
      words
    };
  }).sort((left, right) => left.bbox.top - right.bbox.top || left.bbox.left - right.bbox.left);
}

function textLines(text) {
  return String(text || '').replace(/\r/g, '').split('\n')
    .map(value => ({ text: normalizeLine(value), confidence: null, bbox: null, words: [] }))
    .filter(line => line.text);
}

function parseTotal(line) {
  if (!TOTAL_WORDS.test(line.text)) return null;
  const numbers = tokensWithOffsets(line.text);
  if (numbers.length < 2) return null;
  return {
    quantity: numbers.at(-2).value,
    amount: numbers.at(-1).value,
    rawText: line.text,
    confidence: line.confidence,
    bbox: line.bbox
  };
}

function parseProductRow(line, sourceLineNo) {
  if (!line.text || HEADER_WORDS.test(line.text) || TOTAL_WORDS.test(line.text)) return null;
  const numbers = tokensWithOffsets(line.text);
  if (numbers.length < 3) return null;
  const quantityToken = numbers.at(-3);
  const priceToken = numbers.at(-2);
  const amountToken = numbers.at(-1);
  const itemName = rowName(line.text, quantityToken.start);
  if (!itemName || !/[가-힣A-Za-z]/.test(itemName)) return null;
  const quantity = quantityToken.value;
  const unitPrice = priceToken.value;
  const amount = amountToken.value;
  if (![quantity, unitPrice, amount].every(value => Number.isFinite(value) && value >= 0)) return null;
  const expectedAmount = quantity * unitPrice;
  return {
    sourceLineNo,
    rawText: line.text,
    itemName,
    quantity,
    unitPrice,
    amount,
    expectedAmount,
    arithmeticValid: expectedAmount === amount,
    confidence: line.confidence,
    bbox: line.bbox
  };
}

export function analyzeOcrDocument({ text = '', tsv = '', confidence = null, variant = 'original' } = {}) {
  const coordinateLines = parseTsv(tsv);
  const lines = coordinateLines.length ? coordinateLines : textLines(text);
  const rows = lines.map((line, index) => parseProductRow(line, index + 1)).filter(Boolean);
  const validRows = rows.filter(row => row.arithmeticValid);
  const invalidRows = rows.filter(row => !row.arithmeticValid).map(row => ({ ...row, reason: 'AMOUNT_MISMATCH' }));
  const detectedTotals = lines.map(parseTotal).filter(Boolean);
  const detectedTotal = detectedTotals.at(-1) || null;
  const calculatedTotal = validRows.reduce((summary, row) => ({
    quantity: summary.quantity + row.quantity,
    amount: summary.amount + row.amount
  }), { quantity: 0, amount: 0 });
  const totalValid = Boolean(detectedTotal
    && detectedTotal.quantity === calculatedTotal.quantity
    && detectedTotal.amount === calculatedTotal.amount);
  const lineConfidences = rows.map(row => row.confidence).filter(Number.isFinite);
  const overallConfidence = Number.isFinite(Number(confidence))
    ? Number(confidence)
    : (lineConfidences.length ? lineConfidences.reduce((sum, value) => sum + value, 0) / lineConfidences.length : 100);
  const confidenceValid = overallConfidence >= 45 && validRows.every(row => !Number.isFinite(row.confidence) || row.confidence >= 35);
  const status = validRows.length && !invalidRows.length && totalValid && confidenceValid ? 'VERIFIED' : 'REVIEW_REQUIRED';
  const warnings = [];
  if (!rows.length) warnings.push('PRODUCT_ROWS_NOT_FOUND');
  if (invalidRows.length) warnings.push('AMOUNT_MISMATCH');
  if (!detectedTotal) warnings.push('TOTAL_NOT_FOUND');
  else if (!totalValid) warnings.push('TOTAL_MISMATCH');
  if (!confidenceValid) warnings.push('LOW_CONFIDENCE');
  const score = (status === 'VERIFIED' ? 10000 : 0)
    + validRows.length * 120
    - invalidRows.length * 180
    + (totalValid ? 500 : 0)
    + Math.max(0, Math.min(100, overallConfidence));
  return {
    status,
    variant,
    rawText: String(text || '').replace(/\r/g, ''),
    rows,
    validRows,
    invalidRows,
    detectedTotal,
    calculatedTotal,
    totalValid,
    confidence: overallConfidence,
    confidenceValid,
    warnings,
    score,
    coordinateLines
  };
}

export function selectBestOcrAnalysis(analyses = []) {
  return [...analyses].filter(Boolean).sort((left, right) => right.score - left.score)[0] || analyzeOcrDocument();
}

export function verifiedRowsToParserLines(analysis, batchId = 'OCR') {
  if (analysis?.status !== 'VERIFIED') return [];
  return analysis.validRows.map((row, index) => ({
    rawText: row.rawText,
    productText: row.itemName,
    itemName: row.itemName,
    quantity: row.quantity,
    unit: '',
    unitPrice: row.unitPrice,
    sourceLineNo: row.sourceLineNo,
    sourceLineKey: `${batchId}:OCR:${row.sourceLineNo || index + 1}`,
    matchStatus: 'UNRESOLVED',
    ocrAmount: row.amount,
    ocrVerified: true
  }));
}

function percentile(histogram, count, ratio) {
  let seen = 0;
  const target = count * ratio;
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen >= target) return value;
  }
  return 255;
}

function enhanceCanvas(sourceCanvas, { binary = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(sourceCanvas, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const histogram = new Uint32Array(256);
  const grayscale = new Uint8Array(canvas.width * canvas.height);
  for (let pixel = 0, index = 0; pixel < image.data.length; pixel += 4, index += 1) {
    const value = Math.round(image.data[pixel] * .299 + image.data[pixel + 1] * .587 + image.data[pixel + 2] * .114);
    grayscale[index] = value;
    histogram[value] += 1;
  }
  const low = percentile(histogram, grayscale.length, .03);
  const high = Math.max(low + 24, percentile(histogram, grayscale.length, .97));
  const threshold = Math.max(110, Math.min(210, (low + high) / 2));
  for (let pixel = 0, index = 0; pixel < image.data.length; pixel += 4, index += 1) {
    const stretched = Math.max(0, Math.min(255, Math.round((grayscale[index] - low) * 255 / (high - low))));
    const value = binary ? (stretched >= threshold ? 255 : 0) : stretched;
    image.data[pixel] = value;
    image.data[pixel + 1] = value;
    image.data[pixel + 2] = value;
    image.data[pixel + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function documentBounds(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const step = Math.max(1, Math.round(Math.max(canvas.width, canvas.height) / 900));
  const rows = new Uint32Array(Math.ceil(canvas.height / step));
  const columns = new Uint32Array(Math.ceil(canvas.width / step));
  const sampleColumns = Math.ceil(canvas.width / step);
  const sampleRows = Math.ceil(canvas.height / step);
  for (let y = 0, row = 0; y < canvas.height; y += step, row += 1) {
    for (let x = 0, column = 0; x < canvas.width; x += step, column += 1) {
      const pixel = (y * canvas.width + x) * 4;
      const red = image.data[pixel];
      const green = image.data[pixel + 1];
      const blue = image.data[pixel + 2];
      const lightness = red * .299 + green * .587 + blue * .114;
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      if (lightness >= 155 && chroma <= 85) {
        rows[row] += 1;
        columns[column] += 1;
      }
    }
  }
  const activeRows = [...rows].map((count, index) => count / sampleColumns >= .32 ? index : -1).filter(index => index >= 0);
  const activeColumns = [...columns].map((count, index) => count / sampleRows >= .32 ? index : -1).filter(index => index >= 0);
  if (!activeRows.length || !activeColumns.length) return { left: 0, top: 0, width: canvas.width, height: canvas.height };
  const paddingX = Math.round(canvas.width * .015);
  const paddingY = Math.round(canvas.height * .015);
  const left = Math.max(0, activeColumns[0] * step - paddingX);
  const top = Math.max(0, activeRows[0] * step - paddingY);
  const right = Math.min(canvas.width, (activeColumns.at(-1) + 1) * step + paddingX);
  const bottom = Math.min(canvas.height, (activeRows.at(-1) + 1) * step + paddingY);
  const areaRatio = (right - left) * (bottom - top) / (canvas.width * canvas.height);
  return areaRatio >= .3
    ? { left, top, width: right - left, height: bottom - top }
    : { left: 0, top: 0, width: canvas.width, height: canvas.height };
}

function cropCanvas(source, bounds) {
  if (!bounds.left && !bounds.top && bounds.width === source.width && bounds.height === source.height) return source;
  const canvas = document.createElement('canvas');
  canvas.width = bounds.width;
  canvas.height = bounds.height;
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, bounds.left, bounds.top, bounds.width, bounds.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function rotatedCanvas(source, degrees, expand = false) {
  if (!degrees) return source;
  const radians = degrees * Math.PI / 180;
  const width = expand
    ? Math.ceil(Math.abs(source.width * Math.cos(radians)) + Math.abs(source.height * Math.sin(radians)))
    : source.width;
  const height = expand
    ? Math.ceil(Math.abs(source.height * Math.cos(radians)) + Math.abs(source.width * Math.sin(radians)))
    : source.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.translate(width / 2, height / 2);
  context.rotate(radians);
  context.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
}

function projectionScore(canvas) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const rows = new Uint32Array(canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    let darkness = 0;
    for (let x = 0; x < canvas.width; x += 2) {
      const pixel = (y * canvas.width + x) * 4;
      if (data[pixel] * .299 + data[pixel + 1] * .587 + data[pixel + 2] * .114 < 165) darkness += 1;
    }
    rows[y] = darkness;
  }
  let score = 0;
  for (let index = 1; index < rows.length; index += 1) score += (rows[index] - rows[index - 1]) ** 2;
  return score;
}

function deskewCanvas(source) {
  const sample = document.createElement('canvas');
  const scale = Math.min(1, 700 / source.width);
  sample.width = Math.max(1, Math.round(source.width * scale));
  sample.height = Math.max(1, Math.round(source.height * scale));
  sample.getContext('2d', { alpha: false }).drawImage(source, 0, 0, sample.width, sample.height);
  const baseline = projectionScore(sample);
  let bestAngle = 0;
  let bestScore = baseline;
  for (let angle = -3; angle <= 3; angle += 1) {
    if (!angle) continue;
    const score = projectionScore(rotatedCanvas(sample, angle));
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }
  return bestScore > baseline * 1.04 ? rotatedCanvas(source, bestAngle, true) : source;
}

async function imageSource(file) {
  if (typeof createImageBitmap === 'function') return createImageBitmap(file, { imageOrientation: 'from-image' });
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function buildOcrImageVariants(file) {
  const source = await imageSource(file);
  const sourceWidth = Number(source.width || source.naturalWidth || 0);
  const sourceHeight = Number(source.height || source.naturalHeight || 0);
  if (!sourceWidth || !sourceHeight) throw new Error('이미지 크기를 확인하지 못했습니다.');
  const longEdge = Math.max(sourceWidth, sourceHeight);
  const scale = Math.min(3, Math.max(1, 2200 / longEdge));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sourceWidth * scale);
  canvas.height = Math.round(sourceHeight * scale);
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  const documentCanvas = deskewCanvas(cropCanvas(canvas, documentBounds(canvas)));
  return [
    { id: 'document-contrast', label: '문서영역·기울기·명암 보정', canvas: enhanceCanvas(documentCanvas) },
    { id: 'document-binary', label: '문서영역 고대비 표 보정', canvas: enhanceCanvas(documentCanvas, { binary: true }) }
  ];
}

export function tableRectangleFromAnalysis(analysis, width, height) {
  const boxes = analysis?.coordinateLines?.filter(line => line.bbox && (parseProductRow(line, 0) || parseTotal(line))) || [];
  if (!boxes.length) return null;
  const paddingX = Math.round(width * .025);
  const paddingY = Math.round(height * .025);
  const left = Math.max(0, Math.min(...boxes.map(line => line.bbox.left)) - paddingX);
  const top = Math.max(0, Math.min(...boxes.map(line => line.bbox.top)) - paddingY);
  const right = Math.min(width, Math.max(...boxes.map(line => line.bbox.right)) + paddingX);
  const bottom = Math.min(height, Math.max(...boxes.map(line => line.bbox.bottom)) + paddingY);
  if (right - left < width * .25 || bottom - top < height * .12) return null;
  return { left, top, width: right - left, height: bottom - top };
}

export async function recognizeOcrDocument(file, { Tesseract, onProgress = () => {} } = {}) {
  if (!Tesseract?.createWorker && !Tesseract?.recognize) throw new Error('사진 OCR 모듈을 불러오지 못했습니다.');
  const variants = await buildOcrImageVariants(file);
  const analyses = [];
  let worker = null;
  const logger = progress => onProgress(progress);
  try {
    if (Tesseract.createWorker) {
      worker = await Tesseract.createWorker('kor+eng', Tesseract.OEM?.LSTM_ONLY ?? 1, { logger });
      await worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM?.AUTO ?? '3',
        preserve_interword_spaces: '1',
        user_defined_dpi: '300'
      });
    }
    for (let index = 0; index < variants.length; index += 1) {
      const variant = variants[index];
      onProgress({ status: 'preprocessing', progress: index / variants.length, variant: variant.label });
      const result = worker
        ? await worker.recognize(variant.canvas, {}, { text: true, tsv: true, blocks: true })
        : await Tesseract.recognize(variant.canvas, 'kor+eng', { logger });
      let analysis = analyzeOcrDocument({
        text: result?.data?.text,
        tsv: result?.data?.tsv,
        confidence: result?.data?.confidence,
        variant: variant.id
      });
      analyses.push(analysis);
      if (analysis.status === 'VERIFIED') break;
      const rectangle = tableRectangleFromAnalysis(analysis, variant.canvas.width, variant.canvas.height);
      if (worker && rectangle) {
        onProgress({ status: 'table-region', progress: (index + .5) / variants.length, variant: variant.label });
        const tableResult = await worker.recognize(variant.canvas, { rectangle }, { text: true, tsv: true, blocks: true });
        analysis = analyzeOcrDocument({
          text: tableResult?.data?.text,
          tsv: tableResult?.data?.tsv,
          confidence: tableResult?.data?.confidence,
          variant: `${variant.id}-table`
        });
        analyses.push(analysis);
        if (analysis.status === 'VERIFIED') break;
      }
    }
  } finally {
    await worker?.terminate?.();
  }
  const best = selectBestOcrAnalysis(analyses);
  return {
    ...best,
    rawText: analyses[0]?.rawText || best.rawText,
    analysisText: best.rawText,
    attempts: analyses.map(analysis => ({
    variant: analysis.variant,
    status: analysis.status,
    rowCount: analysis.rows.length,
    validRowCount: analysis.validRows.length,
    confidence: analysis.confidence,
    warnings: analysis.warnings
    }))
  };
}
