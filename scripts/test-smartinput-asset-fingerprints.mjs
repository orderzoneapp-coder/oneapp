#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SMARTINPUT_RUNTIME_ASSETS,
  applySmartInputAssetFingerprints,
  computeSmartInputAssetSet,
  fileFingerprint,
  updateSmartInputAssetFingerprints
} from './update-smartinput-asset-fingerprints.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = join(root, 'smartinput/index.html');
const html = readFileSync(htmlPath, 'utf8');
const assetSet = computeSmartInputAssetSet(root);

assert.match(html, /name="oneapp-smartinput-build" content="SI-[a-f0-9]{12}"/);
assert.match(html, /window\.ONEAPP_SMARTINPUT_BUILD_INFO = Object\.freeze\(\{[\s\S]*buildId: "SI-[a-f0-9]{12}"/);
assert.match(html, /dataset\.smartinputBuild = "SI-[a-f0-9]{12}"/);
assert.equal(html.match(/name="oneapp-smartinput-build"/g)?.length, 1);
assert.equal(html.match(/ONEAPP_SMARTINPUT_BUILD_INFO/g)?.filter(Boolean).length >= 1, true);

const buildId = html.match(/name="oneapp-smartinput-build" content="(SI-[a-f0-9]{12})"/)?.[1];
assert.equal(buildId, assetSet.buildId, 'meta buildId must match composite asset fingerprints');
assert.match(html, new RegExp(`buildId: "${buildId}"`));
assert.match(html, new RegExp(`dataset\\.smartinputBuild = "${buildId}"`));

for (const asset of assetSet.assets) {
  const refs = [...html.matchAll(new RegExp(asset.pattern.source, 'g'))];
  assert.equal(refs.length, asset.id === 'smartinput-js' ? 2 : 1, `${asset.path} must appear with the expected reference count`);
  for (const match of refs) {
    assert.equal(match[0].split('?v=')[1], asset.fingerprint, `${asset.path} query must match SHA-256 prefix`);
  }
  assert.equal(fileFingerprint(asset.absolute), asset.fingerprint);
}

assert.doesNotMatch(html + readFileSync(join(root, 'smartinput/source-preparation-ui-v2.js'), 'utf8')
  + readFileSync(join(root, 'smartinput/smartinput.js'), 'utf8'),
  /준비한 자료 적용|매핑 완료 후 중앙 작업표에 한 번에 반영/);

const fixtureRoot = mkdtempSync(join(tmpdir(), 'smartinput-asset-fp-'));
try {
  mkdirSync(join(fixtureRoot, 'smartinput'), { recursive: true });
  for (const asset of SMARTINPUT_RUNTIME_ASSETS) {
    copyFileSync(join(root, asset.path), join(fixtureRoot, asset.path));
  }
  copyFileSync(htmlPath, join(fixtureRoot, 'smartinput/index.html'));
  const first = updateSmartInputAssetFingerprints(fixtureRoot);
  assert.equal(first.changed, false, 'already fingerprinted HTML must be stable');
  const jsPath = join(fixtureRoot, 'smartinput/smartinput.js');
  writeFileSync(jsPath, `${readFileSync(jsPath, 'utf8')}\n/* fingerprint-change */\n`);
  const second = updateSmartInputAssetFingerprints(fixtureRoot);
  assert.equal(second.changed, true, 'content change must rewrite fingerprints');
  const third = updateSmartInputAssetFingerprints(fixtureRoot);
  assert.equal(third.changed, false, 'second update must be deterministic with no diff');
  const mutatedHtml = readFileSync(join(fixtureRoot, 'smartinput/index.html'), 'utf8');
  const expected = fileFingerprint(jsPath);
  assert.match(mutatedHtml, new RegExp(`smartinput\\.js\\?v=${expected}`));
  assert.notEqual(second.assetSet.buildId, assetSet.buildId);

  const stale = applySmartInputAssetFingerprints(mutatedHtml, assetSet);
  assert.notEqual(stale.html, mutatedHtml, 'stale fingerprints must fail a content match');
  const staleJs = [...stale.html.matchAll(/\.\/smartinput\.js\?v=([A-Za-z0-9._-]+)/g)].map(match => match[1]);
  assert.ok(staleJs.every(value => value !== expected), 'old fingerprint must not match changed bytes');
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log(`SmartInput asset fingerprint contracts PASS (${assetSet.buildId})`);
