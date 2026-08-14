import {
  STORE,
  openOrderQDb,
  requestToPromise,
  transactionDone,
  newId,
  nowIso,
  normalizeText,
  getByKey
} from '../orderq-db.js?v=0.6.1';

function queueRow(entityType, entityId, payload) {
  const timestamp = nowIso();
  return {
    queueId: newId('SQ'),
    entityType,
    entityId,
    operation: 'UPSERT',
    revision: 1,
    baseRevision: 0,
    payload,
    status: 'PENDING',
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function rawFingerprint({ sourceType = '', sourceId = '', rawText = '' }) {
  let hash = 14695981039346656037n;
  const input = `${normalizeText(sourceType)}|${normalizeText(sourceId)}|${normalizeText(rawText)}`;
  for (const char of input) {
    hash ^= BigInt(char.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 1099511628211n);
  }
  return `RAW-${hash.toString(36).padStart(13, '0')}`;
}

export async function findParseResultBySourceMessageKey(sourceMessageKey) {
  if (!sourceMessageKey) return null;
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.PARSE_RESULTS, 'readonly');
  const result = await requestToPromise(tx.objectStore(STORE.PARSE_RESULTS).index('bySourceMessageKey').get(sourceMessageKey));
  await transactionDone(tx);
  return result || null;
}

export async function persistAnalysis(rawInput, analysisRows, { forceReanalyze = false } = {}) {
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.RAW_INPUTS, STORE.PARSE_RESULTS], 'readwrite');
  try {
    const rawStore = tx.objectStore(STORE.RAW_INPUTS);
    const parseStore = tx.objectStore(STORE.PARSE_RESULTS);
    const fingerprint = rawFingerprint(rawInput);
    let savedRaw = await requestToPromise(rawStore.index('byFingerprint').get(fingerprint));
    if (!savedRaw) {
      const timestamp = nowIso();
      savedRaw = {
        rawInputId: newId('RAW'),
        sourceType: rawInput.sourceType,
        sourceId: rawInput.sourceId,
        rawText: rawInput.rawText,
        fingerprint,
        inputTimestamp: rawInput.inputTimestamp || timestamp,
        deviceId: rawInput.deviceId || '',
        createdAt: timestamp,
        updatedAt: timestamp
      };
      rawStore.add(savedRaw);
    }

    const savedResults = [];
    for (const row of analysisRows) {
      const existing = await requestToPromise(parseStore.index('bySourceMessageKey').get(row.sourceMessageKey));
      if (existing) {
        if (forceReanalyze && !existing.orderId) {
          const refreshed = {
            ...existing,
            ...row,
            parseResultId: existing.parseResultId,
            rawInputId: existing.rawInputId,
            rawText: existing.rawText,
            createdAt: existing.createdAt,
            updatedAt: nowIso(),
            reanalyzedAt: nowIso()
          };
          parseStore.put(refreshed);
          savedResults.push({ ...refreshed, duplicate: true, reanalyzed: true });
        } else {
          savedResults.push({ ...existing, duplicate: true, reanalyzed: false });
        }
        continue;
      }
      const timestamp = nowIso();
      const next = {
        ...row,
        parseResultId: newId('PRS'),
        rawInputId: savedRaw.rawInputId,
        orderId: '',
        targetOrderId: '',
        createdAt: timestamp,
        updatedAt: timestamp
      };
      parseStore.add(next);
      savedResults.push({ ...next, duplicate: false, reanalyzed: false });
    }
    await transactionDone(tx);
    return { rawInput: savedRaw, results: savedResults };
  } catch (error) {
    try { tx.abort(); } catch (_) {}
    throw error;
  }
}

export async function updateParseResult(parseResultId, patch) {
  const db = await openOrderQDb();
  const tx = db.transaction(STORE.PARSE_RESULTS, 'readwrite');
  const store = tx.objectStore(STORE.PARSE_RESULTS);
  const existing = await requestToPromise(store.get(parseResultId));
  if (!existing) {
    try { tx.abort(); } catch (_) {}
    throw new Error('파싱결과를 찾을 수 없습니다.');
  }
  const next = { ...existing, ...patch, parseResultId, rawText: existing.rawText, updatedAt: nowIso() };
  store.put(next);
  await transactionDone(tx);
  return next;
}

export function getParseResult(parseResultId) {
  return getByKey(STORE.PARSE_RESULTS, parseResultId);
}

export async function recordProductMapping({ customerId = '', sourceId = '', rawText, productId, itemCode = '', itemName = '', specification = '', finalUnit = '' }) {
  if (!rawText || !productId) return null;
  const db = await openOrderQDb();
  const tx = db.transaction([STORE.PRODUCT_MAPPINGS, STORE.MAPPING_EVENTS, STORE.SYNC_QUEUE], 'readwrite');
  try {
    const mappingStore = tx.objectStore(STORE.PRODUCT_MAPPINGS);
    const normalizedText = normalizeText(rawText);
    const index = customerId ? mappingStore.index('byCustomerText') : mappingStore.index('bySourceText');
    const key = customerId ? [customerId, normalizedText] : [sourceId, normalizedText];
    const existing = await requestToPromise(index.get(key));
    const timestamp = nowIso();
    const mapping = {
      ...(existing || {}),
      mappingId: existing?.mappingId || newId('PM'),
      customerId,
      sourceId,
      rawText,
      normalizedText,
      productId,
      itemCode,
      itemName,
      specification,
      finalUnit,
      status: 'ACTIVE',
      confirmed: true,
      useCount: Number(existing?.useCount || 0) + 1,
      lastUsedAt: timestamp,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp
    };
    mappingStore.put(mapping);
    const event = {
      eventId: newId('ME'),
      eventType: existing ? 'PRODUCT_MAPPING_UPDATED' : 'PRODUCT_MAPPING_CONFIRMED',
      customerId,
      productId,
      sourceId,
      rawText,
      mappingId: mapping.mappingId,
      createdAt: timestamp
    };
    tx.objectStore(STORE.MAPPING_EVENTS).add(event);
    tx.objectStore(STORE.SYNC_QUEUE).add(queueRow('PRODUCT_MAPPING', mapping.mappingId, mapping));
    tx.objectStore(STORE.SYNC_QUEUE).add(queueRow('MAPPING_EVENT', event.eventId, event));
    await transactionDone(tx);
    return mapping;
  } catch (error) {
    try { tx.abort(); } catch (_) {}
    throw error;
  }
}
