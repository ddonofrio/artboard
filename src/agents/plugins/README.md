# Agent plugins

This directory owns reusable hooks for model-agent execution. Plugins observe SDK results and prepare request context; scene mutation and workflow sequencing remain in their existing owners.

## Loop detector

`LoopDetector` detects four consecutive failed calls to the same tool with structurally equal JSON parameters. Object key order does not affect equality; array order and parameter values do. A successful call, a different tool, or different parameters breaks the failure streak. SDK validation errors and adapter rejections count in the model's tool-call order, including multiple calls in one response.

Recovery occurs before the next model request. It restores the initial instructions and user messages, replacing the current phase's native retry history with a data-only list of completed calls, parameters, success flags, and errors. The detector retains its call journal and starts a fresh failure streak. The caller supplies current scene snapshots and keeps prior completed review history. Recovery changes request context without executing tools, changing scenes, relaxing validation, or consuming a review attempt.

Each agent role uses its own detector. `loop_detected` progress events identify recoveries in the activity log. The plugin is exported through the agent package and has no provider or scene-specific recovery rules.
