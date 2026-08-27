import { getCloudUrl,pingCentralAuthority } from './orderq-cloud-adapter.js?v=0.20.0';
import { evaluateOrderQSituationCapability,orderQSituationCloudAdapter } from './orderq-situation-cloud-adapter.js?v=0.1.1';

let ephemeralDataOpsCredential=null;
const today=()=>new Date().toISOString().slice(0,10);
export async function situationCapabilityReady(){try{return evaluateOrderQSituationCapability(await pingCentralAuthority());}catch(_){return false;}}
function requireEphemeralCredential(){
  if(ephemeralDataOpsCredential)return ephemeralDataOpsCredential;
  if(!globalThis.ONEAPP_AUTH?.session)throw new Error('NEXUS_AUTH_SESSION_REQUIRED');
  ephemeralDataOpsCredential=globalThis.ONEAPP_AUTH.businessCredential('DATAOPS_READ');
  return ephemeralDataOpsCredential;
}
export async function defaultSituationRuntime(options={}){
  await globalThis.ONEAPP_AUTH?.ready;
  if(!(await (options.capabilityReady||situationCapabilityReady)()))throw new Error('ORDERQ_SITUATION_READ_CAPABILITY_REQUIRED');
  const url=String(options.url||getCloudUrl()||'').trim();if(!url)throw new Error('CLOUD_URL_MISSING');
  const businessDate=String(options.businessDate||today()),credential=options.credential||requireEphemeralCredential();
  return {businessDate,windowKey:`DAY:${businessDate}`,operationWindow:{from:businessDate,to:businessDate},dataOps:{url,credential},orderQAdapter:orderQSituationCloudAdapter};
}
export function clearSituationCredential(){ephemeralDataOpsCredential=null;}
