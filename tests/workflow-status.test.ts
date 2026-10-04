import assert from 'node:assert/strict';
import { test } from 'node:test';
import { phaseStatus, stageStatus } from '../src/ui/workflow-status';

for (const total of [2, 3, 4, 5, 6, 7]) test(`workflow ${total} counts the independent reviewer as its last step`, () => {
  assert.equal(stageStatus('Artist', 1, total), `Creating the scene (1/${total}).`);
  assert.equal(stageStatus('Final integrator', total - 1, total), `Integrating lighting, color and layers (${total - 1}/${total}).`);
  assert.equal(phaseStatus('reviewer', 1, total), `Validating the scene (${total}/${total}, review 1).`);
  assert.equal(phaseStatus('editor', 2, total), `Applying review corrections (${total - 1}/${total}, review 2).`);
  assert.equal(phaseStatus('reviewer', 2, total), `Validating the scene (${total}/${total}, review 2).`);
});

test('the workflow without a reviewer has just one step', () => {
  assert.equal(stageStatus('Artist', 1, 1), 'Creating the scene (1/1).');
});
