import assert from 'node:assert/strict';
import { validateMovementManifest } from '../orderq/situation-analysis.js';

const rows=[
  {movementId:'M101',effectKey:'E101',ledgerSequence:101,signedBaseQuantity:3},
  {movementId:'M103',effectKey:'E103',ledgerSequence:103,signedBaseQuantity:-1}
];
const manifest={movementIds:['M101','M103'],movementCount:2};
assert.equal(validateMovementManifest(manifest,rows).rows.length,2,'global sequence 102 is irrelevant');
assert.equal(validateMovementManifest(manifest,[...rows,{...rows[1]}]).transportDuplicateCount,1);
assert.throws(()=>validateMovementManifest(manifest,[rows[0]]),/SITUATION_MOVEMENT_MANIFEST_INCOMPLETE/);
assert.throws(()=>validateMovementManifest(manifest,[...rows,{...rows[1],signedBaseQuantity:-2}]),/SITUATION_MOVEMENT_IDEMPOTENCY_CONFLICT/);
console.log('PASS stage5 pinned movement manifest');
