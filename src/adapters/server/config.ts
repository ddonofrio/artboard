import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { agentConfig, type AgentConfig } from '../../agents/config.js';
import { AGENT_ROLES, type AgentRole } from '../../contracts/workflows.js';
import type { AgentProfile, WorkflowConfig } from '../../workflows/run.js';

export async function ensureAgentConfig(root: string, filename = 'agents.local.json'): Promise<string> {
  const path = resolve(root, filename);
  const template = await readFile(resolve(root, 'agents.example.json'), 'utf8');
  await mkdir(dirname(path), { recursive: true });
  try { await writeFile(path, template, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
  return path;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseWorkflowConfig(value: unknown): WorkflowConfig {
  if (!object(value) || !object(value.connection) || !object(value.agents)) throw new Error('Agent configuration requires connection and agents objects.');
  const keys = ['base_url', 'api_key', 'editor_model', 'reviewer_model', 'vision', 'max_reviews', 'max_output_tokens', 'timeout_ms'];
  for (const key of Object.keys(value.connection)) if (!keys.includes(key)) throw new Error(`Unknown connection setting: ${key}.`);
  const connection = agentConfig(value.connection as Partial<AgentConfig>);
  const agents: Partial<Record<AgentRole, AgentProfile>> = {};
  for (const [role, profile] of Object.entries(value.agents)) {
    if (!AGENT_ROLES.includes(role as AgentRole)) throw new Error(`Unknown agent role: ${role}.`);
    if (!object(profile) || Object.keys(profile).some(key => !['model', 'instructions'].includes(key))) throw new Error(`Invalid profile for ${role}. Use model and instructions.`);
    if (profile.model !== undefined && (typeof profile.model !== 'string' || profile.model.length > 256)) throw new Error(`Invalid model for ${role}.`);
    if (profile.instructions !== undefined && (typeof profile.instructions !== 'string' || profile.instructions.length > 16000)) throw new Error(`Invalid instructions for ${role}.`);
    agents[role as AgentRole] = { model: (profile.model as string | undefined)?.trim(), instructions: profile.instructions as string | undefined };
  }
  return { connection, agents };
}
export async function loadWorkflowConfig(root: string, environment: NodeJS.ProcessEnv = process.env): Promise<WorkflowConfig> {
  const path = await ensureAgentConfig(root, environment.ARTBOARD_CONFIG_FILE || 'agents.local.json');
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Cannot parse the local agent configuration. Use agents.example.json as a template.'); }
  const config = parseWorkflowConfig(value);
  const connection = { ...config.connection };
  for (const [env, key] of [['AGENT_BASE_URL', 'base_url'], ['AGENT_EDITOR_MODEL', 'editor_model'], ['AGENT_REVIEWER_MODEL', 'reviewer_model'], ['AGENT_API_KEY', 'api_key']] as const) {
    if (environment[env] !== undefined) connection[key] = environment[env];
  }
  for (const [env, key] of [['AGENT_MAX_REVIEWS', 'max_reviews'], ['AGENT_MAX_OUTPUT_TOKENS', 'max_output_tokens'], ['AGENT_TIMEOUT_MS', 'timeout_ms']] as const) {
    if (environment[env] !== undefined) connection[key] = Number(environment[env]);
  }
  if (environment.AGENT_VISION !== undefined) {
    if (!['true', 'false'].includes(environment.AGENT_VISION)) throw new Error('AGENT_VISION must be true or false.');
    connection.vision = environment.AGENT_VISION === 'true';
  }
  return { ...config, connection: agentConfig(connection) };
}
