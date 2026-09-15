import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function readMasterContractSource(root) {
  return [
    readFileSync(join(root, 'Master.html'), 'utf8'),
    readFileSync(join(root, 'master', 'master-app.jsx'), 'utf8')
  ].join('\n');
}
