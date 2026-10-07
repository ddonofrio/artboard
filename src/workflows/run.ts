import { agentConfig, listModels, type AgentConfig } from '../agents/config.js';
import { runAgentLoop, type AgentEvent, type AgentRunResult } from '../agents/loop.js';
import { stageInstructions } from './prompts.js';
import { EDITOR_INSTRUCTIONS } from '../agents/prompts.js';
import type { Handoff } from '../agents/tools.js';
import type { Scene, SceneTools } from '../core/index.js';
import { getWorkflow, type AgentRole, type WorkflowStage } from '../contracts/workflows.js';

export interface AgentProfile { model?: string; instructions?: string }
export interface WorkflowConfig { connection?: Partial<AgentConfig>; agents?: Partial<Record<AgentRole, AgentProfile>> }
export interface StageResult { stage: WorkflowStage; result: AgentRunResult }
export interface WorkflowResult { result: AgentRunResult; stages: StageResult[] }
export type WorkflowEvent = { type: 'stage'; stage: WorkflowStage; index: number; total: number } | { type: 'agent'; stage: WorkflowStage; event: AgentEvent };
export interface WorkflowOptions {
  prompt: string; layers: number; config?: WorkflowConfig; initial_scene?: Scene; scene_id?: string;
  createTools: () => SceneTools; fetch?: typeof fetch; signal?: AbortSignal;
  onEvent?: (event: WorkflowEvent) => void | Promise<void>;
}

export async function runWorkflow(options: WorkflowOptions): Promise<WorkflowResult> {
  const workflow = getWorkflow(options.layers);
  if (typeof options.prompt !== 'string' || !options.prompt.trim() || options.prompt.length > 4000) throw new Error('Write a prompt of 1 to 4000 characters.');
  options.signal?.throwIfAborted();
  const config = agentConfig(options.config?.connection);
  const profiles = options.config?.agents ?? {};
  const defaultModel = config.editor_model || profiles[workflow.stages[0].role]?.model || (await listModels(config, options.fetch, options.signal))[0];
  const reviewer = profiles.reviewer?.model || config.reviewer_model || defaultModel;
  const history: { stage: string; done: Handoff['done']; not_done: Handoff['not_done'] }[] = [];
  const results: StageResult[] = [];
  let scene = options.initial_scene;
  for (const [index, stage] of workflow.stages.entries()) {
    options.signal?.throwIfAborted();
    const final = index === workflow.stages.length - 1;
    const singleArtist = workflow.stages.length === 1;
    await options.onEvent?.({ type: 'stage', stage, index: index + 1, total: workflow.stages.length + Number(workflow.review) });
    const result = await runAgentLoop({
      prompt: options.prompt, scene_id: options.scene_id, initial_scene: scene, tools: options.createTools(),
      config: { ...config, editor_model: profiles[stage.role]?.model || defaultModel, reviewer_model: reviewer },
      reviewer_instructions: profiles.reviewer?.instructions, fetch: options.fetch, signal: options.signal,
      review: workflow.review,
      stage: { final, handoff: !singleArtist, instructions: singleArtist ? `${EDITOR_INSTRUCTIONS}${profiles[stage.role]?.instructions ? `\n${profiles[stage.role]!.instructions}` : ''}` : stageInstructions(stage, final, profiles[stage.role]?.instructions, workflow.review), context: singleArtist ? { final: true } : {
        stage_index: index + 1, role: stage.role, responsibility: stage.responsibility, final, review_enabled: workflow.review,
        plan: workflow.stages, history: structuredClone(history), previous: history.at(-1) ?? null,
      } },
      onEvent: event => options.onEvent?.({ type: 'agent', stage, event }),
    });
    results.push({ stage, result });
    if (result.handoff) history.push({ stage: stage.role, ...structuredClone(result.handoff) });
    scene = result.draft.scene;
    if (result.stop_reason !== 'completed') return { result, stages: results };
  }
  throw new Error('Workflow ended without a final review.');
}
