import './style.css';
import { describeLayerAlgorithm } from './layer-algorithms';
import { mountDrawingControls } from './drawing-controls';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <main class="workspace" aria-label="Artboard">
    <section class="panel prompt-panel" data-frame="double" data-title="PROMPT" aria-label="Prompt">
      <div class="panel-content">
        <div class="input-box" data-frame="single">
          <textarea id="prompt" rows="4" maxlength="4000" placeholder="Describe the drawing…" aria-label="Prompt"></textarea>
          <button type="button" class="prompt-send" disabled>Send →</button>
        </div>
        <div class="model-picker">
          <label for="model-select">Model</label>
          <div class="model-controls">
            <div class="field-box" data-frame="single"><select id="model-select" disabled><option value="">Loading models...</option></select></div>
            <button id="refresh-models" type="button" aria-label="Refresh models">Refresh</button>
          </div>
        </div>
        <div class="model-picker reasoning-picker">
          <label for="reasoning-select">Reasoning level</label>
          <div class="field-box" data-frame="single"><select id="reasoning-select"><option value="">Default</option><option value="none">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div>
        </div>
        <label class="checkbox-row"><input type="checkbox" id="batch"><span class="check-glyph" aria-hidden="true"></span>Batch (one prompt per line)</label>
        <label class="layer-row" for="image-divisor">Image size: 1 /<input id="image-divisor" type="number" min="1" max="64" step="1" value="4" aria-label="Image size divisor"></label>
        <label class="checkbox-row"><input type="checkbox" id="use-base"><span class="check-glyph" aria-hidden="true"></span>Edit the current scene</label>
        <label class="layer-row" for="layer-count">Number of layers (1-7)<input id="layer-count" type="number" min="1" max="7" step="1" value="1" aria-label="Number of layers" aria-describedby="layer-algorithm"></label>
        <p id="layer-algorithm" class="muted layer-algorithm" aria-live="polite"></p>
      </div>
    </section>
    <div class="canvas-column">
      <section class="panel canvas-panel" data-frame="double" data-title="CANVAS" aria-label="Canvas">
        <canvas id="scene" width="640" height="480" role="img" aria-label="Drawing canvas"></canvas>
      </section>
      <p id="agent-statistics" aria-label="Agent token statistics"></p>
    </div>
    <section class="panel monitor-panel" data-frame="double" data-title="MONITOR" aria-label="Monitor">
      <div class="panel-content">
        <section class="box" data-frame="single" data-title="Stats" aria-label="Stats">
          <dl class="metrics"><div><dt>Tool calls</dt><dd>0</dd></div><div><dt>Successful calls</dt><dd>0</dd></div><div><dt>Failed calls</dt><dd>0</dd></div><div><dt>Retries</dt><dd>0</dd></div></dl>
        </section>
        <section class="box" data-frame="single" data-title="Real time log" aria-label="Real time log">
          <p id="activity-log" class="log-clamped" aria-live="polite">No tool calls yet.</p>
          <p id="workflow-log" class="status" aria-live="polite">Not started</p>
          <p id="agent-state" role="status">idle</p>
        </section>
      </div>
    </section>
  </main>
`;

// Keep each frame independent from any nested single-line frames.
const frames = new Map<HTMLElement, HTMLElement>();
for (const element of app.querySelectorAll<HTMLElement>('[data-frame]')) {
  const double = element.dataset.frame === 'double';
  const frame = document.createElement('div');
  frame.className = 'frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.innerHTML = `
    <div class="edge top"><span>${double ? '╔' : '┌'}</span><span class="line"></span><span>${double ? '╗' : '┐'}</span></div>
    <div class="side left"></div><div class="side right"></div>
    <div class="edge bottom"><span>${double ? '╚' : '└'}</span><span class="line"></span><span>${double ? '╝' : '┘'}</span></div>
  `;
  if (element.dataset.title) {
    const title = document.createElement('span');
    title.className = 'title';
    title.append('[ ');
    const label = document.createElement('span');
    label.className = 'title-label';
    label.textContent = element.dataset.title;
    title.append(label, ' ]');
    // Split the top edge around its title so no line passes behind the text.
    const top = frame.querySelector('.top')!;
    const line = top.querySelector('.line')!;
    const prefix = document.createElement('span');
    prefix.className = 'line title-prefix';
    top.insertBefore(prefix, line);
    top.insertBefore(title, line);
  }
  const send = element.querySelector<HTMLButtonElement>(':scope > .prompt-send');
  if (send) {
    const bottom = frame.querySelector('.bottom')!;
    const corner = bottom.lastElementChild!;
    const gap = document.createElement('span');
    gap.className = 'send-gap';
    gap.textContent = ` ${send.textContent} `;
    const suffix = document.createElement('span');
    suffix.className = 'line send-suffix';
    bottom.insertBefore(gap, corner);
    bottom.insertBefore(suffix, corner);
  }
  element.prepend(frame);
  frames.set(element, frame);
}

const observer = new ResizeObserver(entries => {
  for (const { target } of entries) {
    const element = target as HTMLElement;
    const frame = frames.get(element)!;
    const double = element.dataset.frame === 'double';
    const horizontal = (double ? '═' : '─').repeat(Math.ceil(element.clientWidth / 8));
    const vertical = Array.from({ length: Math.ceil(element.clientHeight / 16) }, () => double ? '║' : '│').join('\n');
    for (const line of frame.querySelectorAll('.line')) line.textContent = horizontal;
    for (const side of frame.querySelectorAll('.side')) side.textContent = vertical;
  }
});
for (const element of frames.keys()) observer.observe(element);

const layerCount = app.querySelector<HTMLInputElement>('#layer-count')!;
const layerAlgorithm = app.querySelector<HTMLParagraphElement>('#layer-algorithm')!;
const updateLayerAlgorithm = () => {
  layerAlgorithm.textContent = describeLayerAlgorithm(Number(layerCount.value));
};
updateLayerAlgorithm();
layerCount.addEventListener('input', updateLayerAlgorithm);
layerCount.addEventListener('change', () => {
  const value = Number(layerCount.value);
  layerCount.value = String(Number.isFinite(value) ? Math.min(7, Math.max(1, Math.trunc(value))) : 1);
  updateLayerAlgorithm();
});

mountDrawingControls(app);
