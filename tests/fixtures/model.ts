import type { Scene } from '../../src/core/types';
import { namedColors, indexedColors } from '../../src/agents/colors';
import { BASIC_PALETTE } from '../../src/core/colors';

export function sceneFromModel(scene: Scene): Scene {
  return indexedColors({ ...scene, palette: BASIC_PALETTE }) as Scene;
}

export interface ChatRequest {
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  reasoning_effort?: string;
  model: string;
  messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] | null }[];
  tools: { function: { name: string } }[];
}
interface Context {
  prompt: string; scene_id: string; round: number; current_scene?: Scene; draft?: { scene: Scene };
  continuation?: string;
  workflow?: { role: string; stage_index: number; final: boolean; history: unknown[]; previous: unknown };
  review?: unknown;
}
export function requestContext(request: ChatRequest): Context {
  const message = request.messages.filter(item => item.role === 'user').at(-1)!;
  return JSON.parse(typeof message.content === 'string' ? message.content : message.content!.find(part => part.type === 'text')!.text!);
}
export function mockModel() {
  const requests: ChatRequest[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    if (String(input).endsWith('/models')) return Response.json({ data: [{ id: 'embedding-test' }, { id: 'test-model' }, { id: 'second-model' }] });
    const request = JSON.parse(String(init?.body)) as ChatRequest;
    requests.push(request);
    const context = requestContext(request);
    if (context.prompt.includes('[slow]')) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 10000);
      init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
    });
    if (context.prompt.includes('[fail]') || (context.prompt.includes('[fail-after-background]') && context.workflow?.stage_index === 2)) return Response.json({ error: { message: 'Simulated model failure' } }, { status: 400 });
    const reviewer = request.tools.some(tool => tool.function.name === 'submit_review');
    const scene = context.current_scene ?? context.draft?.scene;
    const role = context.workflow?.role ?? 'artist';
    const id = `${role}_${context.round}`;
    let name: string, args: Record<string, unknown>;
    let extraCalls: { name: string; args: Record<string, unknown> }[] = [];
    const lastToolMessage = [...request.messages].reverse().find(item => item.role === 'tool');
    const needsImageCheck = typeof lastToolMessage?.content === 'string' && lastToolMessage.content.includes('has edits the model has not visually checked');
    if (reviewer) {
      const pending = context.round === 1 && request.messages.some(item => item.role === 'tool' && typeof item.content === 'string' && item.content.includes('final artist reports unresolved'));
      const approved = !pending && !context.prompt.includes('[limit]') && !(context.prompt.includes('[reject]') && context.round === 1);
      name = 'submit_review'; args = { revision: scene!.revision, approved, issues: approved ? [] : [{ object_id: 'scene', instruction: 'Add the requested detail in front of the scene.' }] };
    } else if (!scene) {
      name = 'scene_create'; args = { scene_id: context.scene_id, width: 64, height: 48 };
    } else if (!scene.objects.some(object => object.id === id) && !(context.prompt.includes('[noop]') && ['foreground', 'specialist'].includes(role))) {
      const layer = (context.workflow?.stage_index ?? 1) * 10 + context.round;
      const background = !scene.objects.length;
      name = 'scene_apply'; args = { scene_id: context.scene_id, operations: [{ op: 'add', object: {
        id, kind: 'polygon', layer: background ? -100 : layer, color: (layer % 14) + 1,
        points: background ? [[0, 0], [64, 0], [64, 48], [0, 48]] : [[layer % 40, 12], [layer % 40 + 8, 12], [layer % 40 + 8, 28], [layer % 40, 28]],
      } }] };
      if (context.prompt.includes('[nested]')) (args.operations as unknown[]).push(
        { op: 'add', object: { id: `${id}_inner`, kind: 'polygon', points: [[16,12],[48,12],[48,36],[16,36]], color: 7, layer: layer + 1 } },
        { op: 'add', object: { id: `${id}_circle`, kind: 'ellipse', bounds: [24,16,16,16], color: 14, layer: layer + 2 } },
      );
      if (context.prompt.includes('[paired-calls]')) extraCalls = [{ name: 'scene_apply', args: { scene_id: context.scene_id, operations: [
        { op: 'add', object: { id: `${id}_inner`, kind: 'polygon', points: [[16,12],[48,12],[48,36],[16,36]], color: 7, layer: layer + 1 } },
      ] } }];
    } else if (needsImageCheck) {
      name = 'scene_render'; args = { scene_id: context.scene_id };
    } else {
      name = 'finish_draft';
      const invalidBefore = request.messages.some(item => item.role === 'tool' && typeof item.content === 'string' && item.content.includes('Invalid finish_draft'));
      args = { revision: scene.revision, ...(context.workflow ? { done: [`${role} completed`], not_done: context.workflow.final ? [] : [{ item: 'Remaining requested content', reason: 'Assigned to subsequent stages' }] } : {}) };
      if (context.prompt.includes('[pending]') && context.workflow?.final && context.round === 1) args.not_done = [{ item: 'Required subject detail', reason: 'Failed to draw it yet' }];
      if (context.prompt.includes('[invalid-handoff]') && !invalidBefore) delete args.not_done;
    }
    return Response.json({ id: `chat-${requests.length}`, object: 'chat.completion', created: 1, model: request.model,
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, ...(context.prompt.includes('[thinking]') ? { reasoning_content: 'Inspect the requested scene and place each element in its assigned layer. '.repeat(20) } : {}), tool_calls: [{ name, args }, ...extraCalls].map((call, index) => ({ id: `call-${requests.length}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(namedColors(call.args)) } })) } }],
      usage: context.prompt.includes('[thinking]')
        ? { prompt_tokens: 50, completion_tokens: 600, total_tokens: 650, completion_tokens_details: { reasoning_tokens: 512 } }
        : { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 },
    });
  };
  return { fetcher, requests };
}
