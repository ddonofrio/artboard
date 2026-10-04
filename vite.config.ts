import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  build: mode === 'library' ? {
    outDir: 'dist-lib',
    copyPublicDir: false,
    lib: {
      entry: { index: 'src/core/index.ts', agents: 'src/agents/index.ts', node: 'src/adapters/node/index.ts' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: { external: ['ai', '@ai-sdk/openai-compatible', 'ajv', 'pngjs', 'jpeg-js', /^node:/] },
  } : { outDir: 'dist' },
}));
