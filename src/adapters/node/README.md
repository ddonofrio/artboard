# Node drawing adapter

This adapter encodes RGBA pixels as PNG/JPEG and persists scene JSON and PNG files under an explicit output directory. It implements core's `ToolAdapter`, without importing agents, UI, or Vite. The package exposes it at `artboard/node`.

File operations validate plain filenames and keep resolved paths inside the configured root. The default preview writes PNG; the agent command overrides preview to return inline JPEG data for model vision. `encodePNG` and `encodeJPEG` also support hosts that own persistence themselves.

`OutputStore` supplies Aventure's output conventions under a configurable `outputs` root. Single drawings use `YYYYMMDD/<prompt>.jpg` (Europe/Madrid date); collisions receive `(1)`, `(2)` suffixes without overwrites. Batches use `batch/<UUID>/<line padded to three digits>.jpg` and reject duplicate indices. Prompt filenames preserve spaces and accents, sanitize Windows-invalid characters and reserved names, and cap UTF-8 length. Workflow revisions/drafts use JSON/JPEG pairs under `workflow/<run UUID>`; the serialized append-only journal lives in `logs/agent.jsonl`. Journal serialization redacts credential fields and inline image bytes. Scene data is validated before saving. Workflow event interpretation belongs to the server adapter.
