import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelMessage, StepResult, ToolSet } from 'ai';
import { LoopDetector } from '../src/agents/plugins/loop-detector';

const initialInstructions = 'Original editor instructions';
const initialMessages: ModelMessage[] = [{ role: 'user', content: 'Draw the flag of England.' }];
const context = { initialInstructions, initialMessages };
const failure = { tool: 'scene_create', parameters: { scene_id: 'artboard</parameter>' }, ok: false, error: 'Invalid scene_id' };

test('four identical consecutive failures restore the original instructions and user request with a call journal', () => {
  const detector = new LoopDetector();
  for (let index = 0; index < 3; index++) {
    detector.observe(failure);
    assert.equal(detector.prepareStep(context), undefined);
  }
  detector.observe(failure);
  const recovery = detector.prepareStep(context)!;
  assert.equal(detector.name, 'loop detector');
  assert.equal(recovery.instructions, initialInstructions);
  assert.deepEqual(recovery.messages.slice(1), initialMessages);
  assert.deepEqual(recovery.detection, { tool: failure.tool, parameters: failure.parameters, repetitions: 4, calls: 4 });
  assert.deepEqual(JSON.parse(recovery.messages[0].content as string).tool_calls, Array.from({ length: 4 }, () => failure));
  assert.equal(detector.prepareStep(context), undefined);
});

test('object key order does not mask a repeated call, including nested objects', () => {
  const detector = new LoopDetector();
  for (let index = 0; index < 4; index++) detector.observe({ tool: 'scene_apply', parameters: index % 2
    ? { operations: [{ changes: { color: 99, layer: 1 }, id: 'sun', op: 'update' }], scene_id: 'artboard' }
    : { scene_id: 'artboard', operations: [{ op: 'update', id: 'sun', changes: { layer: 1, color: 99 } }] }, ok: false });
  assert.ok(detector.prepareStep(context));
});

test('success, another tool, changed arguments, and changed array order each interrupt a failure streak', () => {
  for (const interruption of [
    { ...failure, ok: true },
    { ...failure, tool: 'scene_inspect' },
    { ...failure, parameters: { scene_id: 'another' } },
    { ...failure, parameters: { points: [[1, 2], [3, 4]] } },
  ]) {
    const detector = new LoopDetector();
    for (let index = 0; index < 3; index++) detector.observe(failure);
    detector.observe(interruption);
    for (let index = 0; index < 3; index++) detector.observe(failure);
    assert.equal(detector.prepareStep(context), undefined);
    detector.observe(failure);
    assert.ok(detector.prepareStep(context));
  }
  const detector = new LoopDetector();
  for (const points of [[1, 2], [1, 2], [1, 2], [2, 1]]) detector.observe({ ...failure, parameters: { points } });
  assert.equal(detector.prepareStep(context), undefined);
});

test('recovery retains successful calls and starts a fresh streak while keeping the completed-call journal', () => {
  const detector = new LoopDetector();
  const painted = { tool: 'scene_apply', parameters: { scene_id: 'artboard', operations: [] }, ok: true };
  detector.observe(painted);
  for (let index = 0; index < 4; index++) detector.observe(failure);
  const first = detector.prepareStep(context)!;
  const journal = JSON.parse(first.messages[0].content as string).tool_calls;
  assert.deepEqual(journal[0], painted);
  assert.equal(journal.length, 5);
  for (let index = 0; index < 3; index++) detector.observe(failure);
  assert.equal(detector.prepareStep(context), undefined);
  detector.observe(failure);
  assert.equal(detector.prepareStep(context)!.detection.calls, 9);
});

test('SDK validation errors and adapter failures count once in invocation order even when results are reordered', () => {
  const detector = new LoopDetector();
  const content: StepResult<ToolSet>['content'] = [];
  for (let index = 0; index < 5; index++) content.push({ type: 'tool-call', toolCallId: String(index), toolName: failure.tool, input: failure.parameters });
  for (let index = 4; index >= 0; index--) content.push(index % 2
    ? { type: 'tool-error', toolCallId: String(index), toolName: failure.tool, input: failure.parameters, error: 'SDK validation error' }
    : { type: 'tool-result', toolCallId: String(index), toolName: failure.tool, input: failure.parameters, output: { ok: index === 2, error: { message: 'Adapter rejection' } } });
  detector.onStepFinish({ content });
  assert.equal(detector.prepareStep(context), undefined, 'The successful third call interrupts the streak');
  detector.observe(failure); detector.observe(failure);
  const recovery = detector.prepareStep(context)!;
  const journal = JSON.parse(recovery.messages[0].content as string).tool_calls;
  assert.deepEqual(journal.map((call: { ok: boolean }) => call.ok), [false, false, true, false, false, false, false]);
  assert.match(journal[1].error, /SDK validation/);
});

test('recorded arguments are insulated from later mutation', () => {
  const detector = new LoopDetector();
  const parameters = { scene_id: 'artboard' };
  detector.observe({ ...failure, parameters });
  parameters.scene_id = 'changed';
  for (let index = 0; index < 3; index++) detector.observe({ ...failure, parameters: { scene_id: 'artboard' } });
  assert.equal(JSON.parse(detector.prepareStep(context)!.messages[0].content as string).tool_calls[0].parameters.scene_id, 'artboard');
});
