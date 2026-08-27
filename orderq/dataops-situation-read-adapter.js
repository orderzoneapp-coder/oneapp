import { validateFrozenSession, validatePageManifest } from './situation-read-token.js?v=0.1.0';

const requiredCredential = credential => {
  if (!credential?.token || !credential?.actorId || !credential?.scope?.companyId) throw new Error('DATAOPS_SITUATION_ACCESS_DENIED');
  return credential;
};
async function post(url, action, credential, body={}) {
  requiredCredential(credential);
  if (!['situation_dataops_ping','situation_dataops_begin','situation_dataops_page','situation_dataops_head'].includes(action)) throw new Error('DATAOPS_SITUATION_READ_ACTION_FORBIDDEN');
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({action,...body,...credential,scope:credential.scope})});
  const json=await response.json();
  if (!response.ok || json?.status !== 'success' || json.action !== action) throw new Error(String(json?.message||'DATAOPS_SITUATION_READ_FAILED'));
  return json.data;
}
export async function beginDataOpsFrozenRead({url,credential,businessDate,now=Date.now()}) {
  return validateFrozenSession(await post(url,'situation_dataops_begin',credential,{businessDate}),'DATAOPS',now);
}
export async function readDataOpsFrozenPages({url,credential},begin) {
  const pages=[];
  for (const item of begin.pageManifest?.pages || begin.pageManifest || []) pages.push(await post(url,'situation_dataops_page',credential,{readSessionId:begin.readSessionId,tokenDigest:begin.tokenDigest,pageIndex:item.pageIndex}));
  await validatePageManifest(begin,pages);
  return pages;
}
export async function confirmDataOpsFrozenHead({url,credential},begin) {
  const head=await post(url,'situation_dataops_head',credential,{readSessionId:begin.readSessionId,tokenDigest:begin.tokenDigest});
  if (head.frozenTokenDigest !== begin.tokenDigest || head.currentHeadRevision !== begin.headRevision || head.currentHeadDigest !== begin.headDigest) throw new Error('SITUATION_HEAD_CHANGED');
  return head;
}
export async function readDataOpsFrozenSnapshot(options) {
  const begin=await beginDataOpsFrozenRead(options),pages=await readDataOpsFrozenPages(options,begin),head=await confirmDataOpsFrozenHead(options,begin);
  const rows=pages.flatMap(page=>page.rows||[]);
  return {session:begin,head,manifest:begin.entityManifest?.manifest || begin.manifest,rows,pages};
}
