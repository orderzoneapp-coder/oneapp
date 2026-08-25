import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html=await readFile(new URL('../orderq/operations.html',import.meta.url),'utf8');
const count=token=>(html.match(new RegExp(token,'g'))||[]).length;
assert.equal(count('id="currentSituationBtn"'),1);
assert.equal(count('data-situation-dashboard="single"'),1);
assert.equal(count('attachSituationUi\\('),1);
assert.doesNotMatch(html,/orders\.html/);
assert.match(html,/현재상황 불러오기/);
assert.match(html,/currentDashboardMode\s*=\s*'OFFICIAL_SITUATION'/);
assert.match(html,/currentDashboardMode\s*===\s*'OFFICIAL_SITUATION'/);
assert.equal(count('data-situation-dashboard="single"'),1);
const runtime=await readFile(new URL('../orderq/situation-runtime.js',import.meta.url),'utf8');
assert.match(runtime,/ephemeralDataOpsCredential/);
assert.doesNotMatch(runtime,/localStorage|sessionStorage/);
console.log('PASS stage5 single ORDER Q entrypoint');
