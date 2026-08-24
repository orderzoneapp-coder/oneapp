import { ORDERQ_DB_VERSION as V13 } from './orderq-v13-contracts.js?v=0.1.0';

export const ORDERQ_DB_VERSION = 14;
export const ORDERQ_PREVIOUS_DB_VERSION = V13;
export const V14_INDEXES = Object.freeze({
  salesDocuments:Object.freeze([
    Object.freeze({ name:'byOriginRunDocument', keyPath:Object.freeze(['originSystem','originTransactionId','sourceDocumentKey']), options:Object.freeze({ unique:true }) }),
    Object.freeze({ name:'byOriginExternalDocument', keyPath:Object.freeze(['originSystem','externalDocumentNo']), options:Object.freeze({ unique:false }) })
  ]),
  salesLines:Object.freeze([
    Object.freeze({ name:'bySourceDispatchPair', keyPath:Object.freeze(['sourceDispatchId','sourceDispatchLineId']), options:Object.freeze({ unique:false }) }),
    Object.freeze({ name:'bySourceOrderItem', keyPath:Object.freeze(['sourceOrderId','sourceOrderItemId']), options:Object.freeze({ unique:false }) })
  ]),
  orderEvents:Object.freeze([
    Object.freeze({ name:'byAllocationEventId', keyPath:'detail.allocationEventId', options:Object.freeze({ unique:false }) }),
    Object.freeze({ name:'byRestoresReversalEventId', keyPath:'detail.restoresReversalEventId', options:Object.freeze({ unique:false }) }),
    Object.freeze({ name:'bySalesLine', keyPath:'detail.salesLineId', options:Object.freeze({ unique:false }) })
  ])
});
