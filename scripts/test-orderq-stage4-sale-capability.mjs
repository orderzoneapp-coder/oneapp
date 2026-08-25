import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluatePurchaseStage3Capability,
  PURCHASE_STAGE3_CAPABILITY,
  PURCHASE_STAGE3_EXPECTED_DEPLOYMENT
} from '../smartinput/purchase-official-stage3.js';
import { evaluateSaleStage4Capability, SALE_STAGE4_CAPABILITY } from '../smartinput/sale-official-stage4.js';

const saleExpected = Object.freeze({ deploymentId: 'SALE-DEPLOYMENT', deploymentVersion: '41', gitCommit: 'sale-commit' });
const combinedPing = {
  ...PURCHASE_STAGE3_CAPABILITY,
  ...SALE_STAGE4_CAPABILITY,
  ...PURCHASE_STAGE3_EXPECTED_DEPLOYMENT,
  saleDeploymentId: saleExpected.deploymentId,
  saleDeploymentVersion: saleExpected.deploymentVersion,
  saleGitCommit: saleExpected.gitCommit
};

assert.equal(evaluatePurchaseStage3Capability(combinedPing).ready, true, 'Stage 3 generic deployment evidence remains ready');
const saleReady = evaluateSaleStage4Capability(combinedPing, saleExpected);
assert.deepEqual(saleReady, { ready: true, code: '', ...saleExpected }, 'sale returns its sale-specific evidence');

for (const [field, value] of [
  ['saleDeploymentId', ''], ['saleDeploymentVersion', ''], ['saleGitCommit', ''],
  ['saleDeploymentId', 'wrong'], ['saleDeploymentVersion', 'wrong'], ['saleGitCommit', 'wrong']
]) {
  const mutated = { ...combinedPing, [field]: value };
  assert.equal(evaluateSaleStage4Capability(mutated, saleExpected).ready, false, `${field} mutation disables sale`);
  assert.equal(evaluatePurchaseStage3Capability(mutated).ready, true, `${field} mutation does not affect purchase`);
}

const genericCannotSubstitute = {
  ...combinedPing,
  deploymentId: saleExpected.deploymentId,
  deploymentVersion: saleExpected.deploymentVersion,
  gitCommit: saleExpected.gitCommit,
  saleDeploymentId: '', saleDeploymentVersion: '', saleGitCommit: ''
};
assert.equal(evaluateSaleStage4Capability(genericCannotSubstitute, saleExpected).ready, false,
  'matching generic evidence cannot substitute for sale evidence');

const cloud = readFileSync(new URL('../orderq-cloud.gs', import.meta.url), 'utf8');
for (const [constant, property] of [
  ['ORDERQ_STAGE3_DEPLOYMENT_ID_PROPERTY', 'ONEAPP_ORDERQ_STAGE3_DEPLOYMENT_ID'],
  ['ORDERQ_STAGE3_DEPLOYMENT_VERSION_PROPERTY', 'ONEAPP_ORDERQ_STAGE3_DEPLOYMENT_VERSION'],
  ['ORDERQ_STAGE3_GIT_COMMIT_PROPERTY', 'ONEAPP_ORDERQ_STAGE3_GIT_COMMIT'],
  ['ORDERQ_STAGE4_DEPLOYMENT_ID_PROPERTY', 'ONEAPP_ORDERQ_STAGE4_DEPLOYMENT_ID'],
  ['ORDERQ_STAGE4_DEPLOYMENT_VERSION_PROPERTY', 'ONEAPP_ORDERQ_STAGE4_DEPLOYMENT_VERSION'],
  ['ORDERQ_STAGE4_GIT_COMMIT_PROPERTY', 'ONEAPP_ORDERQ_STAGE4_GIT_COMMIT']
]) {
  assert.match(cloud, new RegExp(`const ${constant} = '${property}'`));
}
assert.match(cloud, /deploymentId:\s*String\(properties\.getProperty\(ORDERQ_STAGE3_DEPLOYMENT_ID_PROPERTY\)/);
assert.match(cloud, /saleDeploymentId:\s*String\(properties\.getProperty\(ORDERQ_STAGE4_DEPLOYMENT_ID_PROPERTY\)/);
assert.doesNotMatch(cloud, /saleDeploymentId:\s*String\(properties\.getProperty\(ORDERQ_STAGE3_/);
assert.doesNotMatch(cloud, /deploymentId:\s*String\(properties\.getProperty\(ORDERQ_STAGE4_/);

console.log('ORDER Q stage4 sale capability independence tests passed');
