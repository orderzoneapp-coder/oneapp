import { buildAutomaticSourceDocumentKey, buildSourceLineKey } from './intake-identity.js?v=0.11.0';

export async function adaptAnalysisToOrderDocument({ analysis, intakeSession, sourcePart }) {
  const orders = (analysis.results || []).filter(result => ['ORDER', 'ORDER_UPDATE'].includes(result.eventType));
  if (orders.length > 1) throw new Error('ORDERQ_INTAKE_MULTIPLE_DOCUMENTS_REQUIRES_STAGE4');
  if (orders.length !== 1) throw new Error('ORDERQ_INTAKE_REVIEW_INCOMPLETE');
  const parsed = orders[0];
  const sourceDocumentKey = await buildAutomaticSourceDocumentKey({
    sourceOccurrenceKey: intakeSession.sourceOccurrenceKey,
    documentType: 'ORDER',
    stableSegmentIdentity: parsed.sourceMessageKey
  });
  const lines = await Promise.all((parsed.parsedLines || []).map(async (line, index) => {
    const matched = Boolean(line.productId);
    const excluded = line.matchStatus === 'EXCLUDED' || line.excluded;
    return {
      sourcePartId: sourcePart.sourcePartId,
      sourceLineKey: await buildSourceLineKey({
        sourceDocumentKey,
        externalLineId: `${parsed.sourceMessageKey}:${index}`
      }),
      rawExpression: line.rawText || line.productText,
      productText: line.productText,
      specification: line.specification || line.specText || '',
      quantity: line.quantity,
      unit: line.finalUnit || line.rawUnit || line.unit || '',
      unitPrice: line.unitPrice ?? null,
      externalItemCode: line.externalItemCode || '',
      candidateProducts: line.candidateProducts || [],
      itemName: line.itemName || line.productText,
      productId: line.productId || null,
      itemCode: line.itemCode || '',
      matchStatus: excluded ? 'EXCLUDED' : (matched ? 'MATCHED' : 'MATCH_FAILED'),
      reviewStatus: excluded ? 'EXCLUDED' : 'PENDING',
      productIdentityStatus: matched ? 'MASTER_LINKED' : 'UNRESOLVED'
    };
  }));
  return { parsed, sourceDocumentKey, lines };
}

export const intakeLinesToOrderItems = lines => lines
  .filter(line => line.reviewStatus !== 'EXCLUDED')
  .map((line, index) => ({
    ...line,
    lineNo: index + 1,
    rawQuantity: line.quantity,
    finalQuantity: line.quantity,
    rawUnit: line.unit,
    finalUnit: line.unit,
    price: line.unitPrice ?? 0
  }));
