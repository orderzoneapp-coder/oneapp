import { beginOrderQSituationRead,readOrderQSituationPage,readOrderQSituationHead } from './orderq-cloud-adapter.js?v=0.20.0';

export const ORDERQ_SITUATION_EXPECTED_DEPLOYMENT=Object.freeze({
  deploymentId:'AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw',
  deploymentVersion:'30',
  gitCommit:'05804562f87cdb9cc952b63930cf403bb7f4e658'
});
export function evaluateOrderQSituationCapability(ping={}){
  const expected=ORDERQ_SITUATION_EXPECTED_DEPLOYMENT;
  return Boolean(expected.deploymentId&&expected.deploymentVersion&&expected.gitCommit
    &&ping.situationSchemaVersion==='ORDERQ_SITUATION_READ_V1'
    &&ping.situationCapabilityVersion==='ORDERQ_SITUATION_V1'
    &&ping.situationDbSchemaVersion==='15'
    &&ping.situationDeploymentId===expected.deploymentId
    &&String(ping.situationDeploymentVersion)===expected.deploymentVersion
    &&ping.situationGitCommit===expected.gitCommit
    &&JSON.stringify(ping.situationActions||[])===JSON.stringify(['situation_orderq_begin','situation_orderq_page','situation_orderq_head']));
}
const readIdentity=Object.freeze({actorId:'ADMIN',device:'ORDERQ_BROWSER',environment:'PRODUCTION',scope:Object.freeze({companyId:'ONEAPP'})});
export const orderQSituationCloudAdapter=Object.freeze({
  begin:request=>beginOrderQSituationRead({...request,...readIdentity}),
  page:request=>readOrderQSituationPage({...request,...readIdentity}),
  head:request=>readOrderQSituationHead({...request,...readIdentity})
});
