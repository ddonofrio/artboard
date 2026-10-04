# Development

Use Node.js 22.12 or newer and npm. Dependencies use exact versions and the lockfile pins their transitive dependencies. On Windows PowerShell, use `npm.cmd` when execution policy blocks `npm.ps1`.

## Start

```sh
npm ci
npm run dev
```

Vite serves the three-column DOS-style interface at the local URL printed in the terminal. It does not start inference or an agent service. The UI uses vanilla TypeScript and CSS without a framework. Agent dependencies are installed for the separate drawing workflow, not imported into the browser.

## Validation and outputs

```sh
npm run typecheck
npm run lint
npm test
npm run test:ui
npm run build
```

Typecheck validates the runtime, scripts, and tests, then the UI with browser types. Lint enforces allowed imports for each layer. Tests exercise deterministic rendering, transactional edits, history, schema validation, SDK tool calls, review handoffs, cancellation, timeouts, partial results, and loop recovery without a live model server.

`npm run test:ui` runs headless Playwright checks against an isolated Vite server. It checks the approved column structure, local controls without requests, numerical Stats, layer-count range, content-sized prompt and monitor, nested frame positioning, title gaps, font loading, and canvas sizing on resize. It does not capture screenshots or perform visual reviews. Chrome is the default browser; set `UI_BROWSER=chromium` after `npx playwright install chromium` to use Playwright's bundled browser. Test output is ignored in `outputs/ui-tests`. The UI remains unconnected to drawing execution and agents.

Build creates the static browser application in `dist` and independent ESM library entries with TypeScript declarations in `dist-lib`. The package exports core at `artboard`, orchestration at `artboard/agents`, and the filesystem/image adapter at `artboard/node`. Library output excludes public UI assets. `npm run preview` serves the built browser application.

`npm run schemas` regenerates JSON contracts in `schemas`. `npm run examples` generates offline recipe JSON/PNG pairs, catalog contact sheets, schemas, and local renderer performance measurements. `npm run workflow` exercises editing, rendering, undo, redo, and export. Generated examples and outputs are ignored by Git.

`npm run cli -- outputs` reads JSON-lines drawing-tool requests from stdin and writes JSON-lines results to stdout. Its scene store lives for the duration of the process. File operations are scoped to the given output directory. This CLI is a local tool dispatcher, not an MCP server.

## Drawing agents

Copy `.env.example` to `.env.local` to configure the Node agent command, or set environment variables. Existing process variables take precedence. The command loads `.env.local` when present, otherwise `.env`.

```sh
npm run agent -- "Draw a clearing at dawn with a castle on the horizon."
```

The endpoint defaults to `http://127.0.0.1:1234`. Empty editor model IDs trigger discovery through `/v1/models`; an empty reviewer ID uses the editor model. Configure `AGENT_BASE_URL`, `AGENT_EDITOR_MODEL`, `AGENT_REVIEWER_MODEL`, optional `AGENT_API_KEY`, `AGENT_VISION`, and `AGENT_MAX_REVIEWS`. `AGENT_SCENE` optionally supplies a scene JSON file for editing. Credentials stay on the Node side. The library accepts explicit configuration and does not load environment files itself.

The model server must support OpenAI-compatible Chat Completions, tool calls, and JPEG inputs when vision is enabled. The workflow saves draft/final JSON and PNG files plus review results in `outputs/agent`. Approval, review-limit exhaustion, and incomplete runs remain distinct outcomes. Cancellation or failure before canvas creation exits with an error.

MCP transport and the browser command interface are not implemented yet. They integrate through the drawing toolkit without moving model orchestration into UI code.
