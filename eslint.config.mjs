import {includeIgnoreFile} from '@eslint/compat'
import oclif from 'eslint-config-oclif'
import prettier from 'eslint-config-prettier'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import tseslint from 'typescript-eslint'

const gitignorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.gitignore')

const config = [
  includeIgnoreFile(gitignorePath),
  {
    ignores: ['coverage/', 'dist/'],
  },
  ...oclif,
  // Disable type-checked (type-aware) rules for test files. Test fixtures and
  // mocks don't need full type information and shouldn't fail type-aware rules
  // such as no-unsafe-* / no-base-to-string. Mirrors plugin-lib#63.
  {
    files: ['test/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  // Relax overly-strict rules from eslint-config-oclif@7 across the project.
  {
    rules: {
      // The Kubernetes API and kubectl's JSON output legitimately return null (not undefined)
      '@typescript-eslint/no-restricted-types': 'off',
    },
  },
  // `strict-void-return`: plugin-lib's auth-command factories type
  // `clearClients` as `() => void` and call it fire-and-forget, but our
  // teardown (`closeConnections`) is async by nature.
  {
    files: ['src/commands/**/*.ts', 'src/base-command.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/strict-void-return': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      'perfectionist/sort-classes': 'off',
      'require-unicode-regexp': 'off',
      // Boolean names here mirror the CLI flags they carry (`--all`, `--clear`)
      // or read as predicates (`matchesEntry`); an `is`/`has` prefix reads worse.
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/consistent-class-member-order': 'off',
      // `Array#toSorted` (ES2023) and `Iterator#toArray` (ES2025) are not in the
      // ES2022 lib this package targets.
      'unicorn/no-array-sort': 'off',
      'unicorn/no-computed-property-existence-check': 'off',
      'unicorn/prefer-iterator-to-array': 'off',
    },
  },
  // Additional relaxations for test files only. These are pure style rules
  // that conflict with common test patterns (mock stubs, mock-tracking
  // booleans, the documented bare `eslint-disable max-params` convention).
  {
    files: ['test/**/*.ts'],
    rules: {
      '@eslint-community/eslint-comments/require-description': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      'require-unicode-regexp': 'off',
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/no-computed-property-existence-check': 'off',
      'unicorn/no-non-function-verb-prefix': 'off',
      'unicorn/prefer-https': 'off',
    },
  },
  prettier,
]

export default config
