import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityText, thinkingLabel, TimedLog, type Activity, type Schedule } from '../src/ui/timed-log';

function clock() {
  let time = 0;
  const timers: { at: number; callback: () => void; cancelled: boolean }[] = [];
  const schedule: Schedule = (callback, delay) => {
    const item = { at: time + delay, callback, cancelled: false }; timers.push(item);
    return () => { item.cancelled = true; };
  };
  const advance = (milliseconds: number) => {
    const end = time + milliseconds;
    while (true) {
      const item = timers.filter(value => !value.cancelled && value.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!item) break;
      time = item.at; item.cancelled = true; item.callback();
    }
    time = end;
  };
  return { schedule, advance, now: () => time };
}
test('bursts of tools and thinking wait in order with a full second per entry', () => {
  const timer = clock(), shown: { activity: Activity; at: number }[] = [];
  const log = new TimedLog(activity => shown.push({ activity, at: timer.now() }), timer.schedule);
  log.enqueue({ kind: 'Tools', text: 'scene_create {}' });
  log.enqueue({ kind: 'Thinking', text: 'Paint the background first.' });
  log.enqueue({ kind: 'Tools', text: 'scene_apply {operations: []}' });
  assert.equal(shown.length, 1);
  timer.advance(999); assert.equal(shown.length, 1);
  timer.advance(1); assert.equal(shown[1].activity.kind, 'Thinking');
  timer.advance(999); assert.equal(shown.length, 2);
  timer.advance(1); assert.equal(shown[2].activity.kind, 'Tools');
  assert.deepEqual(shown.map(item => item.at), [0, 1000, 2000]);
  timer.advance(10000); assert.equal(shown.length, 3);
});
test('reset cancels old queued entries and later idle activity gets its own full second', () => {
  const timer = clock(), shown: string[] = [];
  const log = new TimedLog(item => shown.push(item.text), timer.schedule);
  log.enqueue({ kind: 'Tools', text: 'old' }); log.enqueue({ kind: 'Thinking', text: 'stale' });
  timer.advance(300); log.reset();
  log.enqueue({ kind: 'Tools', text: 'new' });
  timer.advance(1000);
  log.enqueue({ kind: 'Thinking', text: 'idle' });
  log.enqueue({ kind: 'Tools', text: 'next' });
  timer.advance(999); assert.deepEqual(shown, ['old', 'new', 'idle']);
  timer.advance(1); assert.deepEqual(shown, ['old', 'new', 'idle', 'next']);
});

test('each queued thought keeps its own token count and a full second of visibility', () => {
  const timer = clock(), shown: string[] = [];
  const log = new TimedLog(item => shown.push(activityText(item)), timer.schedule);
  log.enqueue({ kind: 'Thinking', text: 'First block', tokens: 123, tokens_estimated: false });
  log.enqueue({ kind: 'Tools', text: 'scene_apply {}' });
  log.enqueue({ kind: 'Thinking', text: 'Correction block', tokens: 45, tokens_estimated: true });
  assert.deepEqual(shown, ['Thinking: First block']);
  timer.advance(999); assert.equal(shown.length, 1);
  timer.advance(1); assert.equal(shown[1], 'scene_apply {}');
  timer.advance(1000); assert.equal(shown[2], 'Thinking: Correction block');
  assert.equal(activityText({ kind: 'Thinking', text: '', tokens: 64 }), 'Thinking');
  assert.equal(activityText({ kind: 'Thinking', text: 'No usage provided' }), 'Thinking: No usage provided');
  assert.equal(thinkingLabel(64), 'Thinking (64 tokens)');
  assert.equal(thinkingLabel(45, true), 'Thinking (~45 tokens)');
});

test('stream deltas update their current or queued entry without restarting its second or duplicating it', () => {
  const timer = clock(), shown: { text: string; time: number }[] = [];
  const log = new TimedLog(item => shown.push({ text: activityText(item), time: timer.now() }), timer.schedule);
  log.enqueue({ id: 'thought', kind: 'Thinking', text: 'Plan', tokens: 1, tokens_estimated: true });
  timer.advance(300);
  log.enqueue({ id: 'thought', kind: 'Thinking', text: 'Plan the scene', tokens: 4, tokens_estimated: true });
  log.enqueue({ id: 'call', kind: 'Tools', text: 'scene_apply {"operations":' });
  log.enqueue({ id: 'call', kind: 'Tools', text: 'scene_apply {"operations":[]}' });
  timer.advance(699); assert.equal(shown.length, 2);
  timer.advance(1); assert.deepEqual(shown.at(-1), { text: 'scene_apply {"operations":[]}', time: 1000 });
  log.enqueue({ id: 'thought', kind: 'Thinking', text: 'Plan the scene', tokens: 7 });
  log.enqueue({ id: 'next', kind: 'Tools', text: 'scene_render {}' });
  timer.advance(999); assert.equal(shown.length, 3);
  timer.advance(1); assert.deepEqual(shown.at(-1), { text: 'scene_render {}', time: 2000 });
  timer.advance(10000); assert.equal(shown.length, 4);
});
