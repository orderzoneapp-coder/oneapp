#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SMARTINPUT_RUNTIME_ASSETS = Object.freeze([
  { id: 'smartinput-contract', path: 'smartinput/smartinput-contract.js', pattern: /(\.\/smartinput-contract\.js\?v=)[A-Za-z0-9._-]+/g },
  { id: 'smartinput-js', path: 'smartinput/smartinput.js', pattern: /(\.\/smartinput\.js\?v=)[A-Za-z0-9._-]+/g },
  { id: 'smartinput-css', path: 'smartinput/smartinput.css', pattern: /(\.\/smartinput\.css\?v=)[A-Za-z0-9._-]+/g },
  { id: 'source-preparation-ui-v2', path: 'smartinput/source-preparation-ui-v2.js', pattern: /(\.\/source-preparation-ui-v2\.js\?v=)[A-Za-z0-9._-]+/g }
]);

export function fileFingerprint(absolutePath) {
  const normalized = readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

export function computeSmartInputAssetSet(base = root) {
  const assets = SMARTINPUT_RUNTIME_ASSETS.map(asset => {
    const absolute = join(base, asset.path);
    const fingerprint = fileFingerprint(absolute);
    return { ...asset, fingerprint, absolute };
  });
  const composite = createHash('sha256')
    .update(assets.map(asset => `${asset.id}:${asset.fingerprint}`).sort().join('|'))
    .digest('hex')
    .slice(0, 12);
  return {
    assetSchema: 'ONEAPP_SMARTINPUT_ASSET_SET_V1',
    buildId: `SI-${composite}`,
    assets
  };
}

export function applySmartInputAssetFingerprints(html, assetSet = computeSmartInputAssetSet()) {
  let next = String(html);
  for (const asset of assetSet.assets) {
    const matches = next.match(asset.pattern) || [];
    if (matches.length < 1) throw new Error(`missing asset reference: ${asset.path}`);
    next = next.replace(asset.pattern, `$1${asset.fingerprint}`);
  }

  const buildMeta = `<meta name="oneapp-smartinput-build" content="${assetSet.buildId}">`;
  if (/<meta\s+name="oneapp-smartinput-build"[^>]*>/i.test(next)) {
    next = next.replace(/<meta\s+name="oneapp-smartinput-build"[^>]*>/i, buildMeta);
  } else {
    next = next.replace(/<meta name="google" content="notranslate">/, match => `${match}\n  ${buildMeta}`);
  }

  const bootScript = `<script>
    window.ONEAPP_SMARTINPUT_BUILD_INFO = Object.freeze({
      buildId: ${JSON.stringify(assetSet.buildId)},
      assetSchema: ${JSON.stringify(assetSet.assetSchema)}
    });
    document.documentElement.dataset.smartinputBuild = ${JSON.stringify(assetSet.buildId)};
  </script>`;
  if (/window\.ONEAPP_SMARTINPUT_BUILD_INFO\s*=/.test(next)) {
    next = next.replace(/<script>\s*window\.ONEAPP_SMARTINPUT_BUILD_INFO[\s\S]*?<\/script>/, bootScript);
  } else {
    next = next.replace(/<script src="\.\/smartinput-contract\.js\?v=[^"]+"><\/script>/, match => `${bootScript}\n  ${match}`);
  }
  return { html: next, assetSet };
}

export function updateSmartInputAssetFingerprints(base = root) {
  const target = join(base, 'smartinput/index.html');
  const before = readFileSync(target, 'utf8');
  const { html, assetSet } = applySmartInputAssetFingerprints(before, computeSmartInputAssetSet(base));
  const normalized = html.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  writeFileSync(target, normalized);
  return { changed: before.replace(/\r\n/g, '\n').replace(/\r/g, '\n') !== normalized, assetSet };
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const result = updateSmartInputAssetFingerprints();
  console.log(JSON.stringify({
    changed: result.changed,
    buildId: result.assetSet.buildId,
    assets: Object.fromEntries(result.assetSet.assets.map(asset => [asset.id, asset.fingerprint]))
  }, null, 2));
}
