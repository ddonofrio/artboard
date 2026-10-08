import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText, ToolChoiceViolationError, type ModelMessage, type StepResult, type ToolSet } from 'ai';
import { BASIC_PALETTE, requireResult, type PixelImage, type Scene, type SceneTools, type ToolResult } from '../core/index.js';
import { agentConfig, listModels, type AgentConfig } from './config.js';
import { drawingRequest, EDITOR_INSTRUCTIONS, imageAssessmentPrompt, REVIEWER_INSTRUCTIONS } from './prompts.js';
import { agentTools, toolUsage, type DraftSubmission, type Handoff, type Review } from './tools.js';
import { drawingFeedback } from './feedback.js';
import { LoopDetector, type LoopDetection } from './plugins/loop-detector.js';
import { modelStream } from './stream.js';
import { drawingScene, namedColors } from './colors.js';

export interface AgentDraft { scene: Scene; preview: { image_ref: string; revision: number } }
type DrawingAgent = Omit<Parameters<typeof streamText<ToolSet>>[0], 'messages' | 'prompt'>;
/** Compatible servers can return a string error, an error object, or plain text. */
function serverError(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 4000);
  if (body && typeof body === 'object') {
    const value = body as Record<string, unknown>;
    if (typeof value.error === 'string' && value.error.trim()) return value.error.slice(0, 4000);
    if (value.error && typeof value.error === 'object' && typeof (value.error as Record<string, unknown>).message === 'string') return String((value.error as Record<string, unknown>).message).slice(0, 4000);
    if (typeof value.message === 'string' && value.message.trim()) return value.message.slice(0, 4000);
    return JSON.stringify(body).slice(0, 4000);
  }
  return fallback;
}
export interface AgentRunResult { draft: AgentDraft; reviews: Review[]; drafts: AgentDraft[]; models: { editor: string; reviewer: string }; approved: boolean; stop_reason: 'approved' | 'review_limit' | 'incomplete' | 'completed' | 'unreviewed'; error?: string; handoff?: Handoff }
export type AgentEvent =
  | { type: 'state'; role: 'editor' | 'reviewer'; round: number; state: 'idle' | 'processing_prompt' | 'thinking' | 'writing_tool_args' | 'executing_tool'; tool?: string }
  | { type: 'thinking'; role: 'editor' | 'reviewer'; round: number; id: string; final: boolean; text: string; tokens: number; tokens_estimated: boolean }
  | { type: 'tool_input'; role: 'editor' | 'reviewer'; round: number; call_id: string; name: string; input: string }
  | { type: 'connection'; base_url: string; models?: { editor: string; reviewer: string } }
  | { type: 'model'; role: 'editor' | 'reviewer'; round: number; model: string; step: number; state: 'request' | 'response'; output_tokens?: number }
  | { type: 'prompt'; role: 'editor' | 'reviewer'; round: number; step: number; content: string }
  | { type: 'response'; role: 'editor' | 'reviewer'; round: number; status: number; finish_reason?: string; output_tokens?: number; text?: string; tool_calls?: unknown; error?: string }
  | { type: 'statistics'; role: 'editor' | 'reviewer'; round: number; model: string; duration_ms: number; usage: Record<string, number>; timings: Record<string, number> }
  | { type: 'transport_error'; role: 'editor' | 'reviewer'; round: number; message: string }
  | { type: 'loop_detected'; role: 'editor' | 'reviewer'; round: number; detection: LoopDetection }
  | { type: 'phase'; role: 'editor' | 'reviewer'; round: number }
  | { type: 'tool'; role: 'editor' | 'reviewer'; round: number; call_id?: string; name: string; ok: boolean; revision?: number; message?: string; input: Record<string, unknown>; applied_input?: Record<string, unknown>; output: ToolResult }
  | { type: 'preview'; role: 'editor' | 'reviewer'; round: number; scene: Scene; preview: AgentDraft['preview']; source: string; changed_pixels: number; affected_ids: string[] }
  | { type: 'draft'; round: number; draft: AgentDraft }
  | { type: 'review'; round: number; review: Review }
  | { type: 'final'; result: AgentRunResult };
export interface AgentRunOptions {
  prompt: string;
  config?: Partial<AgentConfig>;
  tools: SceneTools;
  scene_id?: string;
  initial_scene?: Scene;
  /** Isolated workflow stage; the original editor/reviewer loop remains the default. */
  stage?: { instructions: string; context: Record<string, unknown>; final: boolean; handoff?: boolean };
  reviewer_instructions?: string;
  /** Optional per-editor-step ceiling, useful for short exploratory runs. */
  max_steps?: number;
  review?: boolean;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onEvent?: ((event: AgentEvent) => void) | ((event: AgentEvent) => Promise<void>);
}

function phaseMessages(text: string, previews: AgentDraft['preview'][] = [], assessment?: string): ModelMessage[] {
  if (!previews.length) return [{ role: 'user', content: text }];
  return [{ role: 'user', content: [{ type: 'text', text }, ...(assessment ? [{ type: 'text' as const, text: assessment }] : []), ...previews.map(preview => {
    const format = /^data:(image\/(?:jpeg|png));base64,/.exec(preview.image_ref);
    if (!format) throw new Error('Vision requires a preview adapter that returns inline JPEG or PNG data URLs.');
    return { type: 'file' as const, data: new URL(preview.image_ref), mediaType: format[1] };
  })] }];
}
/** Requested images expire after one inference, including retained review history. */
function withoutImages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map(message => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message;
    const text = message.content.find(part => part.type === 'text')?.text;
    if (!text) throw new Error('An image-bearing model message is missing its JSON drawing context.');
    const context = JSON.parse(text) as Record<string, unknown>;
    return { role: 'user', content: JSON.stringify({ ...context, image_attached: false }) };
  });
}
/** Run diagnostics preserve message content while omitting image bytes and reasoning. */
function debugPrompt(system: string, messages: ModelMessage[]): string {
  return JSON.stringify({ system, messages }, (_key, value) => {
    if (typeof value === 'string' && value.startsWith('data:image/')) return `[${value.slice(5, value.indexOf(';'))} attached; binary omitted]`;
    if (value && typeof value === 'object' && value.type === 'reasoning') return { type: 'reasoning', text: '[omitted]' };
    return value;
  }, 2);
}

/** Review approval ends the workflow; rejected drafts feed the next editor pass. */
export async function runAgentLoop(options: AgentRunOptions): Promise<AgentRunResult> {
  const config = agentConfig(options.config), host = options.tools, sceneId = options.scene_id ?? 'artboard';
  const editorBase = options.stage?.instructions ?? EDITOR_INSTRUCTIONS;
  const reviewerInstructions = options.reviewer_instructions ? `${REVIEWER_INSTRUCTIONS}\n${options.reviewer_instructions}` : REVIEWER_INSTRUCTIONS;
  let handoff: Handoff | undefined;
  if (typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > 4000) throw new Error('Write a prompt of 1 to 4000 characters.');
  options.signal?.throwIfAborted();
  // The caller supplies an isolated draft host; reject an occupied host to avoid
  // mutating an accepted scene or sharing a run's state with another run.
  try { host.store.get(sceneId); throw new Error('Use a fresh draft scene store for each agent run.'); }
  catch (error) { if (!(error instanceof Error) || !error.message.startsWith('Scene not found:')) throw error; }
  if (options.initial_scene) host.store.load(sceneId, { ...options.initial_scene, palette: structuredClone(BASIC_PALETTE) });
  else host.store.create({ scene_id: sceneId, width: 640, height: 480 });
  const emit = (event: AgentEvent) => options.onEvent?.(event);
  emit({ type: 'connection', base_url: config.base_url });
  const editorModel = config.editor_model || (await listModels(config, options.fetch, options.signal))[0];
  const reviewerModel = config.reviewer_model || editorModel;
  emit({ type: 'connection', base_url: config.base_url, models: { editor: editorModel, reviewer: reviewerModel } });
  let activeRole: 'editor' | 'reviewer' = 'editor', activeRound = 0;
  let requestNumber = 0;
  const pendingCalls: { id: string; name: string; reported: boolean }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const started = performance.now();
    await emit({ type: 'state', role: activeRole, round: activeRound, state: 'processing_prompt' });
    options.signal?.throwIfAborted();
    let response: Response;
    try { response = await (options.fetch ?? globalThis.fetch)(input, init); }
    catch (error) {
      const timedOut = !options.signal?.aborted && (init?.signal?.aborted || (error instanceof Error && /timeout|timed out/i.test(`${error.name} ${error.message}`)));
      const duration = config.timeout_ms % 60000 === 0 ? `${config.timeout_ms / 60000} minutes` : `${config.timeout_ms / 1000} seconds`;
      const message = timedOut ? `${activeRole === 'editor' ? 'Editor' : 'Reviewer'} · request ${phaseSteps + 1}: timed out after ${duration} waiting for a model response.` : error instanceof Error ? error.message : String(error);
      await emit({ type: 'transport_error', role: activeRole, round: activeRound, message });
      if (timedOut) throw new Error(message, { cause: error });
      throw error;
    }
    if (!response.ok) {
      const raw = await response.clone().text();
      let body;
      try { body = JSON.parse(raw); } catch { body = undefined; }
      const error = response.ok ? undefined : serverError(body ?? raw, `${response.status} ${response.statusText}`);
      await emit({ type: 'response', role: activeRole, round: activeRound, status: response.status, error });
      return Response.json({ error: { message: `HTTP ${response.status} · ${activeRole === 'editor' ? 'Editor' : 'Reviewer'} · ${error}` } }, { status: response.status, statusText: response.statusText });
    }
    const request = ++requestNumber, role = activeRole, round = activeRound;
    let generationState = 'processing_prompt', generationTool = '';
    pendingCalls.length = 0;
    return modelStream(response, async event => {
      if (event.type === 'thinking') {
        if (event.active && generationState !== 'thinking') {
          generationState = 'thinking';
          await emit({ type: 'state', role, round, state: 'thinking' });
        }
        await emit({ ...event, role, round, id: `${request}:thinking` });
      }
      else if (event.type === 'tool_input') {
        const id = `${request}:${event.call_id}`;
        const pending = pendingCalls.find(call => call.id === id);
        if (pending) pending.name = event.name;
        else pendingCalls.push({ id, name: event.name, reported: false });
        if (generationState !== 'writing_tool_args' || generationTool !== event.name) await emit({ type: 'state', role, round, state: 'writing_tool_args', tool: event.name });
        generationState = 'writing_tool_args';
        generationTool = event.name;
        await emit({ ...event, role, round, call_id: id });
      } else {
        await emit({ ...event, role, round, status: response.status });
        await emit({ type: 'statistics', role, round, model: role === 'editor' ? editorModel : reviewerModel, duration_ms: performance.now() - started, usage: event.usage, timings: event.timings });
      }
    });
  };
  const provider = createOpenAICompatible({ name: 'local', baseURL: config.base_url, apiKey: config.api_key || undefined, fetch: fetcher, includeUsage: true, supportsStructuredOutputs: false, transformRequestBody: body => ({ ...body, parallel_tool_calls: false, ...(config.reasoning_effort ? { reasoning_effort: config.reasoning_effort } : {}) }) });
  const consume = async (agent: DrawingAgent, messages: ModelMessage[]) => {
    const response = streamText({ ...agent, messages, abortSignal: options.signal, streamRetries: 0, onError: () => {} });
    try {
      let failure: unknown;
      for await (const part of response.fullStream) if (part.type === 'error') failure ??= part.error;
      options.signal?.throwIfAborted();
      if (failure !== undefined) throw failure;
      return await response.finalStep;
    } catch (error) {
      options.signal?.throwIfAborted();
      // An enforced tool choice plus finish_reason=length means this response
      // spent its output budget thinking without reaching a tool call. The
      // editor loop can recover with a fresh request and current canvas.
      if (ToolChoiceViolationError.isInstance(error)) throw error;
      const duration = config.timeout_ms % 60000 === 0 ? `${config.timeout_ms / 60000} minutes` : `${config.timeout_ms / 1000} seconds`;
      const timedOut = error instanceof Error && /timeout|timed out/i.test(`${error.name} ${error.message}`);
      const message = timedOut ? `${activeRole === 'editor' ? 'Editor' : 'Reviewer'} · request ${phaseSteps + 1}: timed out after ${duration} waiting for a model response.` : error instanceof Error ? error.message : String(error);
      await emit({ type: 'transport_error', role: activeRole, round: activeRound, message });
      throw timedOut ? new Error(message, { cause: error }) : error;
    }
  };
  let phaseSteps = 0, edits = 0, rejectedTools = 0, lastToolError = '';
  const loopDetectors = { editor: new LoopDetector(), reviewer: new LoopDetector() };
  const phaseFailure = (role: string, submissionTool: string) => {
    const reason = 'the response ended without submission';
    return `${role}: ${reason}; missing ${submissionTool}. ${phaseSteps} requests, ${edits} applied edits, ${rejectedTools} rejected tools.${lastToolError ? ` Last rejection: ${lastToolError}` : ''}`;
  };
  const reportStep = (role: 'editor' | 'reviewer', round: number, model: string) => async (event: StepResult<ToolSet>) => {
    loopDetectors[role].onStepFinish(event);
    phaseSteps = event.stepNumber + 1;
    for (const part of event.content) if (part.type === 'tool-error') {
      const cause = part.error instanceof Error ? part.error.message : String(part.error);
      const message = `${part.toolName}: ${cause} Usage: ${toolUsage(part.toolName)}`;
      rejectedTools++; lastToolError = message;
      await emit({ type: 'tool', role, round, name: part.toolName, ok: false, message, input: part.input && typeof part.input === 'object' && !Array.isArray(part.input) ? part.input as Record<string, unknown> : { input: part.input }, output: { ok: false, error: { code: 'SDK_TOOL_ERROR', message } } });
    }
    await emit({ type: 'model', role, round, model, step: event.stepNumber + 1, state: 'response', output_tokens: event.usage.outputTokens });
  };
  const reviews: Review[] = [], drafts: AgentDraft[] = [];
  let draft: AgentDraft | undefined;
  let lastImage: PixelImage | undefined;
  {
    const preview = requireResult<AgentDraft['preview']>(await host.scene_render({ scene_id: sceneId }));
    draft = { scene: host.store.get(sceneId), preview };
    lastImage = host.renderer.render(draft.scene);
  }
  const deliver = async (stop_reason: AgentRunResult['stop_reason'], error?: string): Promise<AgentRunResult> => {
    options.signal?.throwIfAborted();
    const scene = host.store.get(sceneId);
    const preview = requireResult<AgentDraft['preview']>(await host.scene_render({ scene_id: sceneId }));
    draft = { scene, preview };
    if (drafts.at(-1)?.scene.revision !== scene.revision) {
      drafts.push(structuredClone(draft));
      await emit({ type: 'draft', round: activeRound, draft: structuredClone(draft) });
    }
    const result: AgentRunResult = { draft, reviews, drafts, models: { editor: editorModel, reviewer: reviewerModel }, approved: stop_reason === 'approved', stop_reason, ...(error ? { error } : {}), ...(handoff ? { handoff } : {}) };
    await emit({ type: 'state', role: activeRole, round: activeRound, state: 'idle' });
    await emit({ type: 'final', result: structuredClone(result) });
    return result;
  };
  const incomplete = async (error: unknown, ended = false): Promise<AgentRunResult> => {
    options.signal?.throwIfAborted();
    // Preserve the prepared canvas after a model response or edits; an initial
    // transport failure has no model result to deliver.
    try { if (!ended && phaseSteps === 0 && !options.initial_scene && host.store.get(sceneId).revision === 0) throw error; }
    catch (missing) {
      if (!(missing instanceof Error && missing.message.startsWith('Scene not found:'))) throw missing;
      throw error;
    }
    return deliver('incomplete', error instanceof Error ? error.message : String(error));
  };
  let correctionApplied = false, noVisibleCorrection = false, correctionUsed = false, correctedImageDelivered = false;
  let correctedImageRevision: number | undefined, lastViewedRevision: number | undefined;
  const requestedImages: Record<'editor' | 'reviewer', AgentDraft['preview'][]> = { editor: [], reviewer: [] };
  const reportTool = (role: 'editor' | 'reviewer') => async (name: string, result: ToolResult, input: Record<string, unknown>, appliedInput?: Record<string, unknown>) => {
      const round = activeRound;
      if (name === 'scene_render' && result.ok && config.vision) {
        const preview = { image_ref: String(result.result.image_ref), revision: Number(result.result.revision) };
        requestedImages[role].push(preview);
        if (role === 'editor' && correctionUsed) correctedImageRevision = preview.revision;
      }
      if (!result.ok) { rejectedTools++; lastToolError = result.error.message; }
      else if (name === 'scene_apply' || name === 'scene_history') edits++;
      // Every completed tool exposes the current drawing, including inspection
      // and failed edits. Catalog discovery can happen before a scene exists.
      let scene: Scene | undefined;
      try { scene = host.store.get(sceneId); }
      catch (error) { if (!(error instanceof Error && error.message.startsWith('Scene not found:'))) throw error; }
      let changedPixels = 0;
      if (scene) {
        const image = host.renderer.render(scene);
        const color = scene.palette.colors[scene.palette.colors.length - 1];
        const blank = [1,3,5].map(start => parseInt(color.slice(start, start + 2), 16));
        for (let offset = 0; offset < image.data.length; offset += 4) {
          if (image.data[offset] !== (lastImage?.data[offset] ?? blank[0]) || image.data[offset + 1] !== (lastImage?.data[offset + 1] ?? blank[1]) || image.data[offset + 2] !== (lastImage?.data[offset + 2] ?? blank[2])) changedPixels++;
        }
        lastImage = image;
        if (role === 'editor' && result.ok && changedPixels > 0 && ['scene_apply', 'scene_history', 'scene_io'].includes(name)) correctionApplied = true;
        if (role === 'editor' && name === 'scene_apply' && result.ok && lastViewedRevision === scene.revision - 1) {
          correctionUsed = true;
          if (changedPixels === 0) noVisibleCorrection = true;
        }
        if (result.ok && ['scene_inspect', 'scene_apply', 'scene_history'].includes(name)) {
          result.result.changed_pixels = changedPixels;
          const ids = result.result.affected_ids;
          result.result.feedback = drawingFeedback(host, scene, changedPixels, Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
        }
      }
      const call = pendingCalls.find(call => call.name === name && !call.reported);
      if (call) call.reported = true;
      await emit({ type: 'tool', role, round, call_id: call?.id, name, ok: result.ok, input: structuredClone(input), ...(result.ok && name === 'scene_apply' && appliedInput ? { applied_input: structuredClone(appliedInput) } : {}), output: structuredClone(result), ...(result.ok ? { revision: result.result.revision as number | undefined } : { message: result.error.message }) });
      if (scene) {
        const preview = requireResult<AgentDraft['preview']>(await host.scene_render({ scene_id: sceneId }));
        const affected = result.ok ? result.result.affected_ids : undefined;
        await emit({ type: 'preview', role, round, scene, preview, source: name, changed_pixels: changedPixels, affected_ids: Array.isArray(affected) ? affected.filter((id): id is string => typeof id === 'string') : [] });
      }
  };
  const reviewState: { value?: Review } = {};
  const toolStarted = (role: 'editor' | 'reviewer') => (name: string) => emit({ type: 'state', role, round: activeRound, state: 'executing_tool', tool: name });
  const currentReview = (): Review | undefined => reviewState.value;
  const reviewerMessages: ModelMessage[] = [];
  let reviewerRequestMessages: ModelMessage[] = [];
  const reviewer: DrawingAgent = {
    model: provider.chatModel(reviewerModel), instructions: reviewerInstructions,
    tools: agentTools(host, sceneId, 'reviewer', options.signal, reportTool('reviewer'), () => {}, value => { reviewState.value = value; }, () => handoff?.not_done.length ? `The final artist reports unresolved requirements: ${JSON.stringify(handoff.not_done)}. Return actionable corrections instead of approval.` : undefined, false, toolStarted('reviewer'), config.vision),
    toolChoice: 'required', maxRetries: 0, maxOutputTokens: config.max_output_tokens,
    timeout: { stepMs: config.timeout_ms }, stopWhen: () => reviewState.value !== undefined,
    prepareStep: async ({ messages, initialMessages }) => {
      await emit({ type: 'state', role: 'reviewer', round: activeRound, state: 'processing_prompt' });
      const recovery = loopDetectors.reviewer.prepareStep({ initialInstructions: reviewerInstructions, initialMessages });
      if (recovery) await emit({ type: 'loop_detected', role: 'reviewer', round: activeRound, detection: recovery.detection });
      const updatedMessages = withoutImages(recovery?.messages ?? messages);
      const previews = requestedImages.reviewer.splice(0);
      const userIndex = updatedMessages.map(message => message.role).lastIndexOf('user');
      if (userIndex >= 0) {
        const context = JSON.parse(updatedMessages[userIndex].content as string);
        updatedMessages[userIndex] = phaseMessages(JSON.stringify({ ...context, image_attached: previews.length > 0 }), previews, imageAssessmentPrompt(options.prompt, 'reviewer'))[0];
      }
      return { instructions: recovery?.instructions ?? reviewerInstructions, messages: updatedMessages };
    },
    onStepStart: event => {
      reviewerRequestMessages = event.messages;
      emit({ type: 'prompt', role: 'reviewer', round: activeRound, step: event.stepNumber + 1, content: debugPrompt(reviewerInstructions, event.messages) });
      emit({ type: 'model', role: 'reviewer', round: activeRound, model: reviewerModel, step: event.stepNumber + 1, state: 'request' });
    },
    onStepFinish: event => reportStep('reviewer', activeRound, reviewerModel)(event),
  };
  for (let round = 1; round <= config.max_reviews; round++) {
    options.signal?.throwIfAborted();
    activeRole = 'editor'; activeRound = round;
    requestedImages.editor.length = 0;
    phaseSteps = 0; edits = 0; rejectedTools = 0; lastToolError = ''; correctionApplied = false; noVisibleCorrection = false;
    correctionUsed = false; correctedImageDelivered = false; correctedImageRevision = undefined; lastViewedRevision = undefined;
    emit({ type: 'phase', role: 'editor', round });
    let submission: DraftSubmission | undefined;
    let preparedRevision: number | undefined;
    const pendingReview = reviews.at(-1);
    const editorTools = agentTools(host, sceneId, 'editor', options.signal, reportTool('editor'), value => { submission = value; }, () => {}, revision => {
      if (config.vision && edits > 0 && lastViewedRevision !== revision) return `Revision ${revision} has edits the model has not visually checked. Call scene_render alone, inspect the image in the next response, and submit that unchanged revision.`;
      if (revision !== preparedRevision) return 'The drawing changed within this response. Check its updated JSON in the next model request, or call scene_render for visual inspection, before calling finish_draft alone. Complete every requested element before submitting.';
      if (pendingReview && (revision === pendingReview.revision || !correctionApplied)) return `The reviewer rejected revision ${pendingReview.revision}. Apply visible corrections with scene_apply before calling finish_draft. Pending corrections: ${JSON.stringify(pendingReview.issues)}`;
    }, !!options.stage?.handoff, toolStarted('editor'), config.vision, options.review !== false, name => {
      if (name === 'scene_apply' && correctedImageDelivered) return 'This pass has already made and checked its one focused correction. Submit the current revision now.';
    });
    const editor: DrawingAgent = {
      model: provider.chatModel(editorModel), instructions: editorBase,
      tools: editorTools, toolChoice: 'required', maxRetries: 0, maxOutputTokens: config.max_output_tokens,
      timeout: { stepMs: config.timeout_ms }, stopWhen: ({ steps }) => submission !== undefined || noVisibleCorrection || (correctedImageDelivered && steps.length > 0) || (options.max_steps !== undefined && steps.length >= options.max_steps),
      prepareStep: async ({ messages, initialMessages }) => {
        await emit({ type: 'state', role: 'editor', round, state: 'processing_prompt' });
        const recovery = loopDetectors.editor.prepareStep({ initialInstructions: editorBase, initialMessages });
        if (recovery) await emit({ type: 'loop_detected', role: 'editor', round, detection: recovery.detection });
        const contextMessages = withoutImages(recovery?.messages ?? messages);
        let current: Scene;
        try { current = host.store.get(sceneId); }
        catch (error) {
          if (!(error instanceof Error && error.message.startsWith('Scene not found:'))) throw error;
          throw new Error('The prepared canvas is unavailable. Start a new drawing with a fresh scene host.');
        }
        const previews = requestedImages.editor.splice(0);
        if (previews.length) {
          lastViewedRevision = previews.at(-1)!.revision;
          if (correctionUsed && previews.some(preview => preview.revision === correctedImageRevision)) correctedImageDelivered = true;
        }
        const context = JSON.stringify(namedColors({ ...JSON.parse(text), current_scene: drawingScene(current), image_attached: previews.length > 0 }));
        const currentMessage = phaseMessages(context, previews, imageAssessmentPrompt(options.prompt, 'editor'))[0];
        // Append new state instead of rewriting the cached conversation prefix.
        const updatedMessages = recovery ? [...contextMessages.slice(0, -1), currentMessage] : contextMessages.some(message => message.role === 'assistant' || message.role === 'tool') || previews.length ? [...contextMessages, currentMessage] : contextMessages;
        preparedRevision = current.revision;
        return { instructions: editorBase, messages: updatedMessages };
      },
      onStepStart: event => {
        emit({ type: 'prompt', role: 'editor', round, step: event.stepNumber + 1, content: debugPrompt(editorBase, event.messages) });
        emit({ type: 'model', role: 'editor', round, model: editorModel, step: event.stepNumber + 1, state: 'request' });
      },
      onStepFinish: reportStep('editor', round, editorModel),
    };
    let text = drawingRequest(options.prompt, { scene_id: sceneId, round, review: pendingReview ?? null, current_scene: drawingScene(host.store.get(sceneId)), image_attached: false, vision_available: config.vision, ...(options.stage ? { workflow: options.stage.context } : {}) });
    while (!submission) {
      try {
        await consume(editor, phaseMessages(text));
        if (!submission && (noVisibleCorrection || correctedImageDelivered)) submission = { revision: host.store.get(sceneId).revision };
        if (!submission && options.max_steps !== undefined && phaseSteps >= options.max_steps) return incomplete(new Error(`Stopped after ${options.max_steps} editor tool steps.`), true);
      } catch (error) {
        options.signal?.throwIfAborted();
        if (!ToolChoiceViolationError.isInstance(error) || error.finishReason !== 'length') return incomplete(error);

        // Discard the exhausted conversation. Re-present the original request
        // and a fresh snapshot so the next inference can continue from what is
        // actually on the canvas instead of repeating blind reasoning.
        const scene = host.store.get(sceneId);
        const preview = requireResult<AgentDraft['preview']>(await host.scene_render({ scene_id: sceneId }));
        requestedImages.editor.length = 0;
        if (config.vision) requestedImages.editor.push(preview);
        text = drawingRequest(options.prompt, {
          scene_id: sceneId,
          round,
          review: pendingReview ?? null,
          current_scene: drawingScene(scene),
          image_attached: false,
          vision_available: config.vision,
          continuation: 'A previous fresh response exhausted its output tokens before calling a tool. Continue the original user request from the current canvas shown here. Preserve completed work, do not repeat successful edits, identify what remains, and take the next concrete action. If the request is complete, call finish_draft with the current revision.',
          ...(options.stage ? { workflow: options.stage.context } : {}),
        });
      }
    }
    options.signal?.throwIfAborted();
    if (!submission) return incomplete(new Error(phaseFailure('Editor', 'finish_draft')), true);
    const scene = host.store.get(sceneId);
    if (submission.revision !== scene.revision) return incomplete(new Error('Editor changed the scene after submitting it. The current canvas is delivered without review.'));
    if (options.stage?.handoff) handoff = { done: submission.done!, not_done: submission.not_done! };
    const preview = requireResult<AgentDraft['preview']>(await host.scene_render({ scene_id: sceneId }));
    draft = { scene, preview };
    drafts.push(structuredClone(draft));
    emit({ type: 'draft', round, draft: structuredClone(draft) });

    if (options.stage && !options.stage.final) return deliver('completed');
    if (options.stage?.final && options.stage.handoff && options.review === false) return deliver('completed');
    if (options.review === false) return deliver('unreviewed');

    activeRole = 'reviewer';
    requestedImages.reviewer.length = 0;
    // Every review starts with the exact submitted draft, independently of
    // whether the editor chose to look at it. Later looks remain on demand.
    if (config.vision) requestedImages.reviewer.push(draft.preview);
    phaseSteps = 0; edits = 0; rejectedTools = 0; lastToolError = '';
    emit({ type: 'phase', role: 'reviewer', round });
    reviewState.value = undefined;
    reviewerMessages.push(...phaseMessages(drawingRequest(options.prompt, { scene_id: sceneId, round, previous_review: pendingReview ?? null, draft: { scene: drawingScene(draft.scene) }, image_attached: false, vision_available: config.vision, ...(handoff ? { final_handoff: handoff } : {}) })));
    try {
      const response = await consume(reviewer, reviewerMessages);
      // Persist the actual prepared context so a recovery stays effective in
      // later rounds instead of restoring the discarded SDK retry history.
      reviewerMessages.splice(0, reviewerMessages.length, ...reviewerRequestMessages, ...response.response.messages);
    } catch (error) { return incomplete(error); }
    options.signal?.throwIfAborted();
    const review = currentReview();
    if (!review) return incomplete(new Error(phaseFailure('Reviewer', 'submit_review')));
    if (review.revision !== draft.scene.revision) return incomplete(new Error('Review revision does not match the draft.'));
    reviews.push(structuredClone(review));
    emit({ type: 'review', round, review: structuredClone(review) });
    options.signal?.throwIfAborted();
    if (review.approved) return deliver('approved');
  }
  return deliver('review_limit');
}
