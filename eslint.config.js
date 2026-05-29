import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const nodeGlobals = {
  ...globals.es2022,
  ...globals.node,
};

const browserGlobals = {
  ...globals.es2022,
  ...globals.browser,
};

const ignores = [
  '.beads/**',
  '.claude/**',
  '.codex/**',
  '.dolt/**',
  '.specify/**',
  '.specify-self-verify/**',
  '.worktrees/**',
  'agent-runs/**',
  'assets/**',
  'captures/**',
  'cli-report/**',
  'dist/**',
  'node_modules/**',
  'webapp/node_modules/**',
  'webapp/dist/**',
];

const correctnessRules = {
  'array-callback-return': ['error', { allowImplicit: false }],
  curly: ['error', 'all'],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-alert': 'error',
  'no-caller': 'error',
  'no-constructor-return': 'error',
  'no-control-regex': 'off',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-eval': 'error',
  'no-extend-native': 'error',
  'no-implied-eval': 'error',
  'no-new-func': 'error',
  'no-proto': 'error',
  'no-return-assign': ['error', 'always'],
  'no-script-url': 'off',
  'no-self-compare': 'error',
  'no-template-curly-in-string': 'off',
  'no-unmodified-loop-condition': 'error',
  'no-unreachable-loop': 'error',
  'no-unused-expressions': 'error',
  'no-useless-assignment': 'error',
  'no-useless-call': 'error',
  'no-useless-concat': 'error',
  'no-useless-rename': 'error',
  'no-useless-return': 'error',
  'prefer-promise-reject-errors': 'error',
  'preserve-caught-error': 'off',
};

const typeAwareRules = {
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { disallowTypeAnnotations: false, fixStyle: 'separate-type-imports' },
  ],
  '@typescript-eslint/no-import-type-side-effects': 'error',
  '@typescript-eslint/no-require-imports': 'off',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      args: 'after-used',
      argsIgnorePattern: '^_',
      caughtErrors: 'all',
      caughtErrorsIgnorePattern: '^_',
      ignoreRestSiblings: true,
      varsIgnorePattern: '^_',
    },
  ],
  '@typescript-eslint/no-useless-empty-export': 'error',
  '@typescript-eslint/switch-exhaustiveness-check': 'error',
};

const localStaticAnalysisRules = {
  ...security.configs.recommended.rules,
  'security/detect-object-injection': 'off',
  'security/detect-non-literal-fs-filename': 'off',
  'sonarjs/no-all-duplicated-branches': 'error',
  'sonarjs/no-collection-size-mischeck': 'error',
  'sonarjs/no-duplicate-in-composite': 'error',
  'sonarjs/no-identical-conditions': 'error',
  'sonarjs/no-identical-expressions': 'error',
  'sonarjs/no-identical-functions': 'error',
  'sonarjs/no-ignored-return': 'error',
  'sonarjs/no-inverted-boolean-check': 'error',
  'sonarjs/no-nested-assignment': 'error',
  'sonarjs/no-redundant-boolean': 'error',
  'sonarjs/no-redundant-jump': 'error',
  'sonarjs/no-small-switch': 'error',
  'sonarjs/no-use-of-empty-return-value': 'error',
  'sonarjs/prefer-single-boolean-return': 'error',
};

const unicornRules = {
  'unicorn/error-message': 'error',
  'unicorn/new-for-builtins': 'error',
  'unicorn/no-array-callback-reference': 'error',
  'unicorn/no-array-method-this-argument': 'error',
  'unicorn/no-await-expression-member': 'error',
  'unicorn/no-instanceof-array': 'error',
  'unicorn/no-invalid-fetch-options': 'error',
  'unicorn/no-invalid-remove-event-listener': 'error',
  'unicorn/no-new-array': 'error',
  'unicorn/no-new-buffer': 'error',
  'unicorn/no-single-promise-in-promise-methods': 'error',
  'unicorn/no-unnecessary-await': 'error',
  'unicorn/no-unreadable-array-destructuring': 'error',
  'unicorn/no-useless-fallback-in-spread': 'error',
  'unicorn/no-useless-length-check': 'error',
  'unicorn/no-useless-promise-resolve-reject': 'error',
  'unicorn/no-useless-spread': 'error',
  'unicorn/prefer-date-now': 'error',
  'unicorn/prefer-keyboard-event-key': 'error',
  'unicorn/prefer-native-coercion-functions': 'error',
  'unicorn/prefer-optional-catch-binding': 'error',
  'unicorn/prefer-prototype-methods': 'error',
  'unicorn/prefer-regexp-test': 'error',
  'unicorn/prefer-type-error': 'error',
  'unicorn/throw-new-error': 'error',
};

export default tseslint.config(
  {
    ignores,
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [eslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: nodeGlobals,
      sourceType: 'module',
    },
    plugins: {
      security,
      sonarjs,
      unicorn,
    },
    rules: {
      ...correctnessRules,
      ...localStaticAnalysisRules,
      ...unicornRules,
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
  {
    files: ['scripts/browse-and-capture.mjs'],
    languageOptions: {
      globals: {
        ...nodeGlobals,
        document: 'readonly',
      },
    },
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'webapp/src/**/*.{ts,tsx}', 'webapp/vite.config.ts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: nodeGlobals,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['webapp/vite.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      sourceType: 'module',
    },
    plugins: {
      security,
      sonarjs,
      unicorn,
    },
    rules: {
      ...correctnessRules,
      ...typeAwareRules,
      ...localStaticAnalysisRules,
      ...unicornRules,
    },
  },
  {
    files: ['webapp/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: browserGlobals,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'sonarjs/no-duplicate-string': 'off',
    },
  },
  eslintConfigPrettier,
);
