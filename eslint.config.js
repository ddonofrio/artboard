import tseslint from 'typescript-eslint';

const boundaries = (files, allowed) => ({
  files,
  rules: {
    'no-restricted-imports': ['error', { patterns: [{ regex: `^(?!${allowed})`, message: 'Keep imports inside this layer and its declared dependencies.' }] }],
  },
});

export default tseslint.config(
  ...tseslint.configs.recommended,
  { ignores: ['dist/**', 'dist-lib/**', 'node_modules/**', 'outputs/**', 'examples/**'] },
  boundaries(['src/core/**/*.ts'], '\\./|ajv$'),
  boundaries(['src/agents/**/*.ts'], '\\./|\\.\\./plugins/|\\.\\./core/|ai$|ajv$|@ai-sdk/openai-compatible$'),
  boundaries(['src/adapters/node/**/*.ts'], '\\./|\\.\\./\\.\\./core/|node:|pngjs$|jpeg-js$'),
  boundaries(['src/ui/**/*.ts'], '\\./|\\.\\./contracts/'),
  boundaries(['src/contracts/**/*.ts'], '\\./'),
  boundaries(['src/workflows/**/*.ts'], '\\./|\\.\\./agents/|\\.\\./core/|\\.\\./contracts/'),
  boundaries(['src/adapters/server/**/*.ts'], '\\./|\\.\\./node/|\\.\\./\\.\\./core/|\\.\\./\\.\\./agents/|\\.\\./\\.\\./workflows/|\\.\\./\\.\\./contracts/|node:'),
  {
    files: ['src/core/**/*.ts', 'src/agents/**/*.ts'],
    rules: { 'no-restricted-globals': ['error', 'window', 'document', 'localStorage', 'sessionStorage', 'navigator'] },
  },
);
