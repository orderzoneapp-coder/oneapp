export const MAPPING_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  INACTIVE: 'INACTIVE'
});

function evidenceSupportsMapping(evidence, mapping) {
  if (!evidence || evidence.active === false) return false;
  if (evidence.status !== 'ADMIN_CONFIRMED') return false;
  const mappingCode = String(mapping.itemCode || mapping.productCode || '').trim();
  const evidenceCode = String(evidence.productCode || '').trim();
  return Boolean(mappingCode && evidenceCode && mappingCode === evidenceCode);
}

export function reconcileEvidenceMappings({ mappings = [], evidence = [], timestamp = new Date().toISOString() } = {}) {
  const evidenceById = new Map(evidence.map(row => [row.parserEvidenceId, row]));
  const updates = [];
  mappings.forEach(mapping => {
    if (mapping.evidenceType !== 'ADMIN_CONFIRMED' || !mapping.evidenceId) return;
    if ([MAPPING_STATUS.INACTIVE, MAPPING_STATUS.REVIEW_REQUIRED].includes(mapping.status)) return;
    const currentEvidence = evidenceById.get(mapping.evidenceId);
    if (evidenceSupportsMapping(currentEvidence, mapping)) return;
    updates.push({
      ...mapping,
      status: MAPPING_STATUS.REVIEW_REQUIRED,
      reviewReason: currentEvidence ? 'EVIDENCE_CONFLICT_OR_PRODUCT_CHANGED' : 'EVIDENCE_REMOVED_OR_ROLLED_BACK',
      reviewRequiredAt: timestamp,
      updatedAt: timestamp
    });
  });
  return updates;
}

export function deactivateEvidenceMapping(mapping = {}, timestamp = new Date().toISOString(), actor = 'administrator') {
  return {
    ...mapping,
    status: MAPPING_STATUS.INACTIVE,
    deactivatedAt: timestamp,
    deactivatedBy: actor,
    updatedAt: timestamp
  };
}
