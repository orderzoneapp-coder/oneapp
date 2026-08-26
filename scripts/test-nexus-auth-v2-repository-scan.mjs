#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ignoredDirectories = new Set(['.git', 'node_modules']);
const textExtensions = new Set(['.css', '.gs', '.html', '.js', '.json', '.md', '.mjs', '.txt', '.yml', '.yaml']);

function walk(directory, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, output);
    else if (textExtensions.has(path.extname(entry.name).toLowerCase())) output.push(absolute);
  }
  return output;
}

const files = walk(root);
const relative = absolute => path.relative(root, absolute).replaceAll('\\', '/');
const sources = files.map(absolute => ({ absolute, relative: relative(absolute), source: fs.readFileSync(absolute, 'utf8') }));
const findings = (pattern, selected = sources) => selected
  .filter(item => pattern.test(item.source))
  .map(item => item.relative);

const directAppsScriptUrl = new RegExp('script' + '\\.google\\.com/macros/s', 'i');
const deployedIdLiteral = new RegExp('AK' + 'fy[A-Za-z0-9_-]{20,}');
const hiddenCredentialInput = new RegExp("<" + "input[^>]+(?:id|name)=[\\\"'][^\\\"']*(?:token|credential)[^\\\"']*[\\\"'][^>]*>", 'i');
const hardCodedCredential = new RegExp("(?:token|credential)\\s*[:=]\\s*[\\\"'][A-Za-z0-9_-]{24,}[\\\"']", 'i');
const syntheticSecretMarker = new RegExp('(?:fake|dummy|placeholder|test)[ _-]?' + '(?:token|credential)', 'i');

const urlLocations = findings(directAppsScriptUrl);
const classifiedUrlLocations = new Set([
  'app-manifest.json',
  'archive/DataOps.html',
  'archive/MerchOps.html',
  'archive/SKU_Sync.html',
  'nexus/common/nexus-auth-config.js',
  'nexus/server/nexus-auth-gateway.gs',
  'nexus/server/README.md',
  'scripts/test-orderops-operations-improvements.mjs'
]);
assert.deepEqual(urlLocations.filter(location => !classifiedUrlLocations.has(location)), [],
  'every Apps Script URL in the entire repository must be explicitly classified');
const deployedIdLocations = findings(deployedIdLiteral);
const classifiedDeploymentIdentityLocations = new Set([
  ...classifiedUrlLocations,
  'dataops/close-ui.js',
  'dataops/v1-security-client.js',
  'DataOps_situation_v2.js',
  'orderq/dataops-close-cloud-adapter.js',
  'orderq/orderq-situation-cloud-adapter.js',
  'orderq/orderq-v16-contracts.js',
  'scripts/test-dataops-situation-v2-producer.mjs',
  'scripts/test-dataops-stage6-close-ui-product-path.mjs',
  'scripts/test-dataops-stage6-db-v16.mjs',
  'scripts/test-dataops-stage6-security-cutover.mjs',
  'scripts/test-orderq-stage5-cloud-contract.mjs',
  'smartinput/purchase-official-stage3.js',
  'smartinput/sale-official-stage4.js'
]);
assert.deepEqual(deployedIdLocations.filter(location => !classifiedDeploymentIdentityLocations.has(location)), [],
  'every hard-coded deployment id in the entire repository must be explicitly classified');
assert.deepEqual(findings(hiddenCredentialInput), [], 'repository must not contain browser token/credential inputs');
assert.deepEqual(findings(hardCodedCredential), [], 'repository must not contain hard-coded credential literals');
assert.deepEqual(findings(syntheticSecretMarker), [], 'repository must not contain synthetic secret markers');

const runtimeBrowserSources = sources.filter(item =>
  /\.(?:html|js)$/.test(item.relative)
  && !item.relative.startsWith('scripts/')
  && !item.relative.startsWith('archive/')
);
const runtimeBrowserUrlLocations = findings(directAppsScriptUrl, runtimeBrowserSources);
assert.deepEqual(runtimeBrowserUrlLocations, ['nexus/common/nexus-auth-config.js'],
  'the only runtime browser Apps Script URL may be the shared NEXUS Gateway endpoint');
const directFetch = new RegExp('\\b' + 'fetch\\s*\\(');
const persistedCredential = new RegExp('(?:localStorage|sessionStorage)\\.setItem\\([^\\n]*(?:token|credential)', 'i');
assert.deepEqual(findings(directFetch, runtimeBrowserSources), [], 'runtime browser source must use the Gateway instead of direct fetch');
assert.deepEqual(findings(persistedCredential, runtimeBrowserSources), [], 'runtime browser source must not persist credentials');

console.log(`NEXUS_AUTH_V2 repository scan passed (${sources.length} text files, ${runtimeBrowserSources.length} runtime browser files, ${urlLocations.length} classified URL locations).`);
