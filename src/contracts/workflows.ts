export type ArtistRole = 'artist' | 'background' | 'distant_background' | 'setting' | 'main_content' | 'foreground' | 'decorator' | 'specialist' | 'integrator';
export type AgentRole = ArtistRole | 'reviewer';
export interface WorkflowStage { role: ArtistRole; name: string; responsibility: string }
export interface WorkflowDefinition { layers: number; stages: readonly WorkflowStage[] }
const stages: Record<ArtistRole, WorkflowStage> = {
  artist: { role: 'artist', name: 'Artist', responsibility: 'Draw the entire requested scene.' },
  background: { role: 'background', name: 'Background', responsibility: 'Draw only the requested background and environment. Leave protagonists and their objects to main content.' },
  distant_background: { role: 'distant_background', name: 'Distant background', responsibility: 'Draw the sky, horizon, distant scenery and atmospheric depth. Leave the immediate setting and subjects pending.' },
  setting: { role: 'setting', name: 'Setting', responsibility: 'Build the immediate space: terrain, rooms, streets, nearby buildings and furniture. Preserve the distant background and leave protagonists pending.' },
  main_content: { role: 'main_content', name: 'Main content', responsibility: 'Complete the requested protagonists and principal objects using the existing environment and pending requirements.' },
  foreground: { role: 'foreground', name: 'Foreground', responsibility: 'Add requested or necessary foreground elements for depth. Protect faces and important objects. Do not invent foreground elements if none are needed; a no-op handoff is allowed.' },
  decorator: { role: 'decorator', name: 'Decorator', responsibility: 'Inspect every preceding layer and add requested details, textures and finishing touches. Preserve the composition and protagonist. Complete any remaining required elements.' },
  specialist: { role: 'specialist', name: 'Specialist', responsibility: 'Choose a specialty from the original request: secondary characters, product materials, architectural details or fantasy effects. State the specialty in done. Add only details justified by the request. Use supported drawing tools only; report unsupported requirements instead of inventing tools. A no-op handoff is allowed when no specialty is needed.' },
  integrator: { role: 'integrator', name: 'Final integrator', responsibility: 'Integrate all layers: lighting, color, shadows and finishing. Preserve their useful work and complete the original request.' },
};
const layouts: readonly ArtistRole[][] = [
  ['artist'], ['background', 'main_content'], ['background', 'main_content', 'decorator'],
  ['distant_background', 'setting', 'main_content', 'decorator'],
  ['distant_background', 'setting', 'main_content', 'foreground', 'decorator'],
  ['distant_background', 'setting', 'main_content', 'foreground', 'specialist', 'integrator'],
];
export const WORKFLOWS: readonly WorkflowDefinition[] = layouts.map((roles, index) => ({ layers: index + 1, stages: roles.map(role => stages[role]) }));
export const AGENT_ROLES: readonly AgentRole[] = [...Object.keys(stages) as ArtistRole[], 'reviewer'];
export function getWorkflow(layers: number): WorkflowDefinition {
  if (!Number.isInteger(layers) || layers < 1 || layers > WORKFLOWS.length) throw new Error('Choose a defined workflow with 1 to 6 layers. Workflows 7 to 9 are not defined yet.');
  return WORKFLOWS[layers - 1];
}
export function describeLayerAlgorithm(layers: number): string {
  const workflow = WORKFLOWS.find(item => item.layers === layers);
  if (!workflow) return 'Algorithm: Not defined yet.';
  return `Algorithm: ${[...workflow.stages.map(stage => stage.name), 'Reviewer'].join(' → ')}. Each stage passes on completed and pending work. The ${workflow.stages.at(-1)!.name.toLowerCase()} handles review changes until approved or the review limit is reached.`;
}
