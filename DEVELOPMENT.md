# Development

Use Node.js 22.12 or newer and npm. Dependencies use exact versions and the lockfile pins their transitive dependencies. On Windows PowerShell, use `npm.cmd` when execution policy blocks `npm.ps1`.

## Start

```sh
npm ci
npm run dev
```

Vite serves the three-column DOS-style interface and local drawing service at the URL printed in the terminal. Startup creates `agents.local.json` from the documented `agents.example.json` template only when missing. Open the local file to configure model IDs, private role instructions and optional connection settings. The UI uses vanilla TypeScript and CSS without a framework; model dependencies and credentials stay on the Node side. Opening the UI does not start inference; Send executes the selected workflow.

## Validation and outputs

```sh
npm run typecheck
npm run lint
npm test
npm run test:ui
npm run build
```

Typecheck validates the runtime, scripts, and tests, then the UI with browser types. Lint enforces allowed imports for each layer. Tests exercise deterministic rendering, transactional edits, history, schema validation, SDK tool calls, review handoffs, cancellation, timeouts, partial results, and loop recovery without a live model server.

Unit/integration tests also exercise all six workflows, cumulative handoffs, final-agent corrections, optional no-op stages, pending-requirement approval guards, configuration creation/precedence, the HTTP service, timed activity queues, scanline speed, per-response animation queues/concurrency, center-out radial fills, overlap ordering and output naming/persistence.

`npm run test:ui` runs headless Playwright against an isolated Vite server and a deterministic OpenAI-compatible model fixture. It exercises browser-to-service-to-model execution for all six workflows, batch input, editing, cancellation, limits, partial failures, private-file access and the three independent logs. Browser clock checks verify two-line clipping and the one-second FIFO display rule. The existing layout, font, range, frame and resize checks remain. These tests require no live model and do not capture screenshots or perform visual reviews. Chrome is the default browser; set `UI_BROWSER=chromium` after `npx playwright install chromium` to use Playwright's bundled browser. Test output and isolated configuration are ignored under `outputs`.

`npm run test:live` runs browser E2E against the running application and its actual configured model server, without mocking requests. Start `npm run dev` and configure `agents.local.json` first. It checks one- and two-layer drawing completion, visible canvas output, absence of request failures, and the three unlabeled log values with equal colors. `ARTBOARD_LIVE_URL` overrides the default application URL `http://127.0.0.1:5173`. Live tests are opt-in and have a five-minute per-test timeout.

Build creates the static browser application in `dist` and independent ESM library entries with TypeScript declarations in `dist-lib`. The package exports core at `artboard`, editor/reviewer execution at `artboard/agents`, workflow orchestration at `artboard/workflows`, and the filesystem/image adapter at `artboard/node`. Library output excludes public UI assets. `npm run preview` serves the built browser application and local drawing service. Serving `dist` with an unrelated static server alone does not provide agent execution.

`npm run schemas` regenerates JSON contracts in `schemas`. `npm run examples` generates offline recipe JSON/PNG pairs, catalog contact sheets, schemas, and local renderer performance measurements. `npm run workflow` exercises editing, rendering, undo, redo, and export. Generated examples and outputs are ignored by Git.

`npm run cli -- outputs` reads JSON-lines drawing-tool requests from stdin and writes JSON-lines results to stdout. Its scene store lives for the duration of the process. File operations are scoped to the given output directory. This CLI is a local tool dispatcher, not an MCP server.

`npm run draw-script -- <file.mjs> [output-directory] [arguments...]` explicitly executes a trusted local module with the drawing tools. It accepts the same named colors and geometry aliases as the agent. The host serializes calls, drains queued work, and stops after a tool failure while preserving previous successful batches. Output files remain adapter-scoped; the module itself runs with Node.js permissions. This command is separate from autonomous model execution. See [script authoring](scripts/README.md) for its contract and the reproducible fighter reference study.

## Drawing agents

The fixed basic palette is shared by all workflows. Model context and drawing tools expose English color names; numeric indices and RGB values stay with rendering and persisted scene data. Agents cannot select or replace palettes. Tests exercise named colors through actual SDK requests, catalog discovery, inspection, edits and review, and verify that model requests contain no hexadecimal color codes.

The browser service and Node command share `agents.local.json`. The template contains empty connection settings and empty model/instruction fields for every role. Unset values use localhost, model discovery and built-in role prompts. Existing local configuration is never overwritten, is excluded from Git and is denied through Vite file serving. Changes apply on the next request. `ARTBOARD_CONFIG_FILE` selects an alternate file.

The browser's Model combo below the prompt lists the configured server's advertised IDs through `GET /api/models`. Model choices are saved in browser `localStorage` and restored on reload when still available; otherwise the server's preferred model is used. Refresh reloads the list. Each Send applies the chosen model to all creation/review agents for that execution (and every line of that batch), retaining private instructions without modifying configuration. The next Send captures the current selection again. Discovery failures appear in the activity log and can be retried. Model discovery does not start inference.

Reasoning level below Model saves its choice locally and sends none (Off), low, medium or high per turn; Default preserves server configuration. Compatible servers must support the requested level (for example, [llama.cpp documents none as disabling thinking](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)). Image size defaults to 1 / 4, reducing both model JPG dimensions by four while preserving full canvas/output resolution. Workflows now run from 1 to 7: 1 has no reviewer; 2-7 include the reviewer in their total steps. Model transport requests SSE with token usage. Prompt processing remains distinct from actual thinking; incremental thinking and tool arguments reach the UI before response completion. Thinking shows its count in the agent-state line and scrolls its activity text to the newest two lines.

Creation agents receive scene JSON without automatic image attachments. With `AGENT_VISION` enabled, the reviewer automatically receives the submitted draft image at the start of every review, including after corrections. Both roles can request further looks through `scene_render`. Automatic and requested images are supplied for one inference and then removed from message history. UI previews and saved images remain independent of model vision. The third live-log value reports agent state; errors join the first value's one-second activity queue.

Environment variables override connection fields. Existing `.env.local` or `.env` settings remain supported; process variables take precedence. Do not put credentials in `VITE_*` variables.

```sh
npm run agent -- "Draw a clearing at dawn with a castle on the horizon."
npm run agent -- --layers 3 "Draw a clearing at dawn with a castle on the horizon."
```

The endpoint defaults to `http://127.0.0.1:1234`. Empty default model IDs trigger discovery through `/v1/models`; an empty reviewer ID uses the default editor model. Each role can override its model in `agents.local.json`. Configure connection overrides with `AGENT_BASE_URL`, `AGENT_EDITOR_MODEL`, `AGENT_REVIEWER_MODEL`, optional `AGENT_API_KEY`, `AGENT_VISION`, `AGENT_MAX_REVIEWS`, `AGENT_MAX_OUTPUT_TOKENS` and `AGENT_TIMEOUT_MS`. The CLI accepts `--layers 1..6` or `AGENT_LAYERS`; `AGENT_SCENE` optionally supplies a scene JSON file for editing, and `AGENT_OUTPUT_DIR` changes the CLI outputs root. Credentials stay on the Node side. The workflow library accepts explicit configuration and never reads environment files itself.

The model server must support OpenAI-compatible Chat Completions, tool calls, and JPEG inputs when vision is enabled. Browser and CLI execution share Aventure's output conventions under `outputs`: single deliveries use `outputs/YYYYMMDD/<prompt>.jpg` with dates in Europe/Madrid and exclusive collision suffixes; batch deliveries use `outputs/batch/<batch-UUID>/001.jpg`, `002.jpg`, and so on. Every generated revision and stage draft is captured as JSON/JPEG in `outputs/workflow/<run-UUID>`, alongside final JSON/JPEG and stage handoffs/reviews in `workflow.json`. The append-only journal `outputs/logs/agent.jsonl` captures prompts, responses, thinking, tool calls, reviews, failures and cancellation, omitting image bytes and credentials. Journals are denied through Vite file serving. Artifacts are saved independently of canvas animation and partial revisions remain after cancellation or failure. Approval, review-limit exhaustion, and incomplete runs remain distinct outcomes. Failure before canvas creation exits with an error. Browser edit references are retained for up to 50 delivered scenes and expire when the service restarts.

MCP transport is not implemented yet. The browser connects through `POST /api/runs`, with requests and streamed events defined in `src/contracts/service.ts`; workflows and model orchestration remain outside UI code.
