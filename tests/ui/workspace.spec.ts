import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
});

test('the approved shell has three columns and no removed controls', async ({ page }) => {
  await expect(page.locator('.workspace > .panel')).toHaveCount(3);
  await expect(page.locator('.workspace > .panel[data-frame="double"]')).toHaveCount(3);
  expect(await page.locator('.workspace > .panel').evaluateAll(panels => panels.map(panel => panel.getAttribute('data-title')))).toEqual(['PROMPT', 'CANVAS', 'MONITOR']);
  expect(await page.locator('[aria-label="Monitor"] [data-title]').evaluateAll(boxes => boxes.map(box => box.getAttribute('data-title')))).toEqual(['Stats', 'Real time log']);
  await expect(page.locator('[data-title="Agent actions"]')).toHaveCount(0);
  await expect(page.locator('nav, [role="tab"], details, select, input[type="url"], input[type="file"]')).toHaveCount(0);
  await expect(page.locator('[aria-label="Prompt"] [data-title]')).toHaveCount(0);
  expect(await page.locator('.prompt-panel .checkbox-row').allTextContents()).toEqual(['Batch (one prompt per line)', 'Edit the current scene']);
  await expect(page.locator('#layer-count')).toHaveAttribute('min', '1');
  await expect(page.locator('#layer-count')).toHaveAttribute('max', '9');
  await expect(page.locator('.canvas-panel > canvas')).toHaveCount(1);
  await expect(page.locator('.canvas-panel [data-frame]')).toHaveCount(0);
  await expect(page.locator('.canvas-panel > :not(.frame)')).toHaveCount(1);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('typing, checkboxes, and Send stay local without starting execution', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('A river at dusk\nA stone bridge');
  await page.getByRole('checkbox', { name: 'Batch (one prompt per line)' }).check();
  await page.getByRole('checkbox', { name: 'Edit the current scene' }).check();
  await expect(prompt).toHaveValue('A river at dusk\nA stone bridge');
  await expect(page.getByRole('checkbox', { name: 'Edit the current scene' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Batch (one prompt per line)' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await expect(page.locator('.status')).toHaveText('Not started');
  const empty = await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
    const image = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    return image.data.every(value => value === 0);
  });
  expect(empty).toBe(true);
  expect(requests).toEqual([]);
});

test('nested frames belong to their boxes and never cross title text', async ({ page }) => {
  const errors = await page.evaluate(() => {
    const issues: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('[data-frame]')) {
      const frame = element.querySelector<HTMLElement>(':scope > .frame')!;
      if (frame.offsetParent !== element) issues.push(`Misplaced frame: ${element.className}`);
      const box = element.getBoundingClientRect();
      const edge = frame.getBoundingClientRect();
      if (Math.abs(box.x - edge.x) > 0.1 || Math.abs(box.y - edge.y) > 0.1 || Math.abs(box.width - edge.width) > 0.1 || Math.abs(box.height - edge.height) > 0.1) issues.push(`Frame size: ${element.className}`);
    }
    for (const title of document.querySelectorAll('.frame .title')) {
      const bounds = title.getBoundingClientRect();
      for (const line of document.querySelectorAll('.frame .line')) {
        const edge = line.getBoundingClientRect();
        if (Math.min(bounds.right, edge.right) - Math.max(bounds.left, edge.left) > 0.1 && Math.min(bounds.bottom, edge.bottom) - Math.max(bounds.top, edge.top) > 0.1) issues.push(`Line crosses ${title.textContent}`);
      }
    }
    return issues;
  });
  expect(errors).toEqual([]);
  await expect(page.locator('[data-title="Stats"] > .frame .title')).toHaveText('[ Stats ]');
});

test('Stats are numerical and prompt and monitor fit their content', async ({ page }) => {
  await expect(page.locator('.metrics dt')).toHaveText(['Tool calls', 'Successful calls', 'Failed calls', 'Retries', 'Avg. run time (s)']);
  await expect(page.locator('.metrics dd')).toHaveText(['0', '0', '0', '0', '0.0']);

  const dimensions = await page.evaluate(() => ({
    prompt: document.querySelector('.prompt-panel')!.getBoundingClientRect().height,
    monitor: document.querySelector('.monitor-panel')!.getBoundingClientRect().height,
    viewport: window.innerHeight,
  }));
  expect(dimensions.prompt).toBeLessThan(dimensions.viewport);
  expect(dimensions.monitor).toBeLessThan(dimensions.viewport);

  const layers = page.locator('#layer-count');
  await layers.fill('14');
  await layers.dispatchEvent('change');
  await expect(layers).toHaveValue('9');
  await layers.fill('0');
  await layers.dispatchEvent('change');
  await expect(layers).toHaveValue('1');
});

test('the local VGA font loads and canvas frame follows the image on resize', async ({ page }) => {
  expect(await page.evaluate(() => [...document.fonts].some(font => font.family === 'IBM VGA' && font.status === 'loaded'))).toBe(true);
  for (const width of [1221, 1600]) {
    await page.setViewportSize({ width, height: 800 });
    const dimensions = await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
      const image = canvas.getBoundingClientRect();
      const panel = canvas.parentElement!.getBoundingClientRect();
      return { width: canvas.width, height: canvas.height, ratio: image.width / image.height, paddingX: panel.width - image.width, paddingY: panel.height - image.height, panelHeight: panel.height };
    });
    expect(dimensions.width).toBe(640);
    expect(dimensions.height).toBe(480);
    expect(dimensions.ratio).toBeCloseTo(4 / 3, 3);
    expect(dimensions.paddingX).toBeCloseTo(16, 1);
    expect(dimensions.paddingY).toBeCloseTo(32, 1);
    expect(dimensions.panelHeight).toBeLessThan(784);
    const expectedEdge = await page.locator('.canvas-panel').evaluate(panel => '═'.repeat(Math.ceil(panel.clientWidth / 8)));
    await expect.poll(() => page.locator('.canvas-panel > .frame .top .line').last().textContent()).toBe(expectedEdge);
  }
});

test('Send is borderless on the bottom-right edge and changes from gray to white with text', async ({ page }) => {
  const send = page.getByRole('button', { name: 'Send' });
  await expect(send).not.toHaveAttribute('data-frame');
  await expect(send).toHaveCSS('border-top-width', '0px');
  await expect(send).toBeDisabled();
  await expect(send).toHaveCSS('color', 'rgb(169, 175, 185)');
  const position = await page.getByRole('button', { name: 'Send' }).evaluate(button => {
    const bounds = button.getBoundingClientRect();
    const inputBox = button.closest('.input-box')!.getBoundingClientRect();
    return { right: inputBox.right - bounds.right, bottom: inputBox.bottom - bounds.bottom };
  });
  expect(position.right).toBeCloseTo(16, 1);
  expect(position.bottom).toBeCloseTo(0, 1);
  await page.getByRole('textbox', { name: 'Prompt' }).fill('A stone bridge');
  await expect(send).toBeEnabled();
  await expect(send).toHaveCSS('color', 'rgb(241, 239, 233)');
  await page.getByRole('textbox', { name: 'Prompt' }).fill('   ');
  await expect(send).toBeDisabled();
  await expect(send).toHaveCSS('color', 'rgb(169, 175, 185)');
});
