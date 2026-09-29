// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // Underscore-prefixed args/vars are an intentional "unused" marker (fake-impl
      // signatures, destructure drops) — the standard convention, no behavior change.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Deploy/drill scripts (.mjs + scripts/*.ts) and the eslint config itself are NOT
    // in the TS build project (tsconfig include = src/test), so the type-aware project
    // service can't resolve them ("not found by the project service"). Lint them
    // syntactically without type info instead of erroring on parse. They run via tsx /
    // node directly and are covered by the live drills, not the typed build.
    files: ['**/*.mjs', 'scripts/**', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['test/**', 'test-live/**'],
    rules: {
      // Tests legitimately reach into `any`-typed fakes/fixtures and assert non-null
      // after expect()/find() — noise, not a prod-safety risk. Prod `src/` keeps the
      // full strict set (no-non-null-assertion + the unsafe-* family stay ON there).
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
