# Development contract

Read this file, the root README, and the README for the affected layer before editing. Read DEVELOPMENT.md for setup and validation.

## Responsibilities

- `src/core` owns drawing data, validation, tools, catalogs, rendering, and scene history. It imports only its own modules and Ajv.
- `src/agents` owns drawing editor/reviewer orchestration and model transport. It depends on core and AI SDK, never UI, Node adapters, or Vite.
- `src/adapters/node` owns filesystem persistence and image encoding. It depends on core, never UI or agent orchestration.
- `src/ui` owns the browser interface. It currently contains only the work-in-progress page. It does not import agents or Node adapters. Introduce an explicit service contract before connecting it to agent execution.
- `scripts` owns executable Node entry points and reproducible artifact generation.
- MCP is the intended external integration surface. Its transport belongs in a separate adapter when implemented; core and agents do not depend on it.

Artboard owns drawing. Story generation, narration, player choices, and game sessions belong to Adventure. Keep model output as validated data and never execute generated code.

## Delivery

Write source, comments, prompts, errors, examples, and documentation in English. Update directly affected documentation with implementation. Preserve the drawing contracts when reorganizing the agent workflow.

Run typecheck, non-mutating lint, and relevant tests. Build for browser or package integration changes. Verify behavior without a visual review. Do not stage, commit, push, or deploy without an explicit request.

Package manifests and the lockfile own dependency versions and commands. TypeScript and schemas own API shape. Tests own executable invariants. Keep documentation about current responsibilities and behavior; do not add change histories or speculative designs.
