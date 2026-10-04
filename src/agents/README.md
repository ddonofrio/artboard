# Drawing agents

This layer owns the drawing editor/reviewer workflow using AI SDK and the OpenAI-compatible provider. It imports the drawing core and exposes configuration, scoped tools, progress events, and orchestration through `artboard/agents`. It has no UI, filesystem, or Vite dependency.

Each run requires an isolated draft host. The editor starts with an empty canvas or the supplied base scene and draws through validated tool calls, in batches of at most eight operations. Agents do not use prebuilt recipes or file export tools. `finish_draft` submits only a drawing revision. The reviewer has read-only tools and returns `submit_review` with approval or actionable corrections for that exact revision.

The editor receives the current scene JSON and, with vision enabled, its JPEG after each tool. Mutation feedback reports changed pixels and advisory coverage diagnostics. The reviewer retains its conversation across correction passes. Rejected drafts require a new revision and a visible mutation before resubmission. Approval stops immediately; review-limit exhaustion delivers the latest drawing with unresolved feedback. A failed or unfinished model response after canvas creation delivers an incomplete drawing and its error. Cancellation prevents final delivery.

The configuration bounds review rounds, output tokens, and individual request timeouts. Tool steps do not have a fixed count limit. Model output remains validated data. The [loop detector](plugins/README.md) recovers request context after repeated identical tool failures without changing scene validation or consuming a review round.

The endpoint defaults to localhost; empty editor IDs discover a non-embedding model and empty reviewer IDs use the editor model. Only OpenAI-compatible `/models` and `/chat/completions` are used. Vision requires an adapter returning inline JPEG or PNG data URLs. There is no cloud fallback or silent downgrade to text-only review.

Progress callbacks expose request context without image bytes, response metadata, tools, previews, drafts, reviews, errors, and final results. The callback for a preview is awaited before the next tool executes. Callers own presentation and persistence. The [Node command](../../DEVELOPMENT.md) supplies the filesystem/image adapter; the browser placeholder does not execute agents.
