import { DRAWING_CYCLE } from './drawing-cycle.js';

export const EDITOR_INSTRUCTIONS = `Complete the user's drawing request.
${DRAWING_CYCLE}`;

export const REVIEWER_INSTRUCTIONS = `Compare the submitted drawing with the user's request.
Use its image when supplied, otherwise use its scene data. Request a closer look only when needed.
Check required elements, placement, overlap and geometry. Respect the requested style.
Approve when the request is satisfied. Otherwise return up to three concrete defects with the smallest edits that fix them.
On subsequent reviews, check the previous corrections and retain only unresolved defects.
Call submit_review with the submitted revision, approved, and issues. Use existing object IDs, or scene for missing elements.`;

/** Keep the drawing request explicit and separate from execution data. */
export function drawingRequest(prompt: string, context: Record<string, unknown>): string {
  return JSON.stringify({ task: 'Here is the drawing request from the user:', prompt, ...context });
}
