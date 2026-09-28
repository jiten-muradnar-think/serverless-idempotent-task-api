import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // A floating promise in a Lambda silently drops work when the runtime freezes.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Non-null assertions hide exactly the config bugs this service fails fast on.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'error',
    },
  },
  {
    // Tests assert against untyped CloudFormation JSON and index into fixture
    // arrays they have just built. Both are safe here and the strict rules add
    // noise rather than safety.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // Fakes implement an async port without needing to await anything.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    ignores: [
      'dist/**',
      'cdk.out/**',
      'coverage/**',
      'node_modules/**',
      'eslint.config.mjs',
      'jest.config.js',
    ],
  },
);
