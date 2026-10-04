import type { DrawingEvent, PaintStyle } from '../contracts/service';
import { streamDrawing } from './service';
import { TimedLog } from './timed-log';
import { DrawingAnimation } from './scanline-animation';

export function mountDrawingControls(app: HTMLElement): void {
  const prompt = app.querySelector<HTMLTextAreaElement>('#prompt')!;
  const send = app.querySelector<HTMLButtonElement>('.prompt-send')!;
  const cancel = app.querySelector<HTMLButtonElement>('#cancel-run')!;
  const layers = app.querySelector<HTMLInputElement>('#layer-count')!;
  const batch = app.querySelector<HTMLInputElement>('#batch')!;
  const edit = app.querySelector<HTMLInputElement>('#use-base')!;
  const status = app.querySelector<HTMLElement>('.status')!;
  const activity = app.querySelector<HTMLElement>('#activity-log')!;
  const errors = app.querySelector<HTMLElement>('#error-log')!;
  const activityLog = new TimedLog(item => { activity.dataset.kind = item.kind.toLowerCase(); activity.textContent = item.text; });
  window.addEventListener('pagehide', () => activityLog.reset());
  const metrics = [...app.querySelectorAll<HTMLElement>('.metrics dd')];
  const canvas = app.querySelector<HTMLCanvasElement>('#scene')!;
  const context = canvas.getContext('2d')!;
  const animation = new DrawingAnimation(context.getImageData(0, 0, canvas.width, canvas.height), frame => {
    context.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  });
  window.addEventListener('pagehide', () => animation.dispose());
  let controller: AbortController | undefined;
  let sceneId: string | undefined;
  let counts = [0, 0, 0, 0];
  let totalDuration = 0, completed = 0;
  let batchPosition = '';
  const stageActions: Record<string, string> = {
    Artist: 'Creating the scene', Background: 'Creating the background', 'Distant background': 'Creating the distant background',
    Setting: 'Building the setting', 'Main content': 'Creating the main content', Foreground: 'Adding foreground elements',
    Decorator: 'Decorating the layers', Specialist: 'Adding specialized details', 'Final integrator': 'Integrating lighting, color and layers',
  };
  const refresh = () => {
    send.disabled = !!controller || !prompt.value.trim() || !Number.isInteger(Number(layers.value)) || Number(layers.value) < 1 || Number(layers.value) > 6;
    for (const control of [prompt, layers, batch, edit]) control.disabled = !!controller;
    cancel.hidden = !controller;
  };
  const updateMetrics = () => {
    counts.forEach((value, index) => { metrics[index].textContent = String(value); });
    metrics[4].textContent = (completed ? totalDuration / completed / 1000 : 0).toFixed(1);
  };
  const preview = async (image: string, signal: AbortSignal, group?: string, style?: PaintStyle) => {
    if (!/^data:image\/(jpeg|png);base64,/.test(image)) throw new Error('Invalid drawing preview.');
    const picture = new Image(); picture.src = image;
    await picture.decode(); signal.throwIfAborted();
    const buffer = document.createElement('canvas'); buffer.width = canvas.width; buffer.height = canvas.height;
    const drawing = buffer.getContext('2d')!; drawing.imageSmoothingEnabled = false;
    drawing.drawImage(picture, 0, 0, buffer.width, buffer.height);
    const target = drawing.getImageData(0, 0, buffer.width, buffer.height);
    animation.animate(target, canvas.getBoundingClientRect().height / canvas.height || 1, { group, style });
  };
  const receive = async (event: DrawingEvent, signal: AbortSignal) => {
    switch (event.type) {
      case 'stage': status.textContent = `${batchPosition}${stageActions[event.name] || event.name} (${event.index}/${event.total}).`; break;
      case 'phase': if (event.role === 'reviewer') status.textContent = `${batchPosition}Validating the scene (review ${event.round}).`; else if (event.round > 1) { counts[3]++; updateMetrics(); status.textContent = `${batchPosition}Applying review corrections (${event.round}).`; } break;
      case 'tool': counts[0]++; counts[event.ok ? 1 : 2]++; activityLog.enqueue({ kind: 'Tools', text: `${event.name} ${JSON.stringify(event.input)}` }); if (!event.ok) errors.textContent = event.message || `${event.name} failed.`; updateMetrics(); break;
      case 'thinking': activityLog.enqueue({ kind: 'Thinking', text: event.text }); break;
      case 'execution_error': errors.textContent = event.message; break;
      case 'preview': await preview(event.image, signal, event.group, event.style); break;
      case 'review': break;
      case 'retry': counts[3]++; errors.textContent = event.message; updateMetrics(); break;
      case 'final':
        if (event.output_path) canvas.dataset.outputPath = event.output_path;
        sceneId = event.scene_id; completed++; totalDuration += event.duration_ms; updateMetrics();
        status.textContent = event.approved ? 'Approved' : event.stop_reason === 'review_limit' ? 'Review limit reached' : 'Incomplete';
        if (event.error) errors.textContent = event.error; break;
      case 'error': throw new Error(event.message);
    }
  };
  prompt.addEventListener('input', refresh);
  layers.addEventListener('input', refresh);
  layers.addEventListener('change', refresh);
  cancel.addEventListener('click', () => controller?.abort());
  send.addEventListener('click', async () => {
    if (controller || send.disabled) return;
    if (edit.checked && !sceneId) { status.textContent = 'Error'; errors.textContent = 'Draw a scene before editing it.'; return; }
    const prompts = batch.checked ? prompt.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [prompt.value.trim()];
    const baseId = edit.checked ? sceneId : undefined;
    const batchId = batch.checked ? crypto.randomUUID() : undefined;
    const current = new AbortController(); controller = current;
    counts = [0, 0, 0, 0]; totalDuration = 0; completed = 0; errors.textContent = 'None'; updateMetrics(); refresh();
    try {
      for (const [index, text] of prompts.entries()) {
        current.signal.throwIfAborted();
        batchPosition = prompts.length > 1 ? `Drawing ${index + 1}/${prompts.length}: ` : '';
        let incomplete = false;
        await streamDrawing({ prompt: text, layers: Number(layers.value), ...(baseId ? { scene_id: baseId } : {}), ...(batchId ? { batch: { id: batchId, index: index + 1 } } : {}) }, current.signal, async event => {
          await receive(event, current.signal);
          if (event.type === 'final' && event.stop_reason === 'incomplete') incomplete = true;
        });
        if (incomplete) break;
      }
      if (prompts.length > 1) status.textContent += ` (${completed}/${prompts.length} drawings)`;
    } catch (error) {
      status.textContent = current.signal.aborted ? 'Cancelled' : 'Error';
      if (!current.signal.aborted) errors.textContent = error instanceof Error ? error.message : String(error);
    } finally { controller = undefined; refresh(); }
  });
  refresh();
}
