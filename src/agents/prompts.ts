import { DRAWING_CYCLE } from './drawing-cycle.js';
import { namedColors } from './colors.js';

export const EDITOR_INSTRUCTIONS = `Complete the user's drawing request.
${DRAWING_CYCLE}`;

export const REVIEWER_INSTRUCTIONS = `Compare the submitted drawing with the user's request.
Use its image when supplied, otherwise use its scene data. Request a closer look only when needed.
Check required elements, placement, overlap and geometry. Respect the requested style.
Approve when the request is satisfied. Otherwise return up to three concrete defects with the smallest edits that fix them.
On subsequent reviews, check the previous corrections and retain only unresolved defects.
Call submit_review with the submitted revision, approved, and issues. Use existing object IDs, or scene for missing elements.`;

/** Pair each vision input with the original request and an explicit completion check. */
export function imageAssessmentPrompt(prompt: string, role: 'editor' | 'reviewer'): string {
  const image = role === 'editor' ? 'what you have drawn' : 'the submitted drawing';
  const nextAction = role === 'editor'
    ? 'If the list is empty, you may finish by calling finish_draft. Otherwise, fix every listed item, call scene_render again, and repeat this check before finishing.'
    : 'If the list is empty, approve by calling submit_review with no issues. Otherwise, call submit_review with approval false and actionable issues for the missing or incorrect items.';
  return `The attached image is ${image}. This is what the user asked to be drawn: ${JSON.stringify(prompt)}. Determine which requested elements are correct and which are missing or incorrect. Make a concrete list of every missing or incorrect item before choosing your next action. ${nextAction}`;
}

/** Keep the drawing request explicit and separate from execution data. */
export function drawingRequest(prompt: string, context: Record<string, unknown>): string {
  return JSON.stringify(namedColors({ task: 'Here is the drawing request from the user:', prompt, ...context }));
}
