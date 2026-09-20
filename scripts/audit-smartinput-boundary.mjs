import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase = process.argv[2] || 'after';
if (!['before', 'after'].includes(phase)) throw new Error('phase must be before or after');
const files = fs.readdirSync(path.join(root, 'smartinput')).filter(name => /\.(js|css|html)$/.test(name));
const records = files.map(name => {
  const relative = `smartinput/${name}`;
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  const imports = [...source.matchAll(/(?:^|\n)\s*(?:import\s+(?:(?:[^;]*?)\s+from\s+)?|export\s+[^;]*?\s+from\s+)['"]([^'"]+)['"]/g)].map(match => match[1]);
  return { path: relative, bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'), lines: source.split('\n').length, imports };
});
const seen = new Set();
const visit = relative => {
  if (seen.has(relative)) return;
  seen.add(relative);
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) throw new Error(`Missing initial dependency: ${relative}`);
  const source = fs.readFileSync(absolute, 'utf8');
  const dependencies = [...source.matchAll(/(?:^|\n)\s*(?:import\s+(?:(?:[^;]*?)\s+from\s+)?|export\s+[^;]*?\s+from\s+)['"]([^'"]+)['"]/g)].map(match => match[1]);
  for (const dependency of dependencies) {
    if (dependency.startsWith('.')) visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), dependency.split('?')[0])));
  }
};
visit('smartinput/smartinput.js');
const result = {
  taskId: 'SI-BOUNDARY-20260920-01', phase,
  sourceFileCount: records.length,
  javascriptCount: records.filter(record => record.path.endsWith('.js')).length,
  initialStaticModuleCount: seen.size,
  initialStaticBytes: [...seen].reduce((total, relative) => total + fs.statSync(path.join(root, relative)).size, 0),
  initialStaticModules: [...seen].sort(),
  files: records
};
const output = path.join(root, 'evidence/si-boundary-20260920-01', `${phase}-source-structure.json`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ output, javascriptCount: result.javascriptCount, initialStaticModuleCount: result.initialStaticModuleCount, initialStaticBytes: result.initialStaticBytes }));
