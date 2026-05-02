// Flat config (ESLint 9). Enforces CLAUDE.md §1.2 hard rules across the monorepo.
// Strategy: type-checked rules apply only to source TS files inside the workspace
// projects; config files (`*.config.{js,mjs,ts,cjs}`, `eslint.config.mjs`) get a
// non-typed lint pass so we don't pay the cost of pulling them into a tsconfig.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';

const SOURCE_GLOBS = [
  'apps/web/app/**/*.{ts,tsx}',
  'apps/web/lib/**/*.{ts,tsx}',
  'apps/web/components/**/*.{ts,tsx}',
  'apps/web/__tests__/**/*.{ts,tsx}',
  'apps/api/src/**/*.ts',
  'apps/api/test/**/*.ts',
  'packages/shared/src/**/*.ts',
  'packages/ui/src/**/*.{ts,tsx}',
];

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/build/**',
      '**/coverage/**',
      '**/generated/**',
      'data/**',
      // Python virtualenvs occasionally bundle .js assets (e.g. akshare's
      // `outcrypto.js`); keep ESLint out of them entirely.
      '**/.venv/**',
    ],
  },
  // ---- 1. Source TS/TSX: full type-checked strict rules ----
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: SOURCE_GLOBS,
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: SOURCE_GLOBS,
  })),
  {
    files: SOURCE_GLOBS,
    languageOptions: {
      parserOptions: {
        project: [
          'apps/web/tsconfig.json',
          'apps/api/tsconfig.json',
          'packages/shared/tsconfig.json',
          'packages/ui/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      import: importPlugin,
      unicorn,
    },
    rules: {
      // CLAUDE.md §1.2 — type safety zero tolerance
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-empty-object-type': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-wrapper-object-types': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // CLAUDE.md §1.2 — no console / default exports / enum / require
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'Use `as const` object + literal union instead of enum (CLAUDE.md §1.2).',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message: 'Use ESM import; require() is forbidden (CLAUDE.md §1.2).',
        },
      ],
      'import/no-default-export': 'error',

      // Encourage purity / no hidden time/random
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'Inject Clock instead of using Date in components/services.' },
      ],

      // File / function size per CLAUDE.md §1.2
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 10],
    },
  },
  // ---- 2. Test files: relax some rules ----
  {
    files: ['**/*.{test,spec,e2e-spec}.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      'max-lines-per-function': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Tests build fake Express/Nest objects whose runtime shape is narrower
      // than the framework's public type; structural casts are how we stub
      // them without dragging in heavy mocking libraries.
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  // ---- 2.1. Test helpers (non-spec files under tests/_util) ----
  {
    files: ['**/test/_util/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
    },
  },
  // ---- 2.2. Cross-process contract tests ----
  // These spawn an external server (Python Flight, NestJS via supertest)
  // and inspect the wire — supertest's `Response.body` is typed `any`,
  // and `app.getHttpServer()` returns `any` from the Nest API. Both are
  // intentional library decisions; chasing them with casts would make
  // the tests harder to read, not safer.
  {
    files: ['**/test/contract/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  // ---- 3. Next.js framework-required default exports ----
  {
    files: [
      'apps/web/app/**/page.{ts,tsx}',
      'apps/web/app/**/layout.{ts,tsx}',
      'apps/web/app/**/loading.{ts,tsx}',
      'apps/web/app/**/error.{ts,tsx}',
      'apps/web/app/**/not-found.{ts,tsx}',
      'apps/web/app/**/route.{ts,tsx}',
      'apps/web/app/**/template.{ts,tsx}',
    ],
    rules: {
      'import/no-default-export': 'off',
    },
  },
  // ---- 4. NestJS modules are intentionally empty classes ----
  {
    files: ['apps/api/src/**/*.module.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  // ---- 4.1. Dynamic-library bridges (proto-loader, express monkey-patch) ----
  // These files are the only place where the static type system meets a
  // dynamically-typed runtime surface (`@grpc/proto-loader` builds the
  // FlightService client from a .proto at runtime; Express stores arbitrary
  // properties on `Request`). The casts here are documented narrow bridges,
  // not loopholes — they belong in adapters and nowhere else.
  {
    files: [
      'apps/api/src/adapters/flight/flight-client.ts',
      'apps/api/src/adapters/flight/proto-loader.ts',
      'apps/api/src/common/trace.middleware.ts',
      'apps/api/src/common/quant-error.filter.ts',
      // Zod's `safeParse` returns `data: any` for ZodTypeAny generics;
      // the pipe re-asserts the validated shape at the boundary.
      'apps/api/src/common/zod-pipe.ts',
      // Controllers that read `req.traceId` written by the middleware go
      // through the same Express monkey-patch bridge.
      'apps/api/src/modules/*/*.controller.ts',
      // Arrow → DTO mapper crosses a dynamic-runtime/static-type boundary;
      // and it decodes `Date`-typed columns from storage (not "now()"), so
      // the no-Date rule does not apply here either.
      'apps/api/src/modules/*/domain/arrow-mapper.ts',
    ],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      'no-restricted-globals': 'off',
    },
  },
  // ---- 4.5. Core asset boundary (CLAUDE.md §2.5.1) ----
  // These directories MUST stay framework/IO/config-free. The list below is
  // mechanical guard against accidental imports of forbidden modules from
  // pure code. Update both `paths` and `patterns` together when banning new deps.
  {
    files: [
      'packages/shared/src/**/*.{ts,tsx}',
      'apps/web/lib/fp/**/*.{ts,tsx}',
      'apps/web/lib/types/**/*.{ts,tsx}',
      'apps/api/src/modules/*/domain/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: 'Core asset must be IO-free (CLAUDE.md §2.5.1).' },
            { name: 'fs/promises', message: 'Core asset must be IO-free.' },
            { name: 'node:fs', message: 'Core asset must be IO-free.' },
            { name: 'node:fs/promises', message: 'Core asset must be IO-free.' },
            { name: 'path', message: 'Core asset must be IO-free.' },
            { name: 'node:path', message: 'Core asset must be IO-free.' },
            { name: 'http', message: 'Core asset must be IO-free.' },
            { name: 'https', message: 'Core asset must be IO-free.' },
            { name: 'node:http', message: 'Core asset must be IO-free.' },
            { name: 'node:https', message: 'Core asset must be IO-free.' },
            { name: 'axios', message: 'Core asset must be IO-free.' },
            { name: 'node-fetch', message: 'Core asset must be IO-free.' },
            { name: 'undici', message: 'Core asset must be IO-free.' },
            { name: 'pino', message: 'Core asset must not depend on logger.' },
            { name: 'winston', message: 'Core asset must not depend on logger.' },
          ],
          patterns: [
            { group: ['@nestjs/*'], message: 'Core asset must not depend on NestJS framework.' },
            { group: ['next/*', 'next'], message: 'Core asset must not depend on Next.js.' },
            {
              group: ['**/adapters/**', '**/*.adapter', '**/*.adapter.ts'],
              message: 'Core asset must not import adapters (CLAUDE.md §2.5.1).',
            },
            {
              group: ['**/repository/**', '**/*.repository', '**/*.repository.ts'],
              message: 'Core asset must not import repositories.',
            },
          ],
        },
      ],
    },
  },
  // ---- 5. Config files: untyped, plain JS rules only ----
  {
    files: ['eslint.config.mjs', '**/*.config.{js,mjs,ts,cjs}', 'apps/web/next.config.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'off', // CommonJS module/require handled by globals
    },
  },
];
