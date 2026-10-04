import type { DrawingEvent, PaintStyle, ReasoningEffort } from '../contracts/service';
import { fetchModels, streamDrawing } from './service';
import { activityText, thinkingLabel, TimedLog } from './timed-log';
import { DrawingAnimation } from './scanline-animation';
import { phaseStatus, stageStatus } from './workflow-status';
import { AgentStatisticsLog } from './agent-statistics';

const MODEL_STORAGE_KEY = 'artboard.selected-model';
const REASONING_STORAGE_KEY = 'artboard.reasoning-effort';

export function mountDrawingControls(app: HTMLElement): void {
  const prompt = app.querySelector<HTMLTextAreaElement>('#prompt')!;
  const send = app.querySelector<HTMLButtonElement>('.prompt-send')!;
  const cancel = app.querySelector<HTMLButtonElement>('#cancel-run')!;
  const layers = app.querySelector<HTMLInputElement>('#layer-count')!;
  const batch = app.querySelector<HTMLInputElement>('#batch')!;
  const edit = app.querySelector<HTMLInputElement>('#use-base')!;
  const model = app.querySelector<HTMLSelectElement>('#model-select')!;
  const reasoning = app.querySelector<HTMLSelectElement>('#reasoning-select')!;
  const imageDivisor = app.querySelector<HTMLInputElement>('#image-divisor')!;
  try {
    const saved = window.localStorage.getItem(REASONING_STORAGE_KEY);
    if (saved && ['none', 'low', 'medium', 'high'].includes(saved)) reasoning.value = saved;
  } catch { /* Browser storage is optional. */ }
  reasoning.addEventListener('change', () => {
    try { window.localStorage.setItem(REASONING_STORAGE_KEY, reasoning.value); }
    catch { /* Keep the selected effort usable without storage. */ }
  });
  const refreshModels = app.querySelector<HTMLButtonElement>('#refresh-models')!;
  const status = app.querySelector<HTMLElement>('.status')!;
  const activity = app.querySelector<HTMLElement>('#activity-log')!;
  const agentState = app.querySelector<HTMLElement>('#agent-state')!;
  const statistics = app.querySelector<HTMLElement>('#agent-statistics')!;
  const statisticsLog = new AgentStatisticsLog();
  statistics.textContent = statisticsLog.text();
  const activityLog = new TimedLog(item => {
    activity.dataset.kind = item.kind.toLowerCase(); activity.textContent = activityText(item);
    activity.scrollTop = item.kind === 'Thinking' ? activity.scrollHeight : 0;
  });
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
  let workflowLayers = 1;
  const refresh = () => {
    send.disabled = !!controller || loadingModels || !model.value || !prompt.value.trim() || !Number.isInteger(Number(layers.value)) || Number(layers.value) < 1 || Number(layers.value) > 7 || !Number.isInteger(Number(imageDivisor.value)) || Number(imageDivisor.value) < 1 || Number(imageDivisor.value) > 64;
    for (const control of [prompt, layers, batch, edit, reasoning, imageDivisor]) control.disabled = !!controller;
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
    let selected = model.value;
    if (!selected) {
      try { selected = window.localStorage.getItem(MODEL_STORAGE_KEY) || ''; }
      catch { /* Browser storage may be unavailable; server defaults still work. */ }
    }
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
  model.addEventListener('change', () => {
    if (model.value) {
      try { window.localStorage.setItem(MODEL_STORAGE_KEY, model.value); }
      catch { /* Keep the current selection usable when browser storage is unavailable. */ }
    }
    refresh();
  });
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
      case 'statistics': statisticsLog.update(event); statistics.textContent = statisticsLog.text(); statistics.title = statistics.textContent; break;
      case 'state': agentState.textContent = event.state === 'thinking' ? 'thinking (… tokens)' : event.state.replaceAll('_', ' ') + (event.tool ? ` (${event.tool})` : ''); break;
      case 'stage': workflowLayers = event.total; status.textContent = batchPosition + stageStatus(event.name, event.index, event.total); break;
      case 'phase': if (event.role === 'reviewer') status.textContent = batchPosition + phaseStatus(event.role, event.round, workflowLayers); else if (event.round > 1) { counts[3]++; updateMetrics(); status.textContent = batchPosition + phaseStatus(event.role, event.round, workflowLayers); } break;
      case 'tool_input': activityLog.enqueue({ id: event.id, kind: 'Tools', text: `${event.name} ${event.input}` }); break;
      case 'tool': counts[0]++; counts[event.ok ? 1 : 2]++; activityLog.enqueue({ id: event.id, kind: 'Tools', text: `${event.name} ${JSON.stringify(event.input)}` }); if (!event.ok) reportError(event.message || `${event.name} failed.`); updateMetrics(); break;
      case 'thinking':
        if (agentState.textContent?.startsWith('thinking')) agentState.textContent = thinkingLabel(event.tokens, event.tokens_estimated).toLowerCase();
        activityLog.enqueue({ id: event.id, kind: 'Thinking', text: event.text, tokens: event.tokens, tokens_estimated: event.tokens_estimated }); break;
      case 'execution_error': reportError(event.message); break;
      case 'preview': await preview(event.image, signal, event.group, event.style); break;
      case 'review': break;
      case 'retry': counts[3]++; reportError(event.message); updateMetrics(); break;
      case 'final':
        if (event.output_path) canvas.dataset.outputPath = event.output_path;
        sceneId = event.scene_id; completed++; totalDuration += event.duration_ms; updateMetrics();
        status.textContent = event.approved ? 'Approved' : event.stop_reason === 'unreviewed' ? 'Completed' : event.stop_reason === 'review_limit' ? 'Review limit reached' : 'Incomplete';
        if (event.error) reportError(event.error); break;
      case 'error': throw new Error(event.message);
    }
  };
  prompt.addEventListener('input', refresh);
  layers.addEventListener('input', refresh);
  layers.addEventListener('change', refresh);
  imageDivisor.addEventListener('input', refresh);
  imageDivisor.addEventListener('change', refresh);
  cancel.addEventListener('click', () => controller?.abort());
  send.addEventListener('click', async () => {
    if (controller || send.disabled) return;
    if (edit.checked && !sceneId) { status.textContent = 'Error'; reportError('Draw a scene before editing it.'); return; }
    const prompts = batch.checked ? prompt.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [prompt.value.trim()];
    const baseId = edit.checked ? sceneId : undefined;
    const selectedModel = model.value;
    const selectedReasoning = reasoning.value as ReasoningEffort | '';
    const selectedImageDivisor = Number(imageDivisor.value);
    const batchId = batch.checked ? crypto.randomUUID() : undefined;
    const current = new AbortController(); controller = current;
    statisticsLog.reset(); statistics.textContent = statisticsLog.text(); statistics.title = statistics.textContent;
    counts = [0, 0, 0, 0]; totalDuration = 0; completed = 0; delete activity.dataset.lastError; agentState.textContent = 'processing prompt'; updateMetrics(); refresh();
    try {
      for (const [index, text] of prompts.entries()) {
        current.signal.throwIfAborted();
        batchPosition = prompts.length > 1 ? `Drawing ${index + 1}/${prompts.length}: ` : '';
        let incomplete = false;
        await streamDrawing({ prompt: text, layers: Number(layers.value), model: selectedModel, vision_image_divisor: selectedImageDivisor, ...(selectedReasoning ? { reasoning_effort: selectedReasoning } : {}), ...(baseId ? { scene_id: baseId } : {}), ...(batchId ? { batch: { id: batchId, index: index + 1 } } : {}) }, current.signal, async event => {
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
