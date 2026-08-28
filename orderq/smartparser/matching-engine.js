export function matchParsedLine(parsedLine, candidates = []) {
  if (parsedLine.excluded) return { ...parsedLine, candidateProducts: candidates, matchStatus: 'EXCLUDED', matchSource: parsedLine.reason || 'EXCLUDED' };
  const best = candidates[0] || null;
  const autoMatched = best && best.score >= 0.94;
  if (!autoMatched) {
    return {
      ...parsedLine,
      candidateProducts: candidates,
      matchStatus: 'MATCH_FAILED',
      matchSource: best ? 'CANDIDATE_REVIEW_REQUIRED' : 'NO_CANDIDATE',
      confirmedProductId: '',
      itemCode: '',
      itemName: ''
    };
  }
  return {
    ...parsedLine,
    candidateProducts: candidates,
    matchStatus: 'MATCHED',
    matchSource: best.source,
    confirmedProductId: best.productId,
    productId: best.productId,
    itemCode: best.itemCode,
    itemName: best.itemName,
    specification: parsedLine.specText || best.specification || '',
    finalUnit: best.finalUnit || parsedLine.rawUnit || ''
  };
}

