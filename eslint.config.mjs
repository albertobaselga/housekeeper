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
      // Prototipo legacy preservado en el tag demo-v0.1.0; no se lintan sus fuentes.
      'app.js',
      'auth.js',
      'data.js',
      'logic.js',
      'offline.js',
      'server.mjs',
      'sw.js',
      'tests/**',
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
