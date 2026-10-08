# Local drawing scripts

`npm run draw-script -- <file.mjs> [output-directory] [script arguments...]` explicitly runs a local JavaScript module. The output directory defaults to `outputs/scripts`. The module must export a default function accepting `(tools, args)`. Scripts can use JavaScript loops, functions and coordinate calculations. No model connection is required.

`npm run agent -- [--layers 1-7] [--model ID] [--image-divisor 1-64] [--max-steps 1-50] <prompt>` runs the configured model workflow. `--max-steps` temporarily caps tool steps in each artist pass for quick experiments; omit it for the normal uncapped run. Image divisor defaults to the app configuration (4 unless overridden).

```js
export default async function draw(tools) {
  const scene_id = 'study';
  await tools.scene_create({ scene_id, width: 640, height: 480 });
  const operations = Array.from({ length: 8 }, (_, i) => ({
    op: 'add',
    object: { id: `bar${i}`, kind: 'rect', rect: [i * 80, 0, 40, 480], color: 'dark cyan' },
  }));
  await tools.scene_apply({ scene_id, operations });
  return tools.scene_io({ scene_id, action: 'export', filename: 'study.png' });
}
```

The host exposes `scene_catalog`, `scene_create`, `scene_inspect`, `scene_apply`, `scene_render`, `scene_history`, `scene_io`, and `call(name, arguments)`. Each resolves to the tool's result object; failed results throw with the original actionable diagnostic. Geometry aliases and English color names use the agent's existing normalization. Results return named colors. Calls execute sequentially even when queued concurrently. The host drains queued calls before completion and stops executing further calls after the first failure. Successful earlier calls remain; each individual `scene_apply` batch is atomic and creates one undo entry.

Core validation remains authoritative: one fixed 16-color palette, up to 512 scene objects, 128 operations per batch, 256 points per polygon/line, and canvas dimensions from 32 to 1280 by 32 to 960. Image exports and scene files use the existing adapter-scoped filenames. The CLI prints a JSON summary containing the tool-call count and the script's returned value; failures exit with code 1.

This command executes trusted local modules with ordinary Node.js permissions. It is not a JavaScript sandbox or an inline model tool. Autonomous editor/reviewer responses still contain validated drawing data and never execute generated JavaScript. Script execution is an explicit local CLI action.

## Model-driven CLI

`npm run agent -- [options] <prompt>` runs the same editor workflow used by the browser and saves its artifacts under `outputs/`.

```sh
npm run agent -- --model ornith --layers 1 --image-divisor 4 "A house"
```

The endpoint and optional API key come from the app's local configuration or environment. `--model` temporarily selects the same model for editor and reviewer roles; it does not change that configuration. Supported options are `--layers 1-7`, `--model ID`, `--image-divisor 1-64`, `--max-steps 1-50`, and `--reasoning-effort none|low|medium|high`. The five-step cap is for quick exploratory runs; omit it to restore normal uncapped behavior. The prompt is required. This command does not discover models independently; it uses the configured connection.

## Fighter reference study

```sh
npm run draw-script -- scripts/drawings/fighter-reference.mjs outputs/fighter-reference
npm run draw-script -- scripts/drawings/fighter-reference.mjs outputs/fighter-reference reviewed
```

`fighter-reference.mjs` reconstructs a supplied photograph with polygons, polylines and the existing dither material. It uses no bitmap, external sprite, custom palette or image generator. The canvas is 641 by 568, matching the supplied reference rather than the default 640 by 480. The deterministic seed fixes every terrain detail.

The first mode produces `01-first-shot.json` and `.png` with 303 objects. This composition was frozen before opening its render. The `reviewed` mode produces `02-reviewed.json` and `.png` with 498 objects: thinner cloud ribbons, clipped color stripes, more terrain relief and fuselage highlights. The two modes have independent filenames and scene IDs. Re-running a mode replaces its own exports. Palette restrictions prevent continuous photographic tones; rasterization has no antialiasing, blending or blur. The dense dither is part of the actual output, not a display filter.
