const stageActions: Record<string, string> = {
  Artist: 'Creating the scene', Background: 'Creating the background', 'Distant background': 'Creating the distant background',
  Setting: 'Building the setting', 'Main content': 'Creating the main content', Foreground: 'Adding foreground elements',
  Decorator: 'Decorating the layers', Specialist: 'Adding specialized details', 'Final integrator': 'Integrating lighting, color and layers',
};
export function stageStatus(name: string, index: number, total: number): string {
  return `${stageActions[name] || name} (${index}/${total}).`;
}
export function phaseStatus(role: 'editor' | 'reviewer', round: number, total: number): string {
  return role === 'reviewer'
    ? `Validating the scene (${total}/${total}, review ${round}).`
    : `Applying review corrections (${total - 1}/${total}, review ${round}).`;
}
