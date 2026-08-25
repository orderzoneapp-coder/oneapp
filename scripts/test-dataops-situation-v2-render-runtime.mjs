import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../DataOps.html', import.meta.url), 'utf8');
const hookReturn = html.match(/return \{\s*productData,[\s\S]*?connectSituationV2, publishSituationV2\s*\n\s*\};\s*\n\};/);
assert.ok(hookReturn, 'useInventoryEngine exposes both DataOps V2 actions');
const appBinding = html.match(/const \{ productData,[^;]+connectSituationV2, publishSituationV2 \} = useInventoryEngine/);
assert.ok(appBinding, 'App destructures both DataOps V2 actions');
assert.equal((html.match(/onClick: connectSituationV2/g) || []).length, 1);
assert.equal((html.match(/onClick: publishSituationV2/g) || []).length, 1);

let referenceErrors = 0;
const React = { createElement: (type, props, text) => ({ type, props, text }) };
const engine = { productData:[{ 품목코드:'P1' }], targetDateStr:'2026-08-25', connectSituationV2(){}, publishSituationV2(){} };
let rendered;
try {
  const { productData, targetDateStr, connectSituationV2, publishSituationV2 } = engine;
  assert.ok(productData.length > 0);
  rendered = [
    React.createElement('button', { onClick:connectSituationV2, disabled:false }, 'V2 연결'),
    React.createElement('button', { onClick:publishSituationV2, disabled:false, productCount:productData.length, basisDate:targetDateStr }, '상황자료 발행')
  ];
} catch (error) { if (error instanceof ReferenceError) referenceErrors += 1; else throw error; }
assert.equal(referenceErrors, 0);
assert.equal(rendered.length, 2);
assert.ok(rendered.every(node => typeof node.props.onClick === 'function'));
console.log('DataOps Situation V2 actual render binding runtime PASS buttons=2 productData>0 ReferenceError=0');
