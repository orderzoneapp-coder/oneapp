export const READ_SESSION_TTL_SECONDS = 120;
export const MAX_SITUATION_READ_RETRIES = 2;
export const TOTAL_SITUATION_READ_ATTEMPTS = 3;

const text = value => String(value ?? '').trim();
const codePointCompare=(left,right)=>{const a=Array.from(String(left),char=>char.codePointAt(0)),b=Array.from(String(right),char=>char.codePointAt(0));for(let index=0;index<Math.min(a.length,b.length);index+=1)if(a[index]!==b[index])return a[index]-b[index];return a.length-b.length;};
const canonical = value => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.normalize('NFC').replace(/\r\n?/g,'\n').trim();
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('SITUATION_CANONICAL_NUMBER_INVALID'); return Object.is(value,-0) ? 0 : value; }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(canonical);
  const keys=new Map();for(const original of Object.keys(value)){const key=original.normalize('NFC').replace(/\r\n?/g,'\n').trim();if(keys.has(key))throw new Error('SITUATION_CANONICAL_KEY_CONFLICT');keys.set(key,original);}return [...keys.keys()].sort(codePointCompare).reduce((out,key)=>{out[key]=canonical(value[keys.get(key)]);return out;},{});
};
export const canonicalJson = value => JSON.stringify(canonical(value));
export async function canonicalSha256(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function validateFrozenSession(session, authority, now = Date.now()) {
  if (!session || session.authority !== authority || !text(session.readSessionId) || !text(session.tokenDigest)) throw new Error('SITUATION_READ_TOKEN_INVALID');
  if (session.status !== 'OPEN' || Date.parse(session.expiresAt) <= now || Date.parse(session.issuedAt) + READ_SESSION_TTL_SECONDS*1000 < now) throw new Error('SITUATION_READ_TOKEN_EXPIRED');
  if (!text(session.deploymentId) || !text(session.deploymentVersion) || !text(session.gitCommit) || !text(session.capabilityVersion)) throw new Error('SITUATION_READ_DEPLOYMENT_CHANGED');
  return session;
}
export async function validatePageManifest(session, pages) {
  const expected = session.pageManifest?.pages || session.pageManifest || [];
  if (!Array.isArray(pages) || pages.length !== expected.length) throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
  for (let index=0; index<pages.length; index+=1) {
    const page=pages[index];
    const manifest = expected[index] || {};
    if (Number(page.pageIndex) !== Number(manifest.pageIndex) || Number(page.rowCount) !== Number(manifest.rowCount) || text(page.pageDigest) !== text(manifest.pageDigest)) throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
    const content=page.entities||page.rows||page.movements||[];
    if(await canonicalSha256(content)!==text(page.pageDigest))throw new Error('SITUATION_MOVEMENT_MANIFEST_INCOMPLETE');
  }
  return true;
}
export async function withSituationReadRetries(operation, onRetry = () => {}) {
  let last;
  for (let attempt=1; attempt<=TOTAL_SITUATION_READ_ATTEMPTS; attempt+=1) {
    try { return await operation(attempt); }
    catch (error) {
      last=error;
      const retryable = /SITUATION_(READ_TOKEN_EXPIRED|READ_DEPLOYMENT_CHANGED|MOVEMENT_MANIFEST_INCOMPLETE|HEAD_CHANGED)/.test(String(error?.message||error));
      if (!retryable || attempt === TOTAL_SITUATION_READ_ATTEMPTS) throw error;
      onRetry({attempt,errorCode:String(error?.message||error)});
    }
  }
  throw last;
}
export async function crossAuthorityHandshakeDigest(dataOps, orderQ) {
  return canonicalSha256([dataOps.tokenDigest,dataOps.inventoryKeyDigest,dataOps.perKeyCutoffDigest,orderQ.tokenDigest,orderQ.movementManifestDigest,orderQ.ledgerUpperBound]);
}
