import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ToolLoopAgent, type ModelMessage, type StepResult, type ToolSet } from 'ai';
import { requireResult, type PixelImage, type Scene, type SceneTools, type ToolResult } from '../core/index.js';
import { agentConfig, listModels, type AgentConfig } from './config.js';
import { EDITOR_INSTRUCTIONS, REVIEWER_INSTRUCTIONS } from './prompts.js';
import { agentTools, type DraftSubmission, type Handoff, type Review } from './tools.js';
import { drawingFeedback } from './feedback.js';
import { LoopDetector, type LoopDetection } from './plugins/loop-detector.js';

export interface AgentDraft { scene: Scene; preview: { image_ref: string; revision: number } }
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
export interface AgentRunResult { draft: AgentDraft; reviews: Review[]; drafts: AgentDraft[]; models: { editor: string; reviewer: string }; approved: boolean; stop_reason: 'approved' | 'review_limit' | 'incomplete' | 'completed'; error?: string; handoff?: Handoff }
export type AgentEvent =
  | { type: 'thinking'; role: 'editor' | 'reviewer'; round: number; text: string }
  | { type: 'connection'; base_url: string; models?: { editor: string; reviewer: string } }
  | { type: 'model'; role: 'editor' | 'reviewer'; round: number; model: string; step: number; state: 'request' | 'response'; output_tokens?: number }
  | { type: 'prompt'; role: 'editor' | 'reviewer'; round: number; step: number; content: string }
  | { type: 'response'; role: 'editor' | 'reviewer'; round: number; status: number; finish_reason?: string; output_tokens?: number; text?: string; tool_calls?: unknown; error?: string }
  | { type: 'transport_error'; role: 'editor' | 'reviewer'; round: number; message: string }
  | { type: 'loop_detected'; role: 'editor' | 'reviewer'; round: number; detection: LoopDetection }
  | { type: 'phase'; role: 'editor' | 'reviewer'; round: number }
  | { type: 'tool'; role: 'editor' | 'reviewer'; round: number; name: string; ok: boolean; revision?: number; message?: string; input: Record<string, unknown>; output: ToolResult }
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
  stage?: { instructions: string; context: Record<string, unknown>; final: boolean };
  reviewer_instructions?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onEvent?: ((event: AgentEvent) => void) | ((event: AgentEvent) => Promise<void>);
}

function phaseMessages(text: string, draft: AgentDraft | undefined, vision: boolean): ModelMessage[] {
  if (!draft || !vision) return [{ role: 'user', content: text }];
  const format = /^data:(image\/(?:jpeg|png));base64,/.exec(draft.preview.image_ref);
  if (!format) throw new Error('Vision requires a preview adapter that returns inline JPEG or PNG data URLs.');
  return [{ role: 'user', content: [{ type: 'text', text }, { type: 'file', data: new URL(draft.preview.image_ref), mediaType: format[1] }] }];
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
  if (options.initial_scene) host.store.load(sceneId, options.initial_scene);
  const emit = (event: AgentEvent) => options.onEvent?.(event);
  emit({ type: 'connection', base_url: config.base_url });
  const editorModel = config.editor_model || (await listModels(config, options.fetch, options.signal))[0];
  const reviewerModel = config.reviewer_model || editorModel;
  emit({ type: 'connection', base_url: config.base_url, models: { editor: editorModel, reviewer: reviewerModel } });
  let activeRole: 'editor' | 'reviewer' = 'editor', activeRound = 0;
  const fetcher: typeof fetch = async (input, init) => {
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
    if (options.onEvent || !response.ok) {
      const raw = await response.clone().text();
      let body;
      try { body = JSON.parse(raw); } catch { body = undefined; }
      const error = response.ok ? undefined : serverError(body ?? raw, `${response.status} ${response.statusText}`);
      const choice = body?.choices?.[0];
      const message = choice?.message;
      const reasoning = typeof message?.reasoning_content === 'string' ? message.reasoning_content : typeof message?.reasoning === 'string' ? message.reasoning : typeof message?.content === 'string' ? [...message.content.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/g)].map(match => match[1]).join('\n') : '';
      if (reasoning.trim()) await emit({ type: 'thinking', role: activeRole, round: activeRound, text: reasoning.trim().slice(0, 8000) });
      const text = typeof choice?.message?.content === 'string' ? choice.message.content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '[reasoning omitted]') : undefined;
      await emit({ type: 'response', role: activeRole, round: activeRound, status: response.status, finish_reason: choice?.finish_reason, output_tokens: body?.usage?.completion_tokens, text, tool_calls: choice?.message?.tool_calls, error });
      if (!response.ok) {
        // Preserve the HTTP status while supplying the standard error shape to
        // the provider, so the same detail reaches the calling application.
        return Response.json({ error: { message: `HTTP ${response.status} · ${activeRole === 'editor' ? 'Editor' : 'Reviewer'} · ${error}` } }, { status: response.status, statusText: response.statusText });
      }
    }
    return response;
  };
  const provider = createOpenAICompatible({ name: 'local', baseURL: config.base_url, apiKey: config.api_key || undefined, fetch: fetcher, supportsStructuredOutputs: false, transformRequestBody: body => ({ ...body, parallel_tool_calls: false }) });
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
      const message = part.error instanceof Error ? part.error.message : String(part.error);
      rejectedTools++; lastToolError = message;
      await emit({ type: 'tool', role, round, name: part.toolName, ok: false, message, input: part.input && typeof part.input === 'object' && !Array.isArray(part.input) ? part.input as Record<string, unknown> : { input: part.input }, output: { ok: false, error: { code: 'SDK_TOOL_ERROR', message } } });
    }
    await emit({ type: 'model', role, round, model, step: event.stepNumber + 1, state: 'response', output_tokens: event.usage.outputTokens });
  };
  const reviews: Review[] = [], drafts: AgentDraft[] = [];
  let draft: AgentDraft | undefined;
  let lastImage: PixelImage | undefined;
  if (options.initial_scene) {
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
    await emit({ type: 'final', result: structuredClone(result) });
    return result;
  };
  const incomplete = async (error: unknown): Promise<AgentRunResult> => {
    options.signal?.throwIfAborted();
    // A valid canvas remains deliverable even without a model submission.
    // Before creation there is no generated image to preserve.
    try { host.store.get(sceneId); }
    catch (missing) {
      if (!(missing instanceof Error && missing.message.startsWith('Scene not found:'))) throw missing;
      throw error;
    }
    return deliver('incomplete', error instanceof Error ? error.message : String(error));
  };
  let correctionApplied = false;
  const reportTool = (role: 'editor' | 'reviewer') => async (name: string, result: ToolResult, input: Record<string, unknown>) => {
      const round = activeRound;
      if (!result.ok) { rejectedTools++; lastToolError = result.error.message; }
      else if (name === 'scene_apply') edits++;
      // Every completed tool exposes the current drawing, including inspection
      // and failed edits. Catalog discovery can happen before a scene exists.
      let scene: Scene | undefined;
      try { scene = host.store.get(sceneId); }
      catch (error) { if (!(error instanceof Error && error.message.startsWith('Scene not found:'))) throw error; }
      let changedPixels = 0;
      if (scene) {
        const image = host.renderer.render(scene);
        const color = scene.palette.colors[0];
        const blank = [1,3,5].map(start => parseInt(color.slice(start, start + 2), 16));
        for (let offset = 0; offset < image.data.length; offset += 4) {
          if (image.data[offset] !== (lastImage?.data[offset] ?? blank[0]) || image.data[offset + 1] !== (lastImage?.data[offset + 1] ?? blank[1]) || image.data[offset + 2] !== (lastImage?.data[offset + 2] ?? blank[2])) changedPixels++;
        }
        lastImage = image;
        if (role === 'editor' && result.ok && changedPixels > 0 && ['scene_apply', 'scene_history', 'scene_io'].includes(name)) correctionApplied = true;
        if (result.ok && ['scene_create', 'scene_apply', 'scene_history', 'scene_io'].includes(name)) {
          result.result.changed_pixels = changedPixels;
          const ids = result.result.affected_ids;
          result.result.feedback = drawingFeedback(host, scene, changedPixels, Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
        }
      }
      await emit({ type: 'tool', role, round, name, ok: result.ok, input: structuredClone(input), output: structuredClone(result), ...(result.ok ? { revision: result.result.revision as number | undefined } : { message: result.error.message }) });
      if (scene) {
        const preview = requireResult<AgentDraft['preview']>(await host.scene_render({ scene_id: sceneId }));
        const affected = result.ok ? result.result.affected_ids : undefined;
        await emit({ type: 'preview', role, round, scene, preview, source: name, changed_pixels: changedPixels, affected_ids: Array.isArray(affected) ? affected.filter((id): id is string => typeof id === 'string') : [] });
      }
  };
  const reviewState: { value?: Review } = {};
  const currentReview = (): Review | undefined => reviewState.value;
  const reviewerMessages: ModelMessage[] = [];
  let reviewerRequestMessages: ModelMessage[] = [];
  const reviewer = new ToolLoopAgent({
    id: 'scene-reviewer', model: provider.chatModel(reviewerModel), instructions: reviewerInstructions,
    tools: agentTools(host, sceneId, 'reviewer', options.signal, reportTool('reviewer'), () => {}, value => { reviewState.value = value; }, () => handoff?.not_done.length ? `The final artist reports unresolved requirements: ${JSON.stringify(handoff.not_done)}. Return actionable corrections instead of approval.` : undefined),
    toolChoice: 'required', maxRetries: 0, maxOutputTokens: config.max_output_tokens,
    timeout: { stepMs: config.timeout_ms }, stopWhen: () => reviewState.value !== undefined,
    prepareStep: async ({ messages, initialMessages }) => {
      const recovery = loopDetectors.reviewer.prepareStep({ initialInstructions: reviewerInstructions, initialMessages });
      if (recovery) await emit({ type: 'loop_detected', role: 'reviewer', round: activeRound, detection: recovery.detection });
      return { instructions: recovery?.instructions ?? reviewerInstructions, messages: recovery?.messages ?? messages };
    },
    onStepStart: event => {
      reviewerRequestMessages = event.messages;
      emit({ type: 'prompt', role: 'reviewer', round: activeRound, step: event.stepNumber + 1, content: debugPrompt(reviewerInstructions, event.messages) });
      emit({ type: 'model', role: 'reviewer', round: activeRound, model: reviewerModel, step: event.stepNumber + 1, state: 'request' });
    },
    onStepFinish: event => reportStep('reviewer', activeRound, reviewerModel)(event),
  });
  for (let round = 1; round <= config.max_reviews; round++) {
    options.signal?.throwIfAborted();
    activeRole = 'editor'; activeRound = round;
    phaseSteps = 0; edits = 0; rejectedTools = 0; lastToolError = ''; correctionApplied = false;
    emit({ type: 'phase', role: 'editor', round });
    let submission: DraftSubmission | undefined;
    let preparedRevision: number | undefined;
    const pendingReview = reviews.at(-1);
    const editorTools = agentTools(host, sceneId, 'editor', options.signal, reportTool('editor'), value => { submission = value; }, () => {}, revision => {
      if (revision !== preparedRevision) return 'The drawing changed within this response. Inspect its updated JSON/JPEG in the next model request before calling finish_draft alone. Complete every requested element before submitting.';
      if (pendingReview && (revision === pendingReview.revision || !correctionApplied)) return `The reviewer rejected revision ${pendingReview.revision}. Apply visible corrections with scene_apply before calling finish_draft. Pending corrections: ${JSON.stringify(pendingReview.issues)}`;
    }, !!options.stage);
    let editorInstructions = editorBase;
    const editor = new ToolLoopAgent({
      id: 'scene-editor', model: provider.chatModel(editorModel), instructions: editorBase,
      tools: editorTools, toolChoice: 'required', maxRetries: 0, maxOutputTokens: config.max_output_tokens,
      timeout: { stepMs: config.timeout_ms }, stopWhen: () => submission !== undefined,
      prepareStep: async ({ stepNumber, messages, initialMessages }) => {
        editorInstructions = `${editorBase}\nThe ONLY scene_id in every tool call is "${sceneId}".\nRequest ${stepNumber + 1} in this editor phase. There is no step-count limit. Complete your assigned work, then call finish_draft.`;
        if (pendingReview) editorInstructions += `\nCorrect the review of revision ${pendingReview.revision} before resubmitting. Correction checklist: ${JSON.stringify(pendingReview.issues)}`;
        const recovery = loopDetectors.editor.prepareStep({ initialInstructions: editorInstructions, initialMessages });
        if (recovery) await emit({ type: 'loop_detected', role: 'editor', round, detection: recovery.detection });
        const contextMessages = recovery?.messages ?? messages;
        let current: Scene;
        try { current = host.store.get(sceneId); }
        catch (error) {
          if (!(error instanceof Error && error.message.startsWith('Scene not found:'))) throw error;
          return { instructions: editorInstructions, messages: contextMessages, activeTools: ['scene_create'], toolChoice: 'required' };
        }
        editorInstructions += `\nCurrent scene revision: ${current.revision}; palette indices and colors: ${JSON.stringify(current.palette.colors)}.`;
        const preview = config.vision ? requireResult<AgentDraft['preview']>(await host.scene_render({ scene_id: sceneId })) : { image_ref: '', revision: current.revision };
        const context = JSON.stringify({ ...JSON.parse(text), current_scene: current, image_attached: config.vision });
        const currentMessage = phaseMessages(context, { scene: current, preview }, config.vision)[0];
        // Replace the original user snapshot instead of accumulating stale JPGs.
        const userIndex = contextMessages.map(message => message.role).lastIndexOf('user');
        const updatedMessages = contextMessages.map((message, index) => index === userIndex ? currentMessage : message);
        preparedRevision = current.revision;
        if (!current.objects.length) return { instructions: editorInstructions, messages: updatedMessages, activeTools: ['scene_apply'], toolChoice: 'required' };
        return { instructions: editorInstructions, messages: updatedMessages };
      },
      onStepStart: event => {
        emit({ type: 'prompt', role: 'editor', round, step: event.stepNumber + 1, content: debugPrompt(editorInstructions, event.messages) });
        emit({ type: 'model', role: 'editor', round, model: editorModel, step: event.stepNumber + 1, state: 'request' });
      },
      onStepFinish: reportStep('editor', round, editorModel),
    });
    const text = JSON.stringify({ task: round === 1 ? 'Draw only what the prompt requests.' : 'Edit the drawing to address the independent review.', prompt: options.prompt, scene_id: sceneId, round, max_reviews: config.max_reviews, draft: draft ? { scene: draft.scene } : null, review: reviews.at(-1) ?? null, image_attached: !!draft && config.vision, ...(options.stage ? { workflow: options.stage.context } : {}) });
    try { await editor.generate({ messages: phaseMessages(text, draft, config.vision), abortSignal: options.signal }); }
    catch (error) { return incomplete(error); }
    options.signal?.throwIfAborted();
    if (!submission) return incomplete(new Error(phaseFailure('Editor', 'finish_draft')));
    const scene = host.store.get(sceneId);
    if (submission.revision !== scene.revision) return incomplete(new Error('Editor changed the scene after submitting it. The current canvas is delivered without review.'));
    if (options.stage) handoff = { done: submission.done!, not_done: submission.not_done! };
    const preview = requireResult<AgentDraft['preview']>(await host.scene_render({ scene_id: sceneId }));
    draft = { scene, preview };
    drafts.push(structuredClone(draft));
    emit({ type: 'draft', round, draft: structuredClone(draft) });

    if (options.stage && !options.stage.final) return deliver('completed');

    activeRole = 'reviewer';
    phaseSteps = 0; edits = 0; rejectedTools = 0; lastToolError = '';
    emit({ type: 'phase', role: 'reviewer', round });
    reviewState.value = undefined;
    reviewerMessages.push(...phaseMessages(JSON.stringify({ task: round === 1 ? 'Compare this drawing with the original prompt.' : 'Review the updated drawing and verify each correction you requested in your previous review.', prompt: options.prompt, scene_id: sceneId, round, previous_review: pendingReview ?? null, draft: { scene: draft.scene }, image_attached: config.vision, ...(handoff ? { final_handoff: handoff } : {}) }), draft, config.vision));
    try {
      const response = await reviewer.generate({ messages: reviewerMessages, abortSignal: options.signal });
      // Persist the actual prepared context so a recovery stays effective in
      // later rounds instead of restoring the discarded SDK retry history.
      reviewerMessages.splice(0, reviewerMessages.length, ...reviewerRequestMessages, ...response.finalStep.response.messages);
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
