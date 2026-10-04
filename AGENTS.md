# Development contract

Read this file, the root README, and the README for the affected layer before editing. Read DEVELOPMENT.md for setup and validation.

## Responsibilities

- `src/core` owns drawing data, validation, tools, catalogs, rendering, and scene history. It imports only its own modules and Ajv.
- `src/agents` owns drawing editor/reviewer orchestration and model transport. It depends on core and AI SDK, never UI, Node adapters, or Vite.
- `src/adapters/node` owns filesystem persistence and image encoding. It depends on core, never UI or agent orchestration.
- `src/contracts` owns the pure workflow catalog and browser/service wire types. It imports no runtime layers.
- `src/workflows` owns stage ordering, role prompts and handoff history. It depends on agents, core and contracts, never UI or filesystem adapters.
- `src/adapters/server` owns local configuration and HTTP execution. It depends on workflows, agents, core and the Node adapter, never UI or Vite.
- `src/ui` owns the DOS-style prompt, canvas, and monitor interface. It imports UI modules and the explicit contracts only; it reaches execution through the local HTTP service and never imports agents or Node adapters.
- `scripts` owns executable Node entry points and reproducible artifact generation.
- MCP is the intended external integration surface. Its transport belongs in a separate adapter when implemented; core and agents do not depend on it.

Artboard owns drawing. Story generation, narration, player choices, and game sessions belong to Adventure. Keep model output as validated data and never execute generated code.

## Delivery

Write source, comments, prompts, errors, examples, and documentation in English. Update directly affected documentation with implementation. Preserve the drawing contracts when reorganizing the agent workflow.

Tool failures must be actionable: identify the tool, the failed operation/field when known, and the expected argument format or recovery action. Generic errors such as "invalid arguments" or union-schema failures are insufficient on their own. Select validation errors from the object's actual kind, and include concise tool usage guidance. Preserve the original diagnostic cause for transport, adapter and persistence failures; never present them as argument mistakes.

Run typecheck, non-mutating lint, and relevant tests. Build for browser or package integration changes. Verify behavior without a visual review. Do not stage, commit, push, or deploy without an explicit request.

Package manifests and the lockfile own dependency versions and commands. TypeScript and schemas own API shape. Tests own executable invariants. Keep documentation about current responsibilities and behavior; do not add change histories or speculative designs.
