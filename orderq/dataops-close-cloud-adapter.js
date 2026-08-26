export const DATAOPS_CLOSE_EXPECTED_DEPLOYMENT=Object.freeze({deploymentId:'AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw',deploymentVersion:'31',gitCommit:'48a52ec34fa938cd60fe965b795083539460627f'});
export const DATAOPS_CLOSE_CAPABILITY='DATAOPS_CLOSE_V1';
export const DATAOPS_CLOSE_ACTIONS=Object.freeze(['dataops_close_ping','dataops_close_context','dataops_close_seal','dataops_close_prepare','dataops_close_write_chunks','dataops_close_commit','dataops_close_abort']);
const text=value=>String(value??'').trim();
export function evaluateDataOpsCloseCapability(ping={}){const expected=DATAOPS_CLOSE_EXPECTED_DEPLOYMENT;return {ready:Boolean(text(expected.deploymentId)&&text(expected.deploymentVersion)&&text(expected.gitCommit)&&text(ping.deploymentId)===expected.deploymentId&&text(ping.deploymentVersion)===expected.deploymentVersion&&text(ping.gitCommit)===expected.gitCommit&&text(ping.capabilityVersion)===DATAOPS_CLOSE_CAPABILITY&&JSON.stringify(ping.actions||[])===JSON.stringify(DATAOPS_CLOSE_ACTIONS)),code:'DATAOPS_CLOSE_DEPLOYMENT_NOT_RELEASED'};}
export function closeWriteEnabled(ping){return evaluateDataOpsCloseCapability(ping).ready;}
