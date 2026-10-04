import { expect, test } from '@playwright/test';

for (const layers of [1, 2]) test(`real model completes a ${layers}-layer drawing through the browser`, async ({ page }) => {
  const failures: string[] = [];
  page.on('requestfailed', request => failures.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.exposeFunction('recordLiveLog', (entry: string) => console.log(`Live model: ${entry}`));
  await page.goto('/');
  await page.evaluate(() => {
    const report = (element: Element) => {
      const value = element.textContent || '';
      if (value && value !== 'None') void (window as unknown as { recordLiveLog: (entry: string) => Promise<void> }).recordLiveLog(value);
    };
    for (const id of ['workflow-log', 'agent-state', 'activity-log']) {
      const element = document.getElementById(id)!;
      new MutationObserver(() => report(element)).observe(element, { childList: true, characterData: true, subtree: true });
    }
  });
  await page.getByRole('textbox', { name: 'Prompt' }).fill(layers === 1
    ? 'Paint the entire canvas solid blue using a single full-canvas polygon. No other objects, text or details.'
    : 'Draw a solid blue background and one small yellow circle in the center. Only these two objects, no decorations or text.');
  await page.locator('#layer-count').fill(String(layers));
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(async () => page.locator('#workflow-log').textContent(), { timeout: 280000 }).toMatch(/^(Approved|Incomplete|Review limit reached|Error)$/);
  const status = await page.locator('#workflow-log').textContent();
  const error = await page.locator('#activity-log').getAttribute('data-last-error');
  expect(status, `Real run failed: ${error}`).toBe('Approved');
  await expect(page.locator('#agent-state')).toHaveText('idle');
  expect(failures).toEqual([]);
  expect(Number(await page.locator('.metrics dd').first().textContent())).toBeGreaterThan(0);
  expect(await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data.some(value => value !== 0))).toBe(true);
  const log = page.locator('[data-title="Real time log"]');
  await expect(log.locator(':scope > p')).toHaveCount(3);
  await expect(log.locator('.muted, #activity-kind')).toHaveCount(0);
  const colors = await log.locator(':scope > p').evaluateAll(elements => elements.map(element => getComputedStyle(element).color));
  expect(new Set(colors).size).toBe(1);
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeHidden();
});
