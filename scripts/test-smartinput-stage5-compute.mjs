#!/usr/bin/env node

import assert from 'node:assert/strict';
import { runStage5Compute } from '../smartinput/stage5-compute-runner.js';
import {
  buildEstimateF8Data,
  buildEstimateDuplicateGroups,
  validateEstimateRows
} from '../smartinput/estimate-output.js';
import { buildPurchaseSalesUploadData } from '../smartinput/purchase-sales-output.js';

const workerScope = { postMessage: () => {} };
globalThis.self = workerScope;
await import('../smartinput/stage5-compute-worker.js');
const workerHandler = workerScope.onmessage;

class InlineModuleWorker {
  postMessage(message) {
    workerScope.postMessage = payload => queueMicrotask(() => this.onmessage?.({ data: payload }));
    queueMicrotask(() => workerHandler({ data: message }));
  }
  terminate() { this.terminated = true; }
}

const rows = Array.from({ length: 600 }, (_, index) => ({
  rowId: `R${index}`,
  itemCode: `ITEM-${index}`,
  itemName: `상품 ${index}`,
  specification: 'EA',
  unit: 'EA',
  quantity: 1,
  inboundPrice: 1000 + index,
  outPrice: 1500 + index,
  wholesaleA: 1400 + index,
  wholesaleB: 1450 + index,
  marketPrice: 1600 + index,
  rowCustomerName: `거래처 ${index % 20}`
}));

const metrics = [];
const prepared = await runStage5Compute({
  feature: 'estimate-report',
  phase: 'ESTIMATE_F8_PREPARE',
  payload: { rows, outputConfig: {} },
  rowCount: rows.length,
  direct: () => ({ rawValidation: validateEstimateRows(rows), duplicateGroups: buildEstimateDuplicateGroups(rows) }),
  workerFactory: () => new InlineModuleWorker(),
  onMetric: metric => metrics.push(metric)
});
assert.deepEqual(prepared.rawValidation, validateEstimateRows(rows));
assert.deepEqual(prepared.duplicateGroups, buildEstimateDuplicateGroups(rows));
assert.equal(metrics.at(-1).path, 'worker');

const workerOutput = await runStage5Compute({
  feature: 'estimate-report',
  phase: 'ESTIMATE_F8_BUILD',
  payload: { rows, options: {}, duplicateResolutionEntries: [] },
  rowCount: rows.length,
  direct: () => buildEstimateF8Data(rows),
  workerFactory: () => new InlineModuleWorker()
});
assert.deepEqual(workerOutput, buildEstimateF8Data(rows));

const purchaseRows = rows.map(row => ({ 품목코드: row.itemCode, 품명: row.itemName, 수량: 1, 단가: row.inboundPrice }));
const workerPurchase = await runStage5Compute({
  feature: 'purchase-sales-report',
  phase: 'PURCHASE_SALES_BUILD',
  payload: { rows: purchaseRows },
  rowCount: purchaseRows.length,
  direct: () => buildPurchaseSalesUploadData(purchaseRows),
  workerFactory: () => new InlineModuleWorker()
});
assert.deepEqual(workerPurchase, buildPurchaseSalesUploadData(purchaseRows));

let smallWorkerCreated = false;
const small = await runStage5Compute({
  feature: 'estimate-report',
  phase: 'ESTIMATE_F8_BUILD',
  payload: { rows: rows.slice(0, 10), options: {}, duplicateResolutionEntries: [] },
  rowCount: 10,
  direct: () => 'DIRECT',
  workerFactory: () => { smallWorkerCreated = true; return new InlineModuleWorker(); }
});
assert.equal(small, 'DIRECT');
assert.equal(smallWorkerCreated, false, 'small inputs must not create a Worker');

const fallback = await runStage5Compute({
  feature: 'estimate-report',
  phase: 'ESTIMATE_F8_BUILD',
  payload: { rows, options: {}, duplicateResolutionEntries: [] },
  rowCount: rows.length,
  direct: () => 'FALLBACK',
  workerFactory: () => { throw new Error('WORKER_UNAVAILABLE'); },
  onMetric: metric => metrics.push(metric)
});
assert.equal(fallback, 'FALLBACK');
assert.equal(metrics.at(-1).path, 'fallback-direct');

console.log('SmartInput Stage5 Worker/direct parity, threshold, and fallback passed.');

// A promotion-only price must also activate sale in the large-report Worker path.
const promotionOnlyRows = rows.map(row => ({ ...row, outPrice: '', promoPrice: 15800 }));
const promotionMetrics = [];
const promotionOutput = await runStage5Compute({
  feature: 'estimate-report', phase: 'ESTIMATE_F8_BUILD',
  payload: { rows: promotionOnlyRows, options: {}, duplicateResolutionEntries: [] },
  rowCount: promotionOnlyRows.length,
  direct: () => buildEstimateF8Data(promotionOnlyRows),
  workerFactory: () => new InlineModuleWorker(),
  onMetric: metric => promotionMetrics.push(metric)
});
assert.equal(promotionMetrics.at(-1).path, 'worker');
assert.equal(promotionOutput.ok, true);
assert.deepEqual(promotionOutput, buildEstimateF8Data(promotionOnlyRows));
assert.equal(promotionOutput.shopData.length, 601);
assert.equal(promotionOutput.shopData.slice(1).every(row => row[3] === 15800 && row[14] === '1' && row[15] === 999), true);
assert.equal(promotionOutput.erpData.slice(1).every(row => row[3] === ''), true);
console.log('PASS: 600 promotion-only rows use Worker and retain ERP/stock policy');

const purchaseIssueRows = Array.from({length:600},(_,index)=>({
  거래처:index%2?'4연산':'1마산', 거래처명:`검증거래처${index%7}`,
  코드:`ITEM-${index}`, 품명:`검증상품${index}`, 수량: index%3?2:0,
  입고가:index%2?20000:1000, 도매A:index%2?3000:4000
}));
const purchaseIssueMetrics=[];
const purchaseIssueOutput=await runStage5Compute({
  feature:'purchase-sales-report',phase:'PURCHASE_SALES_BUILD',
  payload:{rows:purchaseIssueRows},rowCount:purchaseIssueRows.length,
  direct:()=>buildPurchaseSalesUploadData(purchaseIssueRows),
  workerFactory:()=>new InlineModuleWorker(),onMetric:m=>purchaseIssueMetrics.push(m)
});
assert.equal(purchaseIssueMetrics.at(-1).path,'worker');
assert.deepEqual(purchaseIssueOutput,buildPurchaseSalesUploadData(purchaseIssueRows));
assert.equal(purchaseIssueOutput.matrices['확인요청'][0][0],'이슈');
assert.equal(purchaseIssueOutput.matrices['판매입력'].length,601);
console.log('PASS: 600 purchase issue rows retain Worker/direct parity');
