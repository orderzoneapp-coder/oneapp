'use strict';

const MESSAGE = Object.freeze({
  PUBLISH: 'NEXUS_SESSION_PUBLISH',
  REQUEST: 'NEXUS_SESSION_REQUEST',
  NEEDED: 'NEXUS_SESSION_NEEDED',
  RESPONSE: 'NEXUS_SESSION_RESPONSE',
  UPDATED: 'NEXUS_SESSION_UPDATED',
  CLEAR: 'NEXUS_SESSION_CLEAR',
  CLEARED: 'NEXUS_SESSION_CLEARED',
});
const NEXUS_PATH_PREFIX = '/nexus/';
const REQUEST_TTL_MS = 5000;

let currentBundle = null;
const pendingRequests = new Map();

const nexusClient = (client) => {
  if (!client?.id || !client?.url) return false;
  try {
    const url = new URL(client.url);
    return url.origin === self.location.origin && url.pathname.startsWith(NEXUS_PATH_PREFIX);
  } catch {
    return false;
  }
};

const normalizeBundle = (bundle) => {
  const token = String(bundle?.token ?? '').trim();
  const session = bundle?.session;
  const expiresAt = Date.parse(session?.expiresAt || '');
  if (!token || token.length > 4096 || !session?.user || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
  return { token, session };
};

const bundleExpiry = (bundle) => Date.parse(bundle?.session?.expiresAt || '') || 0;

const liveBundle = () => {
  const normalized = normalizeBundle(currentBundle);
  if (!normalized) currentBundle = null;
  return normalized;
};

const rememberBundle = (bundle) => {
  const incoming = normalizeBundle(bundle);
  if (!incoming) return liveBundle();
  const existing = liveBundle();
  if (!existing || existing.token === incoming.token || bundleExpiry(incoming) >= bundleExpiry(existing)) {
    currentBundle = incoming;
  }
  return liveBundle();
};

const nexusClients = async () => (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
  .filter(nexusClient);

const broadcast = async (message, exceptClientId = '') => {
  const clients = await nexusClients();
  clients.forEach((client) => {
    if (client.id !== exceptClientId) client.postMessage(message);
  });
};

const prunePending = () => {
  const now = Date.now();
  pendingRequests.forEach((pending, requestId) => {
    if (pending.expiresAt <= now) pendingRequests.delete(requestId);
  });
};

const handleMessage = async (event) => {
  const source = event.source;
  const message = event.data || {};
  if (!nexusClient(source)) return;
  prunePending();

  if (message.type === MESSAGE.PUBLISH) {
    const incoming = normalizeBundle(message.bundle);
    const previous = liveBundle();
    const remembered = rememberBundle(incoming);
    if (!remembered) return;
    if (previous && remembered.token !== incoming?.token) {
      source.postMessage({ type: MESSAGE.UPDATED, bundle: remembered });
      return;
    }
    await broadcast({ type: MESSAGE.UPDATED, bundle: remembered }, source.id);
    return;
  }

  if (message.type === MESSAGE.REQUEST) {
    const requestId = String(message.requestId || '').slice(0, 120);
    if (!requestId) return;
    const remembered = liveBundle();
    if (remembered) {
      source.postMessage({ type: MESSAGE.RESPONSE, requestId, bundle: remembered });
      return;
    }
    pendingRequests.set(requestId, { clientId: source.id, expiresAt: Date.now() + REQUEST_TTL_MS });
    await broadcast({ type: MESSAGE.NEEDED, requestId }, source.id);
    return;
  }

  if (message.type === MESSAGE.RESPONSE) {
    const requestId = String(message.requestId || '').slice(0, 120);
    const pending = pendingRequests.get(requestId);
    if (!pending) return;
    const remembered = rememberBundle(message.bundle);
    if (!remembered) return;
    const requester = await self.clients.get(pending.clientId);
    pendingRequests.delete(requestId);
    if (nexusClient(requester)) requester.postMessage({ type: MESSAGE.RESPONSE, requestId, bundle: remembered });
    return;
  }

  if (message.type === MESSAGE.CLEAR) {
    const token = String(message.token || '').trim();
    const remembered = liveBundle();
    if (!token || !remembered || remembered.token !== token) return;
    currentBundle = null;
    await broadcast({ type: MESSAGE.CLEARED, token }, source.id);
  }
};

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  event.waitUntil(handleMessage(event));
});
