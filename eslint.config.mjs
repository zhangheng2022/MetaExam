import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
export default ts.config(
  {
    ignores: [
      '**/dist/**',
      '**/renderer-dist/**',
      'artifacts/**',
      '.tools/**',
      '.local/**',
      'work/**',
      'graphify-out/**',
      '.agents/skills/**',
      '.playwright-cli/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    ...reactHooks.configs.flat.recommended,
    files: [
      'apps/web/src/**/*.{ts,tsx}',
      'apps/desktop/renderer/**/*.{ts,tsx}',
      'packages/ui/src/**/*.{ts,tsx}',
    ],
  },
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
