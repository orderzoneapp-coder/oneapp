import { getCloudUrl,pingCentralAuthority } from './orderq-cloud-adapter.js?v=0.20.0';
import { evaluateOrderQSituationCapability,orderQSituationCloudAdapter } from './orderq-situation-cloud-adapter.js?v=0.1.0';

let ephemeralDataOpsCredential=null;
const today=()=>new Date().toISOString().slice(0,10);
export async function situationCapabilityReady(){try{return evaluateOrderQSituationCapability(await pingCentralAuthority());}catch(_){return false;}}
function requireEphemeralCredential(promptFn=globalThis.prompt){
  if(ephemeralDataOpsCredential)return ephemeralDataOpsCredential;
  const token=String(promptFn?.('DataOps V2 읽기 토큰을 입력하세요. (현재 화면 메모리에만 유지됩니다.)')||'').trim();
  if(!token)throw new Error('DATAOPS_SITUATION_ACCESS_DENIED');
  ephemeralDataOpsCredential={token,actorId:'ADMIN',device:'ORDERQ_BROWSER',environment:'PRODUCTION',scope:{companyId:'ONEAPP'}};
  return ephemeralDataOpsCredential;
}
export async function defaultSituationRuntime(options={}){
  if(!(await (options.capabilityReady||situationCapabilityReady)()))throw new Error('ORDERQ_SITUATION_READ_CAPABILITY_REQUIRED');
  const url=String(options.url||getCloudUrl()||'').trim();if(!url)throw new Error('CLOUD_URL_MISSING');
  const businessDate=String(options.businessDate||today()),credential=options.credential||requireEphemeralCredential(options.promptFn);
  return {businessDate,windowKey:`DAY:${businessDate}`,operationWindow:{from:businessDate,to:businessDate},dataOps:{url,credential},orderQAdapter:orderQSituationCloudAdapter};
}
export function clearSituationCredential(){ephemeralDataOpsCredential=null;}
