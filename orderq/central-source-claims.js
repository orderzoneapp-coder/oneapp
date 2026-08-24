const text = value => String(value ?? '').normalize('NFC').trim();
const OCCURRENCE = /^(SALE:(?:SOURCE|TX|DISPATCH):)/;
const RESOURCE = /^(SALE:(?:ALLOCATION|REVERSAL):)/;

export function deriveSaleSourceClaims(command = {}) {
  const type = text(command.commandType).toUpperCase();
  const intent = command.intent || {};
  const lines = Array.isArray(intent.lines) ? intent.lines : Array.isArray(intent) ? intent : [];
  const keys = [];
  const official = text(intent.commandContract).toUpperCase() === 'VOUCHER_CORE_V1';
  if (official && ['POST_SALE','CORRECT_SALE','REVERSE_SALE'].includes(type)) {
    if (text(intent.sourceDocumentKey)) keys.push(`SALE:SOURCE:${text(intent.sourceDocumentKey)}`);
    if (text(intent.originSystem) && text(intent.originTransactionId)) keys.push(`SALE:TX:${text(intent.originSystem).toUpperCase()}:${text(intent.originTransactionId)}:${Number(intent.sourceVoucherIndex || 1)}`);
    lines.forEach(line => {
      if (text(line.sourceDispatchId) && text(line.sourceDispatchLineId)) keys.push(`SALE:DISPATCH:${text(line.sourceDispatchId)}:${text(line.sourceDispatchLineId)}`);
      (line.reversalSourceAllocations || []).forEach(ref => { if (text(ref.allocationEventId)) keys.push(`SALE:ALLOCATION:${text(ref.allocationEventId)}`); });
      (line.restorationSourceReversals || []).forEach(ref => { if (text(ref.reversalEventId)) keys.push(`SALE:REVERSAL:${text(ref.reversalEventId)}`); });
    });
  } else if (type === 'CONFIRM_DISPATCH') {
    lines.forEach(line => { if (text(line.dispatchLineId)) keys.push(`SALE:DISPATCH:${text(command.aggregateId)}:${text(line.dispatchLineId)}`); });
  }
  return [...new Set(keys)].sort();
}

export function ownerDescriptor(command = {}) {
  const intent = command.intent || {};
  return {
    ownerCommandId:text(command.idempotencyKey),
    ownerContract:text(intent.commandContract).toUpperCase() === 'VOUCHER_CORE_V1' ? `${text(intent.commandContract)}:${text(intent.contractKind || 'SALE_STAGE4_V1')}` : 'LEGACY_DISPATCH',
    ownerAggregateId:text(command.aggregateId)
  };
}

export function prepareSourceClaims(state, command, lease) {
  state.sourceClaims ||= {};
  const claims = deriveSaleSourceClaims(command); const owner = ownerDescriptor(command);
  for (const key of claims) {
    const prior = state.sourceClaims[key];
    if (!prior || prior.status === 'RELEASED' || prior.status === 'EXPIRED' || prior.status === 'ABORTED') continue;
    const sameLineage = prior.ownerContract === owner.ownerContract && prior.ownerAggregateId === owner.ownerAggregateId;
    const sameCommand = prior.ownerCommandId === owner.ownerCommandId && prior.fingerprint === lease.fingerprint;
    if (prior.status === 'COMMITTED' && OCCURRENCE.test(key) && sameLineage) continue;
    if (prior.status === 'PREPARED' && sameCommand) continue;
    throw new Error(`ORDERQ_CENTRAL_SOURCE_CLAIM_CONFLICT:${key}`);
  }
  const prepared = [];
  for (const key of claims) {
    const prior = state.sourceClaims[key];
    if (prior?.status === 'COMMITTED' && OCCURRENCE.test(key)) { prepared.push(prior); continue; }
    const row = { claimKey:key, ...owner, fingerprint:lease.fingerprint, leaseToken:lease.leaseToken, leaseExpiresAt:lease.leaseExpiresAt,
      status:'PREPARED', preparedAt:lease.preparedAt, committedAt:'', releasedAt:'', releaseReason:'' };
    state.sourceClaims[key] = row; prepared.push(row);
  }
  return prepared;
}

export function verifySourceClaims(state, command) {
  const owner = ownerDescriptor(command);
  for (const key of deriveSaleSourceClaims(command)) {
    const row = state.sourceClaims?.[key];
    const lineage = row && row.ownerContract === owner.ownerContract && row.ownerAggregateId === owner.ownerAggregateId;
    if (!row || (!lineage && row.ownerCommandId !== owner.ownerCommandId)
      || (row.status === 'PREPARED' && (row.leaseToken !== command.leaseToken || row.fingerprint !== command.fingerprint))) {
      throw new Error(`ORDERQ_CENTRAL_SOURCE_CLAIM_INVALID:${key}`);
    }
  }
}

export function commitSourceClaims(state, command, at) {
  const owner = ownerDescriptor(command);
  deriveSaleSourceClaims(command).forEach(key => {
    const row = state.sourceClaims[key];
    if (OCCURRENCE.test(key) && row.status !== 'COMMITTED') state.sourceClaims[key] = { ...row, ...owner, status:'COMMITTED', committedAt:at };
    else if (RESOURCE.test(key)) state.sourceClaims[key] = { ...row, status:'RELEASED', releasedAt:at, releaseReason:'COMMITTED' };
  });
}

export function releaseSourceClaims(state, command, at, reason) {
  deriveSaleSourceClaims(command).forEach(key => {
    const row = state.sourceClaims?.[key];
    if (row?.status === 'PREPARED' && row.ownerCommandId === text(command.idempotencyKey)) state.sourceClaims[key] = { ...row, status:reason === 'EXPIRED' ? 'EXPIRED' : 'RELEASED', releasedAt:at, releaseReason:reason };
  });
}
