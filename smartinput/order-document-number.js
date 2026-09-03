export const ORDER_DOCUMENT_NUMBER_HEADER = '\uC77C\uC790-No.';

const text = value => String(value ?? '');

function dateResult(value) {
  const match = /^(\d{4})([./-])(\d{2})\2(\d{2})$/.exec(value);
  if (!match) return { valid: false, code: 'ORDER_DOCUMENT_NO_DATE_FORMAT_INVALID' };
  const year = Number(match[1]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) {
    return { valid: false, code: 'ORDER_DOCUMENT_NO_DATE_INVALID' };
  }
  return {
    valid: true,
    date: `${match[1]}-${match[3]}-${match[4]}`
  };
}

export function parseOrderDocumentNumber(value) {
  const originalValue = text(value);
  const boundary = originalValue.lastIndexOf('-');
  if (boundary < 0) {
    return {
      valid: false,
      originalValue,
      code: 'ORDER_DOCUMENT_NO_FORMAT_INVALID',
      message: '\uC77C\uC790-No.\uB294 YYYY/MM/DD-N, YYYY.MM.DD-N, YYYY-MM-DD-N \uD615\uC2DD\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.'
    };
  }
  const datePart = originalValue.slice(0, boundary);
  const numberPart = originalValue.slice(boundary + 1);
  if (!numberPart) {
    return {
      valid: false,
      originalValue,
      code: 'ORDER_DOCUMENT_NO_NUMBER_REQUIRED',
      message: '\uC77C\uC790-No. \uB05D\uC758 \uBC88\uD638\uB97C \uC785\uB825\uD558\uC138\uC694.'
    };
  }
  if (!/^\d+$/.test(numberPart)) {
    return {
      valid: false,
      originalValue,
      code: 'ORDER_DOCUMENT_NO_NUMBER_INVALID',
      message: '\uC77C\uC790-No. \uB05D\uC758 \uBC88\uD638\uB294 \uC22B\uC790\uB85C\uB9CC \uC785\uB825\uD558\uC138\uC694.'
    };
  }
  const parsedDate = dateResult(datePart);
  if (!parsedDate.valid) {
    return {
      valid: false,
      originalValue,
      code: parsedDate.code,
      message: parsedDate.code === 'ORDER_DOCUMENT_NO_DATE_INVALID'
        ? '\uC77C\uC790-No.\uC758 \uB0A0\uC9DC\uAC00 \uC2E4\uC81C \uB2EC\uB825\uC5D0 \uC5C6\uB294 \uB0A0\uC9DC\uC785\uB2C8\uB2E4.'
        : '\uC77C\uC790-No.\uB294 YYYY/MM/DD-N, YYYY.MM.DD-N, YYYY-MM-DD-N \uD615\uC2DD\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.'
    };
  }
  return {
    valid: true,
    originalValue,
    date: parsedDate.date
  };
}

function projectionField(target) {
  return text(target?.projectionFieldId || target?.id);
}

function activeMapping(session, targetDefinitions, projectionFieldId) {
  const targets = new Map((targetDefinitions || []).map(target => [target.id, target]));
  return (session?.mappings || []).find(mapping => {
    if (!['MAPPED', 'RECOMMENDED'].includes(mapping?.state)) return false;
    const target = targets.get(mapping.targetFieldId);
    return projectionField(target) === projectionFieldId;
  });
}

function normalizeSeparateDate(value) {
  const originalValue = text(value);
  if (!originalValue) return { valid: true, empty: true, date: '' };
  const parsed = dateResult(originalValue);
  if (!parsed.valid) return { valid: false, originalValue, code: parsed.code };
  return { valid: true, empty: false, originalValue, date: parsed.date };
}

function derivedFieldValue(fieldId, date, sourceFieldValue) {
  const sourceEvidence = sourceFieldValue?.evidence;
  return {
    fieldId,
    sourceDisplayValue: text(sourceFieldValue?.sourceDisplayValue),
    currentDisplayValue: date,
    parsedValue: date,
    edited: false,
    evidence: {
      ...(sourceEvidence || {}),
      derivation: 'ORDER_DOCUMENT_NUMBER_DATE',
      sourceHeader: ORDER_DOCUMENT_NUMBER_HEADER,
      sourceFieldId: text(sourceFieldValue?.fieldId)
    }
  };
}

function separateDateError(label, parsed, derivedDate) {
  if (!parsed.valid) return `${label}\uC758 \uB0A0\uC9DC \uD615\uC2DD\uC744 \uD655\uC778\uD558\uC138\uC694.`;
  if (!parsed.empty && parsed.date !== derivedDate) {
    return `\uBCC4\uB3C4 ${label} ${parsed.originalValue}\uC774(\uAC00) \uC77C\uC790-No.\uC5D0\uC11C \uD30C\uC0DD\uD55C ${derivedDate}\uC640 \uB2E4\uB985\uB2C8\uB2E4.`;
  }
  return '';
}

export function applyOrderDocumentNumberDerivation({
  rows = [],
  session,
  targetDefinitions = []
} = {}) {
  if (text(session?.voucherMode).toLowerCase() !== 'order') return rows;
  const documentMapping = activeMapping(session, targetDefinitions, 'rowVoucherNo');
  if (!documentMapping || documentMapping.sourceHeader !== ORDER_DOCUMENT_NUMBER_HEADER) return rows;

  const dateTargets = ['rowVoucherDate', 'rowDeliveryDate'].map(projectionFieldId => ({
    projectionFieldId,
    target: (targetDefinitions || []).find(target => projectionField(target) === projectionFieldId),
    mapping: activeMapping(session, targetDefinitions, projectionFieldId)
  }));

  return (rows || []).map(row => {
    const sourceFieldValue = row?.fieldValues?.[documentMapping.targetFieldId];
    const parsed = parseOrderDocumentNumber(sourceFieldValue?.currentDisplayValue ?? row?.rowVoucherNo);
    const next = {
      ...row,
      rowVoucherNo: parsed.originalValue,
      fieldValues: { ...(row?.fieldValues || {}) }
    };
    delete next.orderDocumentNoError;
    delete next.orderDocumentNoErrorCode;

    if (!parsed.valid) {
      next.orderDocumentNoError = parsed.message;
      next.orderDocumentNoErrorCode = parsed.code;
      return next;
    }

    for (const { projectionFieldId, target, mapping } of dateTargets) {
      const label = projectionFieldId === 'rowVoucherDate' ? '\uC8FC\uBB38\uC77C\uC790' : '\uB0A9\uAE30\uC77C\uC790';
      const separateValue = mapping
        ? (next.fieldValues?.[mapping.targetFieldId]?.currentDisplayValue ?? next[projectionFieldId])
        : next[projectionFieldId];
      const separateDate = normalizeSeparateDate(separateValue);
      const error = separateDateError(label, separateDate, parsed.date);
      if (error) {
        next.orderDocumentNoError = error;
        next.orderDocumentNoErrorCode = separateDate.valid
          ? 'ORDER_DOCUMENT_NO_DATE_CONFLICT'
          : 'ORDER_DOCUMENT_NO_SEPARATE_DATE_INVALID';
        return next;
      }
      next[projectionFieldId] = parsed.date;
      if (!mapping && target?.id) {
        next.fieldValues[target.id] = derivedFieldValue(target.id, parsed.date, sourceFieldValue);
      } else if (mapping?.targetFieldId) {
        const fieldValue = next.fieldValues[mapping.targetFieldId];
        next.fieldValues[mapping.targetFieldId] = {
          ...fieldValue,
          parsedValue: parsed.date
        };
      }
    }
    return next;
  });
}
