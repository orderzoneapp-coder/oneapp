import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile('nexus/session-bridge.js', 'utf8');
const handlers = new Map();
const messages = new Map();
let claimed = false;
let skippedWaiting = false;

const makeClient = (id, path) => ({
  id,
  url: `https://oneapp.orderz.co.kr${path}`,
  postMessage(message) {
    if (!messages.has(id)) messages.set(id, []);
    messages.get(id).push(message);
  },
});

const homeA = makeClient('home-a', '/nexus/');
const homeB = makeClient('home-b', '/nexus/');
const outside = makeClient('outside', '/Master.html');
const clients = [homeA, homeB, outside];

const context = vm.createContext({
  URL,
  console,
  self: {
    location: { origin: 'https://oneapp.orderz.co.kr' },
    addEventListener(type, handler) { handlers.set(type, handler); },
    skipWaiting: async () => { skippedWaiting = true; },
    clients: {
      claim: async () => { claimed = true; },
      matchAll: async () => clients,
      get: async (id) => clients.find((client) => client.id === id),
    },
  },
});
vm.runInContext(source, context, { filename: 'nexus/session-bridge.js' });

const dispatchLifecycle = async (type) => {
  const waits = [];
  handlers.get(type)({ waitUntil(promise) { waits.push(Promise.resolve(promise)); } });
  await Promise.all(waits);
};

const dispatchMessage = async (sourceClient, data) => {
  const waits = [];
  handlers.get('message')({ source: sourceClient, data, waitUntil(promise) { waits.push(Promise.resolve(promise)); } });
  await Promise.all(waits);
};

const bundle = {
  token: 'SESSION-A',
  session: {
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    user: { userId: 'USR-1', displayName: '관리자', role: 'OWNER_MASTER' },
  },
};

await dispatchLifecycle('install');
await dispatchLifecycle('activate');
assert.equal(skippedWaiting, true, 'new bridge version must activate without leaving an obsolete worker waiting');
assert.equal(claimed, true, 'bridge must claim existing /nexus/ clients after activation');
assert.equal(handlers.has('fetch'), false, 'session bridge must never intercept application traffic');

await dispatchMessage(homeA, { type: 'NEXUS_SESSION_PUBLISH', bundle });
assert.equal(messages.get('home-b')?.at(-1)?.type, 'NEXUS_SESSION_UPDATED', 'login must update another NEXUS window');
assert.equal(messages.has('outside'), false, 'clients outside /nexus/ must not receive a session');

messages.clear();
await dispatchMessage(homeB, { type: 'NEXUS_SESSION_REQUEST', requestId: 'request-1' });
assert.equal(messages.get('home-b')?.at(-1)?.type, 'NEXUS_SESSION_RESPONSE', 'new NEXUS window must receive the active session');
assert.equal(messages.get('home-b')?.at(-1)?.bundle?.token, bundle.token);

messages.clear();
await dispatchMessage(homeA, { type: 'NEXUS_SESSION_CLEAR', token: 'STALE-SESSION' });
assert.equal(messages.size, 0, 'a stale window must not clear a newer shared session');

await dispatchMessage(homeA, { type: 'NEXUS_SESSION_CLEAR', token: bundle.token });
assert.equal(messages.get('home-b')?.at(-1)?.type, 'NEXUS_SESSION_CLEARED', 'logout must clear the same session in another NEXUS window');

messages.clear();
await dispatchMessage(outside, { type: 'NEXUS_SESSION_REQUEST', requestId: 'outside-request' });
assert.equal(messages.size, 0, 'a page outside /nexus/ must not query the session bridge');

assert.doesNotMatch(source, /addEventListener\(['"]fetch|\bcaches\b|localStorage|indexedDB|document\.cookie/);
console.log('NEXUS cross-tab in-memory session bridge contracts passed.');
