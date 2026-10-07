import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page, request }) => {
  await request.post('http://127.0.0.1:5189/reset');
  await page.goto('/');
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeEnabled();
  await page.locator('#layer-count').fill('2');
});

for (let layers = 2; layers <= 7; layers++) test(`workflow ${layers} renders a drawing and corrects only with the final artist`, async ({ page, request }) => {
  await page.locator('#layer-count').fill(String(layers));
  await expect(page.locator('#layer-algorithm')).toContainText('Reviewer');
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Draw a landscape and a subject [reject]');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.status')).toHaveText('Approved');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeHidden();
  const values = await page.locator('.metrics dd').allTextContents();
  expect(Number(values[0])).toBeGreaterThan((layers - 1) * 2);
  expect(Number(values[3])).toBe(1);
  expect(await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data.some(value => value !== 0))).toBe(true);
  const requests = await (await request.get('http://127.0.0.1:5189/requests')).json();
  const stages = new Set(requests.filter((item: { workflow?: unknown }) => item.workflow).map((item: { workflow: { stage_index?: number } }) => item.workflow.stage_index ?? 1));
  expect(stages.size).toBe(layers - 1);
  expect(requests.filter((item: { workflow?: unknown; round: number }) => item.workflow && item.round === 2).every((item: { workflow: { stage_index?: number } }) => (item.workflow.stage_index ?? 1) === layers - 1)).toBe(true);
  await expect(page.locator('#agent-state')).toHaveText('idle');
});

test('the model combo applies a selection to one Send operation and accepts a different model on the next turn', async ({ page, request }) => {
  const model = page.getByRole('combobox', { name: 'Model' });
  await expect(model.locator('option')).toHaveText(['embedding-test', 'test-model', 'second-model']);
  await model.selectOption('second-model');
  await page.locator('#layer-count').fill('2');
  await page.getByRole('textbox', { name: 'Prompt' }).fill('First selected model');
  const sent = page.waitForRequest(item => item.url().endsWith('/api/runs'));
  await page.getByRole('button', { name: 'Send' }).click();
  expect((await sent).postDataJSON().model).toBe('second-model');
  await expect(page.locator('.status')).toHaveText('Approved');
  await model.selectOption('test-model');
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Next selected model');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.status')).toHaveText('Approved');
  const requests = await (await request.get('http://127.0.0.1:5189/requests')).json();
  expect(requests.filter((item: { prompt: string }) => item.prompt === 'First selected model').every((item: { model: string }) => item.model === 'second-model')).toBe(true);
  expect(requests.filter((item: { prompt: string }) => item.prompt === 'Next selected model').every((item: { model: string }) => item.model === 'test-model')).toBe(true);
});

test('the selected model survives reload and refresh', async ({ page }) => {
  const model = page.getByRole('combobox', { name: 'Model' });
  await model.selectOption('second-model');
  expect(await page.evaluate(() => localStorage.getItem('artboard.selected-model'))).toBe('second-model');
  await page.reload();
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('second-model');
  await page.getByRole('button', { name: 'Refresh models' }).click();
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('second-model');
});

test('workflow 1 completes without reviewer requests', async ({ page, request }) => {
  await page.locator('#layer-count').fill('1');
  await expect(page.locator('#layer-algorithm')).toContainText('without a reviewer');
  await page.getByRole('textbox', { name: 'Prompt' }).fill('A scene [reject]');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.status')).toHaveText('Completed');
  const requests = await (await request.get('http://127.0.0.1:5189/requests')).json();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((item: { tools: string[] }) => !item.tools.includes('submit_review'))).toBe(true);
});

test('reasoning and image size controls are captured per turn and reasoning survives reload', async ({ page }) => {
  const reasoning = page.getByRole('combobox', { name: 'Reasoning level' });
  await expect(reasoning.locator('option')).toHaveText(['Default', 'Off', 'Low', 'Medium', 'High']);
  await reasoning.selectOption('none');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Model' })).toBeEnabled();
  await expect(reasoning).toHaveValue('none');
  const size = page.getByRole('spinbutton', { name: 'Image size divisor' });
  await expect(size).toHaveValue('4');
  await size.fill('2');
  await page.getByRole('textbox', { name: 'Prompt' }).fill('A scene');
  const sent = page.waitForRequest(item => item.url().endsWith('/api/runs'));
  await page.getByRole('button', { name: 'Send' }).click();
  const body = (await sent).postDataJSON();
  expect(body.reasoning_effort).toBe('none'); expect(body.vision_image_divisor).toBe(2);
  await expect(page.locator('.status')).toHaveText('Completed');
  await reasoning.selectOption('');
  const next = page.waitForRequest(item => item.url().endsWith('/api/runs'));
  await page.getByRole('button', { name: 'Send' }).click();
  expect((await next).postDataJSON().reasoning_effort).toBeUndefined();
});

test('a saved model that is no longer advertised falls back to the server preference', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('artboard.selected-model', 'unloaded-model'));
  await page.reload();
  const model = page.getByRole('combobox', { name: 'Model' });
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue('test-model');
  await model.selectOption('second-model');
  expect(await page.evaluate(() => localStorage.getItem('artboard.selected-model'))).toBe('second-model');
});

test('model selection remains usable if browser storage access is denied', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage denied', 'SecurityError'); } });
  });
  await page.reload();
  const model = page.getByRole('combobox', { name: 'Model' });
  await expect(model).toBeEnabled();
  await model.selectOption('second-model');
  await page.getByRole('textbox', { name: 'Prompt' }).fill('A scene');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('batch input runs sequential drawings and edit uses the last retained scene', async ({ page, request }) => {
  await page.getByRole('checkbox', { name: 'Batch (one prompt per line)' }).check();
  await page.getByRole('textbox', { name: 'Prompt' }).fill('First scene\n\nSecond scene');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.status')).toHaveText('Approved (2/2 drawings)');
  await page.getByRole('checkbox', { name: 'Batch (one prompt per line)' }).uncheck();
  await page.getByRole('checkbox', { name: 'Edit the current scene' }).check();
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Add another object');
  const sent = page.waitForRequest(item => item.url().endsWith('/api/runs'));
  await page.getByRole('button', { name: 'Send' }).click();
  expect((await sent).postDataJSON().scene_id).toBeTruthy();
  await expect(page.locator('.status')).toHaveText('Approved');
  const requests = await (await request.get('http://127.0.0.1:5189/requests')).json();
  const edit = requests.find((item: { prompt: string }) => item.prompt === 'Add another object');
  expect(edit.current_scene.objects.length).toBeGreaterThan(0);
});

test('cancel aborts inference and allows a new run', async ({ page, request }) => {
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Scene [slow]');
  const send = page.getByRole('button', { name: 'Send' });
  await send.click();
  await expect(send).toBeDisabled();
  await expect(send).toHaveText('Send →');
  await send.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await expect.poll(async () => (await (await request.get('http://127.0.0.1:5189/requests')).json()).length).toBe(1);
  await page.waitForTimeout(250);
  await expect(send).toHaveText('Send →');
  await expect(page.locator('.status')).not.toHaveText('Cancelled');
  await expect(page.locator('#workflow-log')).toContainText('Creating the scene');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('.status')).toHaveText('Cancelled');
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Prompt' }).fill('New scene');
  const nextRun = page.waitForRequest(item => item.url().endsWith('/api/runs'));
  await page.getByRole('button', { name: 'Send' }).click();
  expect((await nextRun).postDataJSON().prompt).toBe('New scene');
  const requests = await (await request.get('http://127.0.0.1:5189/requests')).json();
  expect(requests.filter((item: { prompt: string }) => item.prompt.includes('[slow]')).length).toBe(1);
});

test('review exhaustion, incomplete results and errors are distinct and errors have their own log', async ({ page }) => {
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Scene [limit]'); await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.status')).toHaveText('Review limit reached');
  await page.locator('#layer-count').fill('3');
  await prompt.fill('Scene [fail-after-background]'); await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.status')).toHaveText('Incomplete');
  await expect(page.locator('#activity-log')).toHaveAttribute('data-last-error', /Simulated model failure/);
  await prompt.fill('Scene [fail]'); await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.status')).toHaveText('Error');
  await expect(page.locator('#activity-log')).toHaveAttribute('data-last-error', /Simulated model failure/);
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('undefined workflows cannot start and editing requires a current drawing', async ({ page, request }) => {
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Scene');
  for (const layers of [8, 9]) {
    await page.locator('#layer-count').fill(String(layers));
    await expect(page.locator('#layer-algorithm')).toContainText('Not defined');
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect((await request.post('/api/runs', { data: { prompt: 'Scene', layers } })).status()).toBe(400);
  }
  await page.locator('#layer-count').fill('1');
  await page.getByRole('checkbox', { name: 'Edit the current scene' }).check();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('#activity-log')).toContainText('Draw a scene before editing it.');
  expect(await (await request.get('http://127.0.0.1:5189/requests')).json()).toEqual([]);
});

test('the three logs separate activity, workflow and errors; bursts hold each entry for one second', async ({ page }) => {
  const time = new Date('2026-10-04T12:00:00Z');
  await page.clock.install({ time }); await page.clock.pauseAt(time);
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Scene [thinking]');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.status')).toHaveText('Approved');
  const log = page.locator('[data-title="Real time log"]');
  await expect(log.locator(':scope > p')).toHaveCount(3);
  await expect(log.locator('.muted, #activity-kind')).toHaveCount(0);
  const colors = await log.locator(':scope > p').evaluateAll(elements => elements.map(element => getComputedStyle(element).color));
  expect(new Set(colors).size).toBe(1);
  await expect(page.locator('#activity-log')).toHaveAttribute('data-kind', 'thinking');
  await expect(page.locator('#activity-log')).toContainText('Thinking:');
  await expect(page.locator('#activity-log')).not.toContainText('tokens');
  await expect(page.locator('#activity-log')).toContainText('Inspect the requested scene');
  await expect(page.locator('#agent-state')).toHaveText('idle');
  const clipping = await page.locator('#activity-log').evaluate(element => ({ height: element.getBoundingClientRect().height, clamp: getComputedStyle(element).webkitLineClamp, content: element.scrollHeight, top: element.scrollTop, visible: element.clientHeight }));
  expect(clipping.height).toBeLessThanOrEqual(32); expect(clipping.clamp).toBe('2'); expect(clipping.content).toBeGreaterThan(clipping.height);
  expect(clipping.top + clipping.visible).toBeGreaterThanOrEqual(clipping.content - 1);
  await page.clock.runFor(999); await expect(page.locator('#activity-log')).toHaveAttribute('data-kind', 'thinking');
  await page.clock.runFor(1); await expect(page.locator('#activity-log')).toHaveAttribute('data-kind', 'tools');
  await expect(page.locator('#activity-log')).toContainText('scene_apply');
  await expect(page.locator('#activity-log')).toContainText('"color":"red"');
  await page.clock.runFor(999); await expect(page.locator('#activity-log')).toContainText('scene_apply');
  await page.clock.runFor(1); await expect(page.locator('#activity-log')).toHaveAttribute('data-kind', 'thinking');
  await page.getByRole('textbox', { name: 'Prompt' }).fill('A later run');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.status')).toHaveText('Approved');
  await expect(page.locator('#activity-log')).toHaveAttribute('data-kind', 'thinking');
  await page.clock.runFor(999); await expect(page.locator('#activity-log')).toHaveAttribute('data-kind', 'thinking');
  await page.clock.runFor(1); await expect(page.locator('#activity-log')).toContainText('finish_draft');
  await page.clock.runFor(999); await expect(page.locator('#activity-log')).toContainText('finish_draft');
  await page.clock.runFor(1); await expect(page.locator('#activity-log')).toHaveAttribute('data-kind', 'thinking');
  await page.clock.runFor(1000); await expect(page.locator('#activity-log')).toContainText('submit_review');
  await page.clock.runFor(1000); await expect(page.locator('#activity-log')).toContainText('scene_apply');
});

test('configuration is inaccessible from the browser and failures recover without mixing logs', async ({ page, request }) => {
  for (const url of ['/agents.local.json', '/outputs/ui-config/agents.local.json', '/@fs/' + process.cwd().replace(/\\/g, '/') + '/outputs/ui-config/agents.local.json']) {
    const response = await request.get(url);
    expect(await response.text()).not.toContain('server-only-test-key');
    expect(response.status()).toBeGreaterThanOrEqual(400);
  }
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Scene [invalid-handoff]');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.status')).toHaveText('Approved');
  await expect(page.locator('#activity-log')).toHaveAttribute('data-last-error', /Invalid finish_draft/);
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Clean run');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.status')).toHaveText('Approved');
  await expect(page.locator('#agent-state')).toHaveText('idle');
  await expect(page.locator('#activity-log')).not.toHaveAttribute('data-last-error');
});
