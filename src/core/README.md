# Drawing core

This layer owns scene data, schemas, catalogs, recipes, deterministic CPU rendering, atomic edits, history, and the provider-independent `SceneTools` interface. It has no UI, model, filesystem, or transport dependency. Its only external dependency is Ajv for validation.

Coordinates start at the top-left. Bounds are `[x, y, width, height]`. All scenes use the same fixed 16-color basic palette. Stored objects use palette indices; the renderer owns their exact RGB values. Alternate or custom palettes are rejected. Equal layers use object array order, preserved in serialization. Procedural objects receive stable seeds. Rendering produces RGBA pixel data; adapters encode images and persist files.

`SceneTools` exposes catalog discovery, scene creation, inspection, atomic operation batches, rendering, undo/redo, JSON persistence, and PNG export. Its injected `ToolAdapter` owns image references and file access. No tool evaluates code. Circles use ellipse bounds; rectangles and triangles use polygons. Recipes remain available for offline consumers while drawing agents create their own compositions.

One successful batch creates one undo entry. Failed edits leave content, revision, pixels, and history unchanged. Revisions increase through undo/redo while content and seeds restore. Expected revisions reject stale edits.

```ts
import { PixelRenderer, SceneStore } from 'artboard';

const scenes = new SceneStore();
scenes.create({ scene_id: 'drawing' });
scenes.apply('drawing', [{
  op: 'add',
  object: { id: 'sun', kind: 'ellipse', bounds: [80, 40, 60, 60], layer: 1, color: 14 },
}]);
const image = new PixelRenderer().render(scenes.get('drawing'));
```

Runtime contracts generate [scene](../../schemas/scene.schema.json) and [tool](../../schemas/tools.schema.json) JSON schemas with `npm run schemas`. Add materials and generators through the catalog and their rendering implementations, then update focused tests. Hosts register decoded sprites with the renderer; the renderer never downloads them.
