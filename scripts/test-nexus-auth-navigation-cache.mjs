#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const client = read('nexus/common/nexus-auth.js');
const server = read('nexus/server/nexus-auth-gateway.gs');
const header = read('nexus/common/nexus-top.js');
const dataOps = read('DataOps.html');
const oneapp = read('code.gs');

assert.match(client, /const VERSION = '2\.1\.1'/);
assert.match(client, /CONTEXT_REFRESH_LEAD_MS = 90 \* 1000/);
assert.match(client, /refreshIfNeeded/);
assert.match(client, /oneapp\.nexus\.auth\.bundle\.v2/);
assert.match(client, /sessionStorage\.setItem\(SESSION_BUNDLE_KEY/);
assert.doesNotMatch(client, /localStorage\.(?:setItem|getItem)[\s\S]{0,120}(?:sessionToken|SESSION_BUNDLE_KEY)/,
  'shared app navigation cache must remain tab-scoped and must not persist a session token in localStorage');
assert.match(client, /let sessionRefreshPromise = null/);
assert.match(client, /if \(sessionRefreshPromise\) return sessionRefreshPromise/,
  'identical session validation calls must collapse into one in-flight Promise');
assert.match(client, /const appContextPromises = new Map\(\)/);
assert.doesNotMatch(client, /nexusAuthGate|gateMessage|NEXUS 보안 세션 확인 중/,
  'the second full-screen security-session loader must not exist');

assert.match(server, /NEXUS_AUTH_SESSION_CONTEXT_VERSION = 'NEXUS_SESSION_CONTEXT_V1'/);
assert.match(server, /NEXUS_AUTH_CLIENT_CONTEXT_TTL_MS = 5 \* 60 \* 1000/);
assert.match(server, /sessionContextToken: encoded \+ '\.' \+ nexusAuthHmac_/);
assert.match(server, /appContexts: appContexts/);
assert.match(server, /nexus_auth_session'\) return nexusAuthIssueClientBundle_/);

assert.match(header, /NAVIGATION_COVER_DELAY_MS = 300/);
assert.match(header, /scheduleNavigationCover\(label, mode, marker\.startedAt\)/);
assert.doesNotMatch(header, /Math\.max\(0, 420|\}, 80\);/,
  'navigation must have neither a minimum loader duration nor a delay before location change');
assert.match(header, /link\.rel = 'prefetch'/);
assert.match(header, /resolved\.origin !== location\.origin/,
  'only same-origin static app documents may be prefetched');

assert.match(dataOps, /DELIVERY_KEY: 'cloud-delivery'/);
assert.match(dataOps, /status: 'PENDING'/);
assert.match(dataOps, /status: 'DELIVERED'/);
assert.match(dataOps, /if \(loader\)\s*loader\.remove\(\)/,
  'the first app loader must disappear immediately when the React screen is ready');
assert.match(oneapp, /current\.hash === validated\.hash/);
assert.match(oneapp, /return \{ \.\.\.current, duplicate: true \}/,
  'retrying an identical pending snapshot must not create another cloud commit');

console.log('NEXUS auth shared-cache, single-loader, delayed-cover and DataOps idempotent retry contract passed.');
