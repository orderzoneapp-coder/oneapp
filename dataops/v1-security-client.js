(function(global){
  'use strict';
  const EXPECTED_DEPLOYMENT=Object.freeze({deploymentId:'AKfycbzOUOIu_bP7NkiFVziDR0Og1da1KO1ePoU09Q3pSlPr-9uD-WkdCpWN7nidO5hlrJi6Qw',deploymentVersion:'31',gitCommit:'48a52ec34fa938cd60fe965b795083539460627f'});
  const CAPABILITY='DATAOPS_SNAPSHOT_V1_SECURITY_V1',CUTOVER='SERVER_FIRST_V1';
  const text=value=>String(value??'').trim();
  const released=expected=>['deploymentId','deploymentVersion','gitCommit'].every(key=>text(expected[key]));
  const requireCredential=()=>{if(!global.ONEAPP_AUTH?.gateway)throw new Error('DATAOPS_V1_ACCESS_DENIED');return Object.freeze({gateway:true});};
  function evaluate(ping,expected=EXPECTED_DEPLOYMENT){return Boolean(released(expected)&&text(ping?.deploymentId)===text(expected.deploymentId)&&text(ping?.deploymentVersion)===text(expected.deploymentVersion)&&text(ping?.gitCommit)===text(expected.gitCommit)&&ping?.capabilityVersion===CAPABILITY&&ping?.mode===CUTOVER&&ping?.readAuthRequired===true&&ping?.writeAuthRequired===true&&JSON.stringify(ping?.roles)===JSON.stringify(['DATAOPS_SNAPSHOT_V1_READ','DATAOPS_SNAPSHOT_V1_WRITE'])&&JSON.stringify(ping?.actions)===JSON.stringify(['dataops_snapshot_get','dataops_snapshot_commit']));}
  async function request(fetchImpl,url,action,body={}){const operations={dataops_v1_security_ping:'dataops.security_ping',dataops_snapshot_get:'dataops.snapshot.get',dataops_snapshot_commit:'dataops.snapshot.commit'};if(!operations[action]||!global.ONEAPP_AUTH?.gateway)throw new Error('DATAOPS_V1_REQUEST_FAILED');await global.ONEAPP_AUTH.ready;return global.ONEAPP_AUTH.gateway(operations[action],body);}
  async function verifyCapability(fetchImpl,url,expected){const data=await request(fetchImpl,url,'dataops_v1_security_ping');if(!evaluate(data,expected))throw new Error('DATAOPS_V1_SECURITY_CAPABILITY_REQUIRED');return data;}
  function createReadClient({expectedDeployment=EXPECTED_DEPLOYMENT,fetchImpl=global.fetch}={}){
    let connection=null;
    return Object.freeze({
      released:()=>released(expectedDeployment),
      ready:()=>Boolean(connection),
      clear:()=>{connection=null;},
      async connect({url,readCredential}={}){if(!released(expectedDeployment))throw new Error('DATAOPS_V1_SECURITY_NOT_RELEASED');requireCredential();await verifyCapability(fetchImpl,url,expectedDeployment);connection={gateway:true};return true;},
      async getSnapshot({url,readCredential}={}){if(!released(expectedDeployment))throw new Error('DATAOPS_V1_SECURITY_NOT_RELEASED');if(!connection)await this.connect({url,readCredential});return request(fetchImpl,'','dataops_snapshot_get',{});}
    });
  }
  function createClient({expectedDeployment=EXPECTED_DEPLOYMENT,fetchImpl=global.fetch}={}){
    let connection=null;
    return Object.freeze({
      released:()=>released(expectedDeployment),
      ready:()=>Boolean(connection),
      clear:()=>{connection=null;},
      async connect({url,readCredential,writeCredential}={}){if(!released(expectedDeployment))throw new Error('DATAOPS_V1_SECURITY_NOT_RELEASED');requireCredential();await verifyCapability(fetchImpl,url,expectedDeployment);connection={gateway:true};return true;},
      envelope(operation){if(!connection)throw new Error('DATAOPS_V1_SECURITY_CONNECTION_REQUIRED');return{};},
      async commitSnapshot({legacyModule,productData,targetDateStr,url,readCredential,writeCredential}){if(!released(expectedDeployment))throw new Error('DATAOPS_V1_SECURITY_NOT_RELEASED');if(!connection)await this.connect({url,readCredential,writeCredential});const snapshot=await legacyModule.buildSnapshot({productData,targetDateStr}),saved=await request(fetchImpl,'','dataops_snapshot_commit',{snapshot});if(!saved)throw new Error('DATAOPS_V1_WRITE_FAILED');return{snapshot,saved};}
    });
  }
  global.DATAOPS_V1_SECURITY_CLIENT=Object.freeze({EXPECTED_DEPLOYMENT,evaluate,createReadClient,createClient,readClient:createReadClient(),client:createClient()});
})(typeof window!=='undefined'?window:globalThis);
