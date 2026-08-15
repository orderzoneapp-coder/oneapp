import { PRODUCT_LINE_CONTEXT, applyProductSelection } from '../product-line-common.js?v=0.8.0';

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
  return applyProductSelection(PRODUCT_LINE_CONTEXT.SMARTPARSER, {
    ...parsedLine,
    candidateProducts: candidates,
  }, best, {
    matchSource: best.source,
    specification: parsedLine.specText || best.specification || '',
    rawUnit: parsedLine.rawUnit || ''
  });
}

