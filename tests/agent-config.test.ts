import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ensureAgentConfig, loadWorkflowConfig, parseWorkflowConfig } from '../src/adapters/server/config';
import { AGENT_ROLES } from '../src/contracts/workflows';

export async function configRoot() {
  const scratch = resolve('.tmp'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(resolve(scratch, 'config-test-'));
  await copyFile(resolve('agents.example.json'), resolve(root, 'agents.example.json'));
  return root;
}
test('startup creates a documented empty configuration exclusively and preserves existing settings', async () => {
  const root = await configRoot();
  await Promise.all([ensureAgentConfig(root), ensureAgentConfig(root)]);
  const file = resolve(root, 'agents.local.json');
  const value = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(value._documentation.connection);
  assert.deepEqual(value.connection, {});
  assert.deepEqual(Object.keys(value.agents).sort(), [...AGENT_ROLES].sort());
  assert.ok(Object.values(value.agents).every(item => (item as { model: string }).model === ''));
  const custom = JSON.stringify({ connection: { editor_model: 'private-model', api_key: 'private-key' }, agents: {} });
  await writeFile(file, custom);
  await ensureAgentConfig(root);
  assert.equal(await readFile(file, 'utf8'), custom);
});

test('local profiles load with environment precedence and reject malformed settings', async () => {
  const root = await configRoot(), file = await ensureAgentConfig(root);
  await writeFile(file, JSON.stringify({ connection: { editor_model: 'local', api_key: 'private' }, agents: { decorator: { model: 'decorator', instructions: 'Private role guidance' } } }));
  const config = await loadWorkflowConfig(root, { AGENT_EDITOR_MODEL: 'environment', AGENT_VISION: 'false', AGENT_MAX_REVIEWS: '2' });
  assert.equal(config.connection!.editor_model, 'environment');
  assert.equal(config.connection!.api_key, 'private');
  assert.equal(config.connection!.vision, false);
  assert.equal(config.connection!.max_reviews, 2);
  assert.equal(config.agents!.decorator!.instructions, 'Private role guidance');
  assert.throws(() => parseWorkflowConfig({ connection: {}, agents: { typo: {} } }), /Unknown agent role/);
  assert.throws(() => parseWorkflowConfig({ connection: { max_reviews: 20 }, agents: {} }), /max_reviews/);
  assert.throws(() => parseWorkflowConfig({ connection: { invalid: true }, agents: {} }), /Unknown connection/);
  assert.throws(() => parseWorkflowConfig({ connection: {}, agents: { artist: { model: 3 } } }), /Invalid model/);
  await assert.rejects(loadWorkflowConfig(root, { AGENT_VISION: 'yes' }), /AGENT_VISION/);
  await writeFile(file, '{broken');
  await assert.rejects(loadWorkflowConfig(root, {}), /Cannot parse/);
});
