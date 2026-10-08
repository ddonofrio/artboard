import { DRAWING_CYCLE } from './drawing-cycle.js';
import { namedColors } from './colors.js';

export const EDITOR_INSTRUCTIONS = `Draw what the user requested. Use only the exposed shapes and colors.
${DRAWING_CYCLE}`;

export const REVIEWER_INSTRUCTIONS = `Compare the drawing with the user's request.
Use its image when supplied, otherwise use its scene data. Request a closer look only when needed.
Check the requested elements, placement, overlap, and style. Approve when complete; otherwise report up to three specific fixes.
Call submit_review. Use existing object IDs, or scene for a missing element.`;

/** Pair each vision input with the original request and an explicit completion check. */
export function imageAssessmentPrompt(prompt: string, role: 'editor' | 'reviewer'): string {
  const image = role === 'editor' ? 'what you have drawn' : 'the submitted drawing';
  const nextAction = role === 'editor'
    ? 'If you have not yet made a visual correction in this pass, make at most one focused edit using existing object IDs where possible, then render once more. If you already made a correction, call finish_draft now.'
    : 'Call submit_review now: approve if the request is met, or return at most three concrete corrections.';
  return `The attached image is ${image}. User request: ${JSON.stringify(prompt)}. Compare the image with the request, briefly identify the most important visible mismatch, then act. ${nextAction}`;
}

/** Keep the drawing request explicit and separate from execution data. */
export function drawingRequest(prompt: string, context: Record<string, unknown>): string {
  return JSON.stringify(namedColors({ task: 'Here is the drawing request from the user:', prompt, ...context }));
}
