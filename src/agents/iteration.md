# Iterating on model-generated drawings

Use this workflow when asked to improve a drawing agent by running it against an image prompt. The goal is to improve the agent's general ability to use the drawing tools, not to encode a solution for the test subject.

## Establish a clean baseline

1. Read `AGENTS.md`, this layer's README, and the applicable CLI documentation. Identify the app's configured model and requested defaults through the app configuration and model selector. Run through the app or its CLI; do not query the model host separately.
2. Keep the prompt, model, canvas size, layer count, image divisor, seed, and other requested settings fixed. Record them with the run. Do not add hints, examples, or subject-specific instructions to the prompt.
3. Start from a blank scene and make one first-shot run. Save the image and scene data before inspecting the render. Preserve these artifacts unchanged as the baseline.
4. After the first shot is saved, inspect the rendered output and the tool/run logs. Record observable problems: missing or malformed shapes, duplicates, poor placement, failed tool calls, repeated analysis without action, or limitations of the renderer. Separate visual quality problems from tool-contract and service failures.

## Improve the agent without teaching the subject

Make the smallest generic change supported by the evidence. Prefer clear, familiar tool contracts and standard geometry over adding subject-specific recipes. Improve normalization or validation when a valid, intuitive tool call is rejected; improve the renderer only when its output cannot express a generally useful visual effect; improve prompts when the model repeats itself, redraws existing work, or fails to act on visible evidence.

Keep instructions applicable to any drawing. For example, `update or remove an existing object by ID; add only distinct missing objects` is general. `Put a triangular roof above two square windows` teaches one house composition and invalidates a test of whether the model can draw a house unaided. Do not insert the target image, a hand-built scene, or corrective geometry into the model's context as hidden help.

Make one conceptual change at a time where practical. Keep the first-shot artifact and each later result separate. Capture tool errors and rendered previews so a change can be tied to an observed effect.

## Continue from the actual scene

A new CLI invocation may create a new, empty scene. It is not a revision of the first image just because it uses the same prompt. To assess an iterative correction, carry forward the saved scene data using the app's supported initial-scene input, or continue within the same run. Record when a run starts from a blank scene and label that result as a separate attempt.

For each iteration, keep the original prompt and settings. Give the agent the current scene and image, ask it to compare the image with the request, and let it choose a focused correction using the general tools. Render the result and compare it with the prior revision. Do not tell it which target-specific shapes or coordinates to add. Stop when changes no longer improve the requested result, a repeatable service limitation prevents a fair run, or the requested iteration budget is reached; report that limit rather than presenting a partial preview as a completed revision.

## Example: `A house`

Use the exact prompt `A house`, the selected first model, and the requested defaults. Save and inspect the first render only after the first-shot artifact is safely recorded. If the result is recognizable but sparse, or a later pass duplicates the roof and repeats analysis, diagnose those as general composition, scene-update, and action-selection problems. A suitable agent-level response is to make existing objects easy to update/remove by ID and to ask for one evidence-based correction before another render. Do not teach roof shape, window count, door placement, colors, or a fixed list of house parts.

Carry the actual house scene into the next pass. A second `A house` run from a blank canvas is another sample, not an improvement of the first. Once the generic change is stable, use a different simple subject, such as `A tree`, with the same tool contract and defaults to check that the change did not overfit to houses.

## Finish the experiment

During exploratory iterations, keep tests and documentation changes until the behavior is stable, unless the user asks otherwise. At the end, add or adjust targeted tests for the generic contract, update the relevant documentation, and run typecheck, lint, relevant tests, and the appropriate build. Summarize which artifacts are first-shot results, which are actual continuations, what changed in the agent, and any model/service failures. Do not claim that an image was improved if the model did not continue from its saved scene.
