import { STORE, getAll, normalizeText } from '../orderq-db.js?v=0.6.1';

function similarity(left, right) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) * 0.9;
  const setA = new Set(a);
  const setB = new Set(b);
  const overlap = [...setA].filter(char => setB.has(char)).length;
  return overlap / Math.max(setA.size, setB.size, 1);
}

export async function resolveCustomer({ senderRaw = '', sourceId = '' } = {}) {
  const normalized = normalizeText(senderRaw);
  if (!normalized) return { status: 'UNRESOLVED', customer: null, candidates: [], matchSource: 'NO_SENDER' };
  const [aliases, customers] = await Promise.all([
    getAll(STORE.CUSTOMER_ALIASES),
    getAll(STORE.CUSTOMERS)
  ]);
  const customerById = new Map(customers.map(customer => [customer.customerId, customer]));

  const sourceAlias = aliases.find(alias => alias.sourceId === sourceId && alias.normalizedText === normalized);
  const exactAlias = sourceAlias || aliases.find(alias => alias.normalizedText === normalized);
  if (exactAlias && customerById.has(exactAlias.customerId)) {
    return {
      status: 'MATCHED',
      customer: customerById.get(exactAlias.customerId),
      candidates: [],
      matchSource: sourceAlias ? 'SOURCE_ALIAS' : 'CUSTOMER_ALIAS'
    };
  }

  const exactCustomer = customers.find(customer => normalizeText(customer.customerName) === normalized);
  if (exactCustomer) return { status: 'MATCHED', customer: exactCustomer, candidates: [], matchSource: 'CUSTOMER_NAME' };

  const candidates = customers.map(customer => ({
    customer,
    score: similarity(senderRaw, customer.customerName)
  })).filter(candidate => candidate.score >= 0.45).sort((a, b) => b.score - a.score).slice(0, 5);

  return {
    status: 'UNRESOLVED',
    customer: null,
    candidates,
    matchSource: candidates.length ? 'SIMILAR_CANDIDATES' : 'NO_MATCH'
  };
}

