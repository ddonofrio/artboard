export type ArtistRole = 'artist' | 'background' | 'distant_background' | 'setting' | 'main_content' | 'foreground' | 'decorator' | 'specialist' | 'integrator';
export type AgentRole = ArtistRole | 'reviewer';
export interface WorkflowStage { role: ArtistRole; name: string; responsibility: string }
export interface WorkflowDefinition { layers: number; review: boolean; stages: readonly WorkflowStage[] }
const stages: Record<ArtistRole, WorkflowStage> = {
  artist: { role: 'artist', name: 'Artist', responsibility: 'Draw the entire requested scene.' },
  background: { role: 'background', name: 'Background', responsibility: 'Draw the requested background and environment. Leave subjects and their objects to main content.' },
  distant_background: { role: 'distant_background', name: 'Distant background', responsibility: 'Draw the requested sky, horizon and distant scenery.' },
  setting: { role: 'setting', name: 'Setting', responsibility: 'Draw the requested immediate setting around the subjects.' },
  main_content: { role: 'main_content', name: 'Main content', responsibility: 'Complete the requested protagonists and principal objects using the existing environment and pending requirements.' },
  foreground: { role: 'foreground', name: 'Foreground', responsibility: 'Add requested foreground elements while keeping the subjects visible. Hand off unchanged if none are needed.' },
  decorator: { role: 'decorator', name: 'Decorator', responsibility: 'Add requested details across the preceding layers while preserving the composition.' },
  specialist: { role: 'specialist', name: 'Specialist', responsibility: 'Complete a detail that needs special attention in the user request and name it in done. Hand off unchanged if none is needed.' },
  integrator: { role: 'integrator', name: 'Final integrator', responsibility: 'Integrate all layers: lighting, color, shadows and finishing. Preserve their useful work and complete the original request.' },
};
const layouts: readonly ArtistRole[][] = [
  ['artist'], ['artist'], ['background', 'main_content'], ['background', 'main_content', 'decorator'],
  ['distant_background', 'setting', 'main_content', 'decorator'],
  ['distant_background', 'setting', 'main_content', 'foreground', 'decorator'],
  ['distant_background', 'setting', 'main_content', 'foreground', 'specialist', 'integrator'],
];
export const WORKFLOWS: readonly WorkflowDefinition[] = layouts.map((roles, index) => ({ layers: index + 1, review: index > 0, stages: roles.map(role => stages[role]) }));
export const AGENT_ROLES: readonly AgentRole[] = [...Object.keys(stages) as ArtistRole[], 'reviewer'];
export function getWorkflow(layers: number): WorkflowDefinition {
  if (!Number.isInteger(layers) || layers < 1 || layers > WORKFLOWS.length) throw new Error('Choose a defined workflow from 1 to 7.');
  return WORKFLOWS[layers - 1];
}
export function describeLayerAlgorithm(layers: number): string {
  const workflow = WORKFLOWS.find(item => item.layers === layers);
  if (!workflow) return 'Algorithm: Not defined yet.';
  if (!workflow.review) return 'Algorithm: Artist. Draw and inspect the complete scene, then deliver without a reviewer.';
  return `Algorithm: ${[...workflow.stages.map(stage => stage.name), 'Reviewer'].join(' → ')}. Each stage passes on completed and pending work. The ${workflow.stages.at(-1)!.name.toLowerCase()} handles review changes until approved or the review limit is reached.`;
}
