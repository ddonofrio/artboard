import { defineConfig, loadEnv } from 'vite';
import { createDrawingService } from './src/adapters/server/index';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => ({
  server: { fs: { deny: ['**/.env', '**/.env.*', '**/*.local.json', '**/agents.local.json', '**/outputs/logs/**', resolve(process.env.ARTBOARD_CONFIG_FILE || loadEnv(mode, process.cwd(), '').ARTBOARD_CONFIG_FILE || 'agents.local.json').replace(/\\/g, '/')] } },
  plugins: mode === 'library' ? [] : [{
    name: 'artboard-drawing-service',
    async configureServer(server) {
      server.middlewares.use(await createDrawingService({ root: server.config.root, environment: { ...loadEnv(server.config.mode, server.config.root, ''), ...process.env } }));
    },
    async configurePreviewServer(server) {
      server.middlewares.use(await createDrawingService({ root: server.config.root, environment: { ...loadEnv(server.config.mode, server.config.root, ''), ...process.env } }));
    },
  }],
  build: mode === 'library' ? {
    outDir: 'dist-lib',
    copyPublicDir: false,
    lib: {
      entry: { index: 'src/core/index.ts', agents: 'src/agents/index.ts', workflows: 'src/workflows/index.ts', node: 'src/adapters/node/index.ts' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: { external: ['ai', '@ai-sdk/openai-compatible', 'ajv', 'pngjs', 'jpeg-js', /^node:/] },
  } : { outDir: 'dist' },
}));
