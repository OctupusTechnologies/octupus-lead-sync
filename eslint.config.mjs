import js from '@eslint/js';
import globals from 'globals';

const rules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'all' }],
  'no-var': 'error',
  'prefer-const': 'error',
  eqeqeq: ['error', 'always'],
  'no-implicit-globals': 'off', // los scripts clásicos comparten ámbito a propósito (shared.js)
};

export default [
  { ignores: ['node_modules/**', 'site/**'] },
  js.configs.recommended,
  {
    // Content script y páginas: scripts clásicos con acceso al DOM
    files: ['src/bridge.js', 'src/popup.js', 'src/options.js', 'src/shared.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions },
    },
    rules,
  },
  {
    // Service worker: sin DOM (document/window no existen)
    files: ['src/background.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...globals.serviceworker, ...globals.webextensions },
    },
    rules,
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules,
  },
  {
    files: ['eslint.config.mjs'],
    languageOptions: { sourceType: 'module', globals: globals.node },
  },
];
