(function(global){
  'use strict';
  const EXPECTED_DEPLOYMENT=Object.freeze({deploymentId:'',deploymentVersion:'',gitCommit:''});
  const CAPABILITY='DATAOPS_SNAPSHOT_V1_SECURITY_V1',CUTOVER='SERVER_FIRST_V1';
  const text=value=>String(value??'').trim();
  const released=expected=>['deploymentId','deploymentVersion','gitCommit'].every(key=>text(expected[key]));
  const requireCredential=value=>{const credential={token:text(value?.token),actorId:text(value?.actorId),deviceId:text(value?.deviceId),environment:text(value?.environment),scope:{companyId:text(value?.scope?.companyId)}};if(!credential.token||!credential.actorId||!credential.scope.companyId)throw new Error('DATAOPS_V1_ACCESS_DENIED');return Object.freeze(credential);};
  function evaluate(ping,expected=EXPECTED_DEPLOYMENT){return Boolean(released(expected)&&text(ping?.deploymentId)===text(expected.deploymentId)&&text(ping?.deploymentVersion)===text(expected.deploymentVersion)&&text(ping?.gitCommit)===text(expected.gitCommit)&&ping?.capabilityVersion===CAPABILITY&&ping?.mode===CUTOVER&&ping?.readAuthRequired===true&&ping?.writeAuthRequired===true&&JSON.stringify(ping?.roles)===JSON.stringify(['DATAOPS_SNAPSHOT_V1_READ','DATAOPS_SNAPSHOT_V1_WRITE'])&&JSON.stringify(ping?.actions)===JSON.stringify(['dataops_snapshot_get','dataops_snapshot_commit']));}
  async function request(fetchImpl,url,action,body={}){const response=await fetchImpl(text(url),{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action,...body})}),json=await response.json();if(!response.ok||json?.status!=='success'||json?.action!==action)throw new Error(text(json?.message)||'DATAOPS_V1_REQUEST_FAILED');return json.data;}
  async function verifyCapability(fetchImpl,url,expected){const data=await request(fetchImpl,url,'dataops_v1_security_ping');if(!evaluate(data,expected))throw new Error('DATAOPS_V1_SECURITY_CAPABILITY_REQUIRED');return data;}
  function createReadClient({expectedDeployment=EXPECTED_DEPLOYMENT,fetchImpl=global.fetch}={}){
    let connection=null;
    return Object.freeze({
      released:()=>released(expectedDeployment),
      ready:()=>Boolean(connection),
      clear:()=>{connection=null;},
      async connect({url,readCredential}){if(!released(expectedDeployment))throw new Error('DATAOPS_V1_SECURITY_NOT_RELEASED');const read=requireCredential(readCredential);await verifyCapability(fetchImpl,url,expectedDeployment);connection={url:text(url),read};return true;},
      async getSnapshot({url,readCredential}={}){if(!released(expectedDeployment))throw new Error('DATAOPS_V1_SECURITY_NOT_RELEASED');if(!connection)await this.connect({url,readCredential});return request(fetchImpl,connection.url,'dataops_snapshot_get',{...connection.read,scope:connection.read.scope});}
    });
  }
  function createClient({expectedDeployment=EXPECTED_DEPLOYMENT,fetchImpl=global.fetch}={}){
    let connection=null;
    return Object.freeze({
      released:()=>released(expectedDeployment),
      ready:()=>Boolean(connection),
      clear:()=>{connection=null;},
      async connect({url,readCredential,writeCredential}){if(!released(expectedDeployment))throw new Error('DATAOPS_V1_SECURITY_NOT_RELEASED');const read=requireCredential(readCredential),write=requireCredential(writeCredential);if(read.token===write.token)throw new Error('DATAOPS_V1_CREDENTIAL_SEPARATION_REQUIRED');if(read.actorId!==write.actorId||JSON.stringify(read.scope)!==JSON.stringify(write.scope))throw new Error('DATAOPS_V1_SCOPE_MISMATCH');await verifyCapability(fetchImpl,url,expectedDeployment);connection={url:text(url),read,write};return true;},
      envelope(operation){if(!connection)throw new Error('DATAOPS_V1_SECURITY_CONNECTION_REQUIRED');const credential=operation==='WRITE'?connection.write:connection.read;return{token:credential.token,actorId:credential.actorId,deviceId:credential.deviceId,environment:credential.environment,scope:credential.scope};},
      async commitSnapshot({legacyModule,productData,targetDateStr,url,readCredential,writeCredential}){if(!released(expectedDeployment))throw new Error('DATAOPS_V1_SECURITY_NOT_RELEASED');if(!connection)await this.connect({url,readCredential,writeCredential});const snapshot=await legacyModule.buildSnapshot({productData,targetDateStr}),saved=await request(fetchImpl,connection.url,'dataops_snapshot_commit',{snapshot,...this.envelope('WRITE')});if(!saved)throw new Error('DATAOPS_V1_WRITE_FAILED');return{snapshot,saved};}
    });
  }
  global.DATAOPS_V1_SECURITY_CLIENT=Object.freeze({EXPECTED_DEPLOYMENT,evaluate,createReadClient,createClient,readClient:createReadClient(),client:createClient()});
})(typeof window!=='undefined'?window:globalThis);
