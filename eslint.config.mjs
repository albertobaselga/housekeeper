import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '.claude/**',
      '**/dist/**',
      '**/build/**',
      '**/.svelte-kit/**',
      // Salida del adaptador de Vercel: artefactos de build, no fuentes.
      '**/.vercel/**',
      'coverage/**',
      'artifacts/**',
      // Los .svelte requieren eslint-plugin-svelte; pendiente de incorporarse.
      '**/*.svelte'
    ]
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
);
