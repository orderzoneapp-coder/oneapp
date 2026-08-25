import { ORDERQ_DB_VERSION as V14 } from './orderq-v14-contracts.js?v=0.1.0';

export const ORDERQ_DB_VERSION = 15;
export const ORDERQ_PREVIOUS_DB_VERSION = V14;
export const SITUATION_ALGORITHM_VERSION = 'ORDERQ_SITUATION_V1';
export const V15_STORE = Object.freeze({
  SITUATION_ANALYSES: 'situationAnalyses',
  SITUATION_READ_SESSIONS: 'situationReadSessions'
});
export const V15_STORE_DEFINITIONS = Object.freeze([
  Object.freeze({ name: V15_STORE.SITUATION_ANALYSES, keyPath: 'analysisId', indexes: Object.freeze([
    Object.freeze({ name: 'byCombinedDigestAlgorithm', keyPath: Object.freeze(['combinedDigest','businessDate','windowKey','algorithmVersion']), options: Object.freeze({ unique:true }) }),
    Object.freeze({ name: 'byCompletedAt', keyPath: 'completedAt', options: Object.freeze({ unique:false }) }),
    Object.freeze({ name: 'byStatus', keyPath: 'status', options: Object.freeze({ unique:false }) })
  ]) }),
  Object.freeze({ name: V15_STORE.SITUATION_READ_SESSIONS, keyPath: 'readSessionId', indexes: Object.freeze([
    Object.freeze({ name:'byStatusExpiresAt', keyPath:Object.freeze(['status','expiresAt']), options:Object.freeze({ unique:false }) }),
    Object.freeze({ name:'byTokenDigest', keyPath:'tokenDigest', options:Object.freeze({ unique:true }) })
  ]) })
]);
