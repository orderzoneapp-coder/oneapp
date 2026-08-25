import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  evaluatePurchaseStage3Capability,
  PURCHASE_STAGE3_CAPABILITY,
  PURCHASE_STAGE3_EXPECTED_DEPLOYMENT
} from '../smartinput/purchase-official-stage3.js';
import {
  evaluateSaleStage4Capability,
  SALE_STAGE4_CAPABILITY,
  SALE_STAGE4_EXPECTED_DEPLOYMENT
} from '../smartinput/sale-official-stage4.js';

const saleExpected = SALE_STAGE4_EXPECTED_DEPLOYMENT;
const combinedPing = {
  ...PURCHASE_STAGE3_CAPABILITY,
  ...SALE_STAGE4_CAPABILITY,
  ...PURCHASE_STAGE3_EXPECTED_DEPLOYMENT,
  saleDeploymentId: saleExpected.deploymentId,
  saleDeploymentVersion: saleExpected.deploymentVersion,
  saleGitCommit: saleExpected.gitCommit
};

assert.equal(evaluatePurchaseStage3Capability(combinedPing).ready, true, 'Stage 3 generic deployment evidence remains ready');
assert.equal(PURCHASE_STAGE3_EXPECTED_DEPLOYMENT.deploymentVersion, '26');
assert.equal(PURCHASE_STAGE3_EXPECTED_DEPLOYMENT.gitCommit, 'c84b7962313b5c266e7466045c9623f5c149d50c');
assert.equal(saleExpected.deploymentVersion, '27');
assert.equal(saleExpected.gitCommit, 'ae120131a3890438ef5fadfa14f3c3905f872e69');
const saleReady = evaluateSaleStage4Capability(combinedPing);
assert.deepEqual(saleReady, { ready: true, code: '', ...saleExpected }, 'sale returns its sale-specific evidence');

for (const [field, value] of [
  ['saleDeploymentId', ''], ['saleDeploymentVersion', ''], ['saleGitCommit', ''],
  ['saleDeploymentId', 'wrong'], ['saleDeploymentVersion', 'wrong'], ['saleGitCommit', 'wrong']
]) {
  const mutated = { ...combinedPing, [field]: value };
  assert.equal(evaluateSaleStage4Capability(mutated).ready, false, `${field} mutation disables sale`);
  assert.equal(evaluatePurchaseStage3Capability(mutated).ready, true, `${field} mutation does not affect purchase`);
}

const genericCannotSubstitute = {
  ...combinedPing,
  deploymentId: saleExpected.deploymentId,
  deploymentVersion: saleExpected.deploymentVersion,
  gitCommit: saleExpected.gitCommit,
  saleDeploymentId: '', saleDeploymentVersion: '', saleGitCommit: ''
};
assert.equal(evaluateSaleStage4Capability(genericCannotSubstitute).ready, false,
  'matching generic evidence cannot substitute for sale evidence');

for (const field of ['salesMetaSchema', 'dbSchemaVersion']) {
  const mutated = { ...combinedPing, [field]: 'wrong' };
  assert.equal(evaluateSaleStage4Capability(mutated).ready, false, `${field} mutation disables sale`);
  assert.equal(evaluatePurchaseStage3Capability(mutated).ready, true, `${field} mutation does not affect purchase`);
}
for (const field of ['cutoverMode', 'commandContract']) {
  const mutated = { ...combinedPing, [field]: 'wrong' };
  assert.equal(evaluateSaleStage4Capability(mutated).ready, false, `${field} mutation disables sale`);
  assert.equal(evaluatePurchaseStage3Capability(mutated).ready, false, `${field} shared mutation also disables purchase`);
}

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
