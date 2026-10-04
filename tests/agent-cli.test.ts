import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mockModel } from './fixtures/model';

test('CLI uses shared local configuration, selected stages and writes reviewed artifacts', async () => {
  await mkdir(resolve('.tmp'), { recursive: true });
  const directory = await mkdtemp(resolve('.tmp', 'cli-test-'));
  const model = mockModel();
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk.toString();
    const result = await model.fetcher(`http://localhost${request.url}`, { body });
    response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(await result.text());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  try {
    const output = resolve(directory, 'artifacts');
    const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/agent.ts', '--layers', '3', 'Scene [reject]'], {
      env: { ...process.env, ARTBOARD_CONFIG_FILE: resolve(directory, 'agents.local.json'), AGENT_OUTPUT_DIR: output,
        AGENT_BASE_URL: `http://127.0.0.1:${address.port}`, AGENT_EDITOR_MODEL: 'test-model', AGENT_REVIEWER_MODEL: 'reviewer-model', AGENT_MAX_REVIEWS: '2', AGENT_VISION: 'true', AGENT_SCENE: '' },
      timeout: 15000,
    });
    assert.match(result.stdout, /Stage 3\/3: Decorator/);
    assert.match(result.stdout, /Approved final/);
    const [runId] = await readdir(resolve(output, 'workflow'));
    const runFolder = resolve(output, 'workflow', runId);
    const workflow = JSON.parse(await readFile(resolve(runFolder, 'workflow.json'), 'utf8'));
    assert.deepEqual(workflow.map((item: { role: string }) => item.role), ['background', 'main_content', 'decorator']);
    assert.ok(workflow.every((item: { handoff: unknown }) => item.handoff));
    const review = JSON.parse(await readFile(resolve(runFolder, 'review.json'), 'utf8'));
    assert.equal(review.approved, true); assert.equal(review.reviews.length, 2);
    assert.ok((await readFile(resolve(runFolder, 'final.jpg'))).length > 0);
    assert.match(await readFile(resolve(output, 'logs', 'agent.jsonl'), 'utf8'), /"type":"saved"/);
    const config = JSON.parse(await readFile(resolve(directory, 'agents.local.json'), 'utf8'));
    assert.deepEqual(config.connection, {});
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
