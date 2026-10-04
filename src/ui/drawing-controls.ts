import type { DrawingEvent, PaintStyle } from '../contracts/service';
import { fetchModels, streamDrawing } from './service';
import { TimedLog } from './timed-log';
import { DrawingAnimation } from './scanline-animation';

export function mountDrawingControls(app: HTMLElement): void {
  const prompt = app.querySelector<HTMLTextAreaElement>('#prompt')!;
  const send = app.querySelector<HTMLButtonElement>('.prompt-send')!;
  const cancel = app.querySelector<HTMLButtonElement>('#cancel-run')!;
  const layers = app.querySelector<HTMLInputElement>('#layer-count')!;
  const batch = app.querySelector<HTMLInputElement>('#batch')!;
  const edit = app.querySelector<HTMLInputElement>('#use-base')!;
  const model = app.querySelector<HTMLSelectElement>('#model-select')!;
  const refreshModels = app.querySelector<HTMLButtonElement>('#refresh-models')!;
  const status = app.querySelector<HTMLElement>('.status')!;
  const activity = app.querySelector<HTMLElement>('#activity-log')!;
  const agentState = app.querySelector<HTMLElement>('#agent-state')!;
  const activityLog = new TimedLog(item => { activity.dataset.kind = item.kind.toLowerCase(); activity.textContent = item.text; });
  const reportError = (message: string) => {
    if (activity.dataset.lastError === message) return;
    activity.dataset.lastError = message;
    activityLog.enqueue({ kind: 'Error', text: message });
  };
  window.addEventListener('pagehide', () => activityLog.reset());
  const metrics = [...app.querySelectorAll<HTMLElement>('.metrics dd')];
  const canvas = app.querySelector<HTMLCanvasElement>('#scene')!;
  const context = canvas.getContext('2d')!;
  const animation = new DrawingAnimation(context.getImageData(0, 0, canvas.width, canvas.height), frame => {
    context.putImageData(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height), 0, 0);
  });
  window.addEventListener('pagehide', () => animation.dispose());
  let controller: AbortController | undefined;
  const discovery = new AbortController();
  window.addEventListener('pagehide', () => discovery.abort());
  let loadingModels = true;
  let modelError: string | undefined;
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
    send.disabled = !!controller || loadingModels || !model.value || !prompt.value.trim() || !Number.isInteger(Number(layers.value)) || Number(layers.value) < 1 || Number(layers.value) > 6;
    for (const control of [prompt, layers, batch, edit]) control.disabled = !!controller;
    model.disabled = !!controller || loadingModels || !model.value;
    refreshModels.disabled = !!controller || loadingModels;
    cancel.hidden = !controller;
  };
  const updateMetrics = () => {
    counts.forEach((value, index) => { metrics[index].textContent = String(value); });
    metrics[4].textContent = (completed ? totalDuration / completed / 1000 : 0).toFixed(1);
  };
  const loadModels = async () => {
    loadingModels = true; refresh();
    const selected = model.value;
    try {
      const list = await fetchModels(discovery.signal);
      const options = list.models.map(id => { const option = document.createElement('option'); option.value = id; option.textContent = id; return option; });
      model.replaceChildren(...options);
      model.value = list.models.includes(selected) ? selected : list.selected_model;
      if (activity.dataset.lastError === modelError) delete activity.dataset.lastError;
      modelError = undefined;
    } catch (error) {
      if (discovery.signal.aborted) return;
      const option = document.createElement('option'); option.value = ''; option.textContent = 'Models unavailable';
      model.replaceChildren(option);
      modelError = error instanceof Error ? error.message : String(error);
      reportError(modelError);
    } finally { loadingModels = false; refresh(); }
  };
  refreshModels.addEventListener('click', () => { void loadModels(); });
  model.addEventListener('change', refresh);
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
      case 'state': agentState.textContent = event.state.replaceAll('_', ' ') + (event.tool ? ` (${event.tool})` : ''); break;
      case 'stage': status.textContent = `${batchPosition}${stageActions[event.name] || event.name} (${event.index}/${event.total}).`; break;
      case 'phase': if (event.role === 'reviewer') status.textContent = `${batchPosition}Validating the scene (review ${event.round}).`; else if (event.round > 1) { counts[3]++; updateMetrics(); status.textContent = `${batchPosition}Applying review corrections (${event.round}).`; } break;
      case 'tool': counts[0]++; counts[event.ok ? 1 : 2]++; activityLog.enqueue({ kind: 'Tools', text: `${event.name} ${JSON.stringify(event.input)}` }); if (!event.ok) reportError(event.message || `${event.name} failed.`); updateMetrics(); break;
      case 'thinking': activityLog.enqueue({ kind: 'Thinking', text: event.text }); break;
      case 'execution_error': reportError(event.message); break;
      case 'preview': await preview(event.image, signal, event.group, event.style); break;
      case 'review': break;
      case 'retry': counts[3]++; reportError(event.message); updateMetrics(); break;
      case 'final':
        if (event.output_path) canvas.dataset.outputPath = event.output_path;
        sceneId = event.scene_id; completed++; totalDuration += event.duration_ms; updateMetrics();
        status.textContent = event.approved ? 'Approved' : event.stop_reason === 'review_limit' ? 'Review limit reached' : 'Incomplete';
        if (event.error) reportError(event.error); break;
      case 'error': throw new Error(event.message);
    }
  };
  prompt.addEventListener('input', refresh);
  layers.addEventListener('input', refresh);
  layers.addEventListener('change', refresh);
  cancel.addEventListener('click', () => controller?.abort());
  send.addEventListener('click', async () => {
    if (controller || send.disabled) return;
    if (edit.checked && !sceneId) { status.textContent = 'Error'; reportError('Draw a scene before editing it.'); return; }
    const prompts = batch.checked ? prompt.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [prompt.value.trim()];
    const baseId = edit.checked ? sceneId : undefined;
    const selectedModel = model.value;
    const batchId = batch.checked ? crypto.randomUUID() : undefined;
    const current = new AbortController(); controller = current;
    counts = [0, 0, 0, 0]; totalDuration = 0; completed = 0; delete activity.dataset.lastError; agentState.textContent = 'processing prompt'; updateMetrics(); refresh();
    try {
      for (const [index, text] of prompts.entries()) {
        current.signal.throwIfAborted();
        batchPosition = prompts.length > 1 ? `Drawing ${index + 1}/${prompts.length}: ` : '';
        let incomplete = false;
        await streamDrawing({ prompt: text, layers: Number(layers.value), model: selectedModel, ...(baseId ? { scene_id: baseId } : {}), ...(batchId ? { batch: { id: batchId, index: index + 1 } } : {}) }, current.signal, async event => {
          await receive(event, current.signal);
          if (event.type === 'final' && event.stop_reason === 'incomplete') incomplete = true;
        });
        if (incomplete) break;
      }
      if (prompts.length > 1) status.textContent += ` (${completed}/${prompts.length} drawings)`;
    } catch (error) {
      status.textContent = current.signal.aborted ? 'Cancelled' : 'Error';
      if (!current.signal.aborted) reportError(error instanceof Error ? error.message : String(error));
    } finally { agentState.textContent = 'idle'; controller = undefined; refresh(); }
  });
  refresh();
  void loadModels();
}
