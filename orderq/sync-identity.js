function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function stableChecksum(value) {
  const text = canonical(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createSyncIdentity({ entityType, entityId, operation = 'UPSERT', revision = 0, payload }, newId, previous = null) {
  const operationId = previous?.operationId || newId('OP');
  const mutationId = newId('MU');
  const checksum = stableChecksum({ entityType, entityId, operation, revision, payload });
  return {
    operationId,
    mutationId,
    parentMutationId: previous?.mutationId || '',
    checksum,
    idempotencyKey: `${entityType}:${entityId}:${revision}:${checksum}`
  };
}

export function newRequestId(newId) {
  return newId('RQ');
}
