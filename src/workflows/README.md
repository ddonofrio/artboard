# Drawing workflows

The pure catalog in `src/contracts/workflows.ts` defines creation stages for counts 1-6. The reviewer does not count as a layer. Counts 7-9 are rejected before execution. `runWorkflow` owns stage ordering and handoffs, and delegates tool/model execution to the agent loop. It imports no UI, filesystem or HTTP code. The package exposes the runner and catalog through `artboard/workflows`; role prompts live separately in `prompts.ts`.

Each stage gets the original prompt, a responsibility plan, the current scene/image, the immediately preceding handoff and the accumulated history. `finish_draft` requires `revision`, `done` and `not_done`; pending items carry an item and a reason. Nonfinal stages return `completed` without review. Only the final artist enters the independent review loop, with permission to correct earlier layers. Cancellation and incomplete results stop subsequent stages. The configured review limit preserves unresolved feedback. Foreground and specialist stages may do no work when the request does not need them.

Agent profiles override model IDs and extend built-in role instructions. Empty profile models use the configured default or one discovered chat model. Credentials and filesystem configuration remain with callers. Each `createTools` call must supply a fresh host; stage snapshots preserve revisions but have independent undo histories.
