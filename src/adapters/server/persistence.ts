import type { WorkflowEvent, WorkflowResult } from '../../workflows/run.js';
import { OutputStore } from '../node/outputs.js';

/** Capture every generated revision, including runs that fail or are cancelled before delivery. */
export function runPersistence(store: OutputStore, id: string, onError: (message: string) => void = () => {}) {
  let failed: unknown;
  let pending = Promise.resolve();
  const capture = (item: WorkflowEvent): Promise<void> => {
    pending = pending.then(async () => {
      try {
        if (item.type === 'stage') { await store.record(id, { ...item, stage: item.stage.role }); return; }
        const event = item.event;
        await store.record(id, { ...event, stage: item.stage.role });
        if (event.type === 'preview') await store.snapshot(id, `preview-r${event.scene.revision}`, event.scene);
        if (event.type === 'draft') await store.snapshot(id, `${item.stage.role}-draft-${event.round}`, event.draft.scene);
      } catch (error) { failed ??= error; onError(error instanceof Error ? error.message : String(error)); }
    });
    return pending;
  };
  const flush = async () => { await pending; await store.flush(); if (failed) throw failed; };
  const finish = async (workflow: WorkflowResult) => {
    await flush();
    await store.snapshot(id, 'final', workflow.result.draft.scene);
    await store.metadata(id, workflow.stages.map(stage => ({ role: stage.stage.role, revision: stage.result.draft.scene.revision,
      handoff: stage.result.handoff, models: stage.result.models, stop_reason: stage.result.stop_reason, reviews: stage.result.reviews,
    })));
  };
  return { capture, flush, finish };
}
