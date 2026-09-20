import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const separator = value.indexOf('=');
  assert.ok(separator > 0, 'Use --name=value arguments');
  return [value.slice(0, separator), value.slice(separator + 1)];
}));
const git = (...values) => execFileSync('git', values, { cwd: root, encoding: 'utf8' }).trim();
const expected = git('rev-parse', args['--commit'] || 'HEAD');
const base = args['--base'];
assert.ok(base, '--base is required');
const origin = new URL(args['--origin'] || 'https://oneapp.orderz.co.kr/');
const output = resolve(root, args['--output'] || 'evidence/si-boundary-20260920-01/deployed-assets.json');
const paths = git('diff', '--name-only', '--diff-filter=ACMR', `${base}..${expected}`, '--', 'smartinput', 'orderq')
  .split(/\r?\n/).filter(path => /\.(?:html|js|css)$/.test(path));
assert.ok(paths.includes('smartinput/smartinput.js'), 'Expected SmartInput deployment assets');
const sha256 = text => createHash('sha256').update(text).digest('hex');
const report = { taskId: 'SI-BOUNDARY-20260920-01', recordedAt: new Date().toISOString(), origin: origin.href,
  expectedCommit: expected, comparison: 'Remote response bytes compared with exact committed Git blob bytes', assets: [] };
for (let offset = 0; offset < paths.length; offset += 5) {
  const results = await Promise.all(paths.slice(offset, offset + 5).map(async path => {
    const expectedBytes = execFileSync('git', ['show', `${expected}:${path}`], { cwd: root });
    const url = new URL(path, origin);
    url.searchParams.set('si_verify', expected.slice(0, 12));
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), cache: 'no-store' });
    const actualBytes = Buffer.from(await response.arrayBuffer());
    return { path, status: response.status, expectedSha256: sha256(expectedBytes), deployedSha256: sha256(actualBytes),
      bytes: actualBytes.length, match: response.ok && expectedBytes.equals(actualBytes) };
  }));
  report.assets.push(...results);
}
report.status = report.assets.every(asset => asset.match) ? 'PASS' : 'FAIL';
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, expectedCommit: expected, assets: report.assets.length,
  mismatches: report.assets.filter(asset => !asset.match), output }, null, 2));
assert.equal(report.status, 'PASS', 'Deployed assets must match the expected commit');
