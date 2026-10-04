import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { PixelRenderer, SceneStore, SceneTools, type Operation, type PixelImage, type Scene } from '../../core/index.js';
import { runWorkflow, type WorkflowEvent } from '../../workflows/run.js';
import { getWorkflow } from '../../contracts/workflows.js';
import { agentConfig, isChatModelID, listModels } from '../../agents/config.js';
import { AGENT_ROLES } from '../../contracts/workflows.js';
import type { DrawingEvent, DrawingRequest, ModelsResponse } from '../../contracts/service.js';
import { NodeAdapter, OutputStore, validateBatchOutput, encodeJPEG, encodePNG } from '../node/index.js';
import { ensureAgentConfig, loadWorkflowConfig } from './config.js';
import { runPersistence } from './persistence.js';
import { paintPreviews } from './paint-preview.js';

class InlineAdapter extends NodeAdapter {
  async preview(image: PixelImage): Promise<string> { return `data:image/jpeg;base64,${encodeJPEG(image).toString('base64')}`; }
}
export interface DrawingServiceOptions { root: string; environment?: NodeJS.ProcessEnv; fetch?: typeof fetch }
export async function createDrawingService(options: DrawingServiceOptions) {
  const environment = options.environment ?? process.env;
  await ensureAgentConfig(options.root, environment.ARTBOARD_CONFIG_FILE || 'agents.local.json');
  const scenes = new Map<string, Scene>();
  const renderer = new PixelRenderer();
  const outputs = new OutputStore(resolve(options.root, 'outputs'), renderer);
  return async (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const url = new URL(request.url || '/', 'http://localhost');
    if (!['/api/runs', '/api/models'].includes(url.pathname)) { next(); return; }
    const jsonError = (status: number, message: string) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: message }));
    };
    if (request.method !== (url.pathname === '/api/models' ? 'GET' : 'POST')) { jsonError(405, url.pathname === '/api/models' ? 'Use GET to list models.' : 'Use POST to start a drawing.'); return; }
    // The service is local; reject cross-origin requests before reading credentials or contacting a model.
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}` && request.headers.origin !== `https://${request.headers.host}`) { jsonError(403, 'Cross-origin drawing requests are not allowed.'); return; }
    const controller = new AbortController();
    request.once('aborted', () => controller.abort());
    response.once('close', () => { if (!response.writableEnded) controller.abort(); });
    let runId: string | undefined;
    let persistence: ReturnType<typeof runPersistence> | undefined;
    try {
      if (url.pathname === '/api/models') {
        const config = await loadWorkflowConfig(options.root, environment);
        const models = await listModels(agentConfig(config.connection), options.fetch, controller.signal, 'all');
        const preferred = config.agents?.artist?.model || config.connection?.editor_model;
        const body: ModelsResponse = { models, selected_model: preferred && models.includes(preferred) ? preferred : models.find(isChatModelID) || models[0] };
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(body)); return;
      }
      let body = '';
      const decoder = new StringDecoder('utf8');
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 24000) { jsonError(413, 'Drawing request is too large.'); return; }
        body += decoder.write(chunk);
      }
      body += decoder.end();
      let input: DrawingRequest;
      try { input = JSON.parse(body); } catch { jsonError(400, 'Invalid drawing request JSON.'); return; }
      if (!input || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000 || (input.scene_id !== undefined && typeof input.scene_id !== 'string')) { jsonError(400, 'Use a prompt of 1 to 4000 characters and an optional scene_id.'); return; }
      if (input.model !== undefined && (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 256)) { jsonError(400, 'Use a model ID of 1 to 256 characters.'); return; }
      try { getWorkflow(input.layers); } catch (error) { jsonError(400, (error as Error).message); return; }
      try { if (input.batch !== undefined) validateBatchOutput(input.batch); } catch (error) { jsonError(400, (error as Error).message); return; }
      const base = input.scene_id === undefined ? undefined : scenes.get(input.scene_id);
      if (input.scene_id !== undefined && !base) { jsonError(404, 'The current scene is unavailable. Draw a new scene first.'); return; }
      const id = randomUUID(); runId = id;
      await outputs.record(id, { type: 'start', request: input });
      const config = await loadWorkflowConfig(options.root, environment);
      if (input.model !== undefined) {
        const model = input.model.trim();
        config.connection = { ...config.connection, editor_model: model, reviewer_model: model };
        // This freshly loaded request configuration preserves prompts and never writes local settings.
        config.agents = Object.fromEntries(AGENT_ROLES.map(role => [role, { ...config.agents?.[role], model }]));
      }
      controller.signal.throwIfAborted();
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      response.flushHeaders();
      const emit = (event: DrawingEvent) => { if (!controller.signal.aborted) response.write(JSON.stringify(event) + '\n'); };
      persistence = runPersistence(outputs, id, message => emit({ type: 'execution_error', message }));
      let previousScene = base;
      let operations: Operation[] | undefined;
      let responseNumber = 0;
      const onEvent = async (event: WorkflowEvent) => {
        await persistence!.capture(event);
        if (event.type === 'stage') { emit({ type: 'stage', name: event.stage.name, index: event.index, total: event.total }); return; }
        const item = event.event;
        if (item.type === 'state') emit({ type: 'state', state: item.state, tool: item.tool });
        if (item.type === 'phase') emit({ type: 'phase', role: item.role, round: item.round });
        if (item.type === 'response') responseNumber++;
        if (item.type === 'tool') {
          operations = item.ok && item.name === 'scene_apply' ? item.input.operations as Operation[] : undefined;
          emit({ type: 'tool', name: item.name, input: item.input, ok: item.ok, message: item.message });
        }
        if (item.type === 'thinking') emit({ type: 'thinking', text: item.text });
        if (item.type === 'transport_error') emit({ type: 'execution_error', message: item.message });
        if (item.type === 'response' && item.error) emit({ type: 'execution_error', message: item.error });
        if (item.type === 'preview') {
          const frames = paintPreviews(previousScene, item.scene, operations);
          for (const [index, frame] of frames.entries()) {
            if (operations) await outputs.snapshot(id, `paint-r${item.scene.revision}-${index + 1}`, frame.scene);
            emit({ type: 'preview', image: `data:image/png;base64,${encodePNG(renderer.render(frame.scene)).toString('base64')}`, group: `${id}:${responseNumber}`, style: frame.style });
          }
          previousScene = item.scene; operations = undefined;
        }
        if (item.type === 'review') emit({ type: 'review', approved: item.review.approved, issues: item.review.issues.map(issue => issue.instruction) });
        if (item.type === 'loop_detected') emit({ type: 'retry', message: 'Recovering repeated tool failures.' });
      };
      const started = Date.now();
      const directory = outputs.runFolder(id);
      const workflow = await runWorkflow({ prompt: input.prompt, layers: input.layers, initial_scene: base, config, fetch: options.fetch, signal: controller.signal, onEvent,
        createTools: () => new SceneTools(new SceneStore(), renderer, new InlineAdapter(directory)),
      });
      controller.signal.throwIfAborted();
      const result = workflow.result;
      if (result.stop_reason === 'completed') throw new Error('A final workflow result must be reviewed.');
      await persistence.finish(workflow);
      const outputPath = relative(options.root, await outputs.drawing(result.draft.scene, input.prompt, input.batch)).replace(/\\/g, '/');
      await outputs.record(id, { type: 'saved', output_path: outputPath, approved: result.approved, stop_reason: result.stop_reason });
      controller.signal.throwIfAborted();
      scenes.set(id, structuredClone(result.draft.scene));
      if (scenes.size > 50) scenes.delete(scenes.keys().next().value!);
      emit({ type: 'preview', image: `data:image/png;base64,${encodePNG(renderer.render(result.draft.scene)).toString('base64')}` });
      emit({ type: 'final', scene_id: id, approved: result.approved, stop_reason: result.stop_reason, error: result.error, duration_ms: Date.now() - started, output_path: outputPath });
      response.end();
    } catch (error) {
      if (runId) {
        try {
          await persistence?.flush();
          await outputs.record(runId, { type: controller.signal.aborted ? 'cancelled' : 'error', message: error instanceof Error ? error.message : String(error) });
        } catch (saveError) {
          if (!controller.signal.aborted && response.headersSent) response.write(JSON.stringify({ type: 'execution_error', message: `Output persistence failed: ${saveError instanceof Error ? saveError.message : String(saveError)}` } satisfies DrawingEvent) + '\n');
        }
      }
      if (controller.signal.aborted) { response.end(); return; }
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) jsonError(500, message);
      else { response.end(JSON.stringify({ type: 'error', message } satisfies DrawingEvent) + '\n'); }
    }
  };
}
