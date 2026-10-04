import { createServer } from 'node:http';
import { mockModel, requestContext } from './model';

let model = mockModel();
const server = createServer(async (request, response) => {
  const controller = new AbortController();
  response.once('close', () => { if (!response.writableEnded) controller.abort(); });
  if (request.url === '/health') { response.end('ok'); return; }
  if (request.url === '/requests') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(model.requests.map(item => ({ model: item.model, tools: item.tools.map(tool => tool.function.name), ...requestContext(item) })))); return; }
  if (request.url === '/reset') { model = mockModel(); response.end('ok'); return; }
  let body = '';
  for await (const chunk of request) body += chunk.toString();
  try {
    const result = await model.fetcher(`http://127.0.0.1:5189${request.url}`, { body, signal: controller.signal });
    response.writeHead(result.status, { 'Content-Type': 'application/json' }); response.end(await result.text());
  } catch { response.end(); }
});
server.listen(5189, '127.0.0.1');
process.once('SIGTERM', () => server.close());
