import type { WorkflowStage } from '../contracts/workflows.js';
import { DRAWING_CYCLE } from '../agents/drawing-cycle.js';

export function stageInstructions(stage: WorkflowStage, final: boolean, extra = '', review = true): string {
  const scope = final
    ? (review ? "Complete any pending requirements and handle the reviewer's corrections, including changes to earlier stages." : 'Complete the requested drawing for delivery.')
    : 'Complete your assigned part while preserving the existing drawing.';
  return `Assigned work: ${stage.responsibility}\n${scope}\n${DRAWING_CYCLE}
Include done (completed work) and not_done ({item, reason} for remaining requested work) in finish_draft.${extra ? `\n${extra}` : ''}`;
}
