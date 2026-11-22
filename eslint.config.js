const { defineConfig, globalIgnores } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const boundaries = require('eslint-plugin-boundaries');
const eslintConfigPrettier = require('eslint-config-prettier/flat');
const globals = require('globals');

const TRIPLE_SLASH_DIRECTIVE_PATTERN = /^\/\s*<(?:reference|amd-module|amd-dependency)\b/;

const localPlugin = {
  rules: {
    'no-comments': {
      meta: {
        type: 'suggestion',
        docs: {
          description:
            'Disallow comments in source code; prefer descriptive names and clear structure.',
        },
        schema: [],
        messages: {
          unexpectedComment:
            'Comments are disallowed. Make variable, function, type, and file names or code structure more descriptive instead.',
        },
      },
      create(context) {
        const isDeclarationFile = context.filename.endsWith('.d.ts');

        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (comment.type === 'Shebang') {
                continue;
              }
              if (
                isDeclarationFile &&
                comment.type === 'Line' &&
                TRIPLE_SLASH_DIRECTIVE_PATTERN.test(comment.value)
              ) {
                continue;
              }
              context.report({
                loc: comment.loc,
                messageId: 'unexpectedComment',
              });
            }
          },
        };
      },
    },
  },
};

const EXPO_EXTENSIONS = [
  '.web.ts',
  '.web.tsx',
  '.ios.ts',
  '.ios.tsx',
  '.android.ts',
  '.android.tsx',
  '.native.ts',
  '.native.tsx',
  '.ts',
  '.tsx',
  '.d.ts',
  '.web.js',
  '.web.jsx',
  '.ios.js',
  '.ios.jsx',
  '.android.js',
  '.android.jsx',
  '.native.js',
  '.native.jsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
];

const BASE_RESTRICTIONS = {
  paths: [],
  patterns: [
    {
      regex: '\\.(web|ios|android|native)(\\.(ts|tsx|js|jsx))?$',
      message:
        'Import the platform-agnostic path instead of a platform-suffixed file so Metro resolves the right platform implementation.',
    },
    {
      group: ['@react-navigation/*'],
      message:
        'Use Expo Router (`expo-router`) for navigation and theme primitives instead of importing `@react-navigation/*` directly.',
    },
    {
      group: ['../../../*'],
      message:
        'Avoid deep relative imports (`../../../*`). Use `@/` path aliases for cross-slice imports.',
    },
    {
      group: ['@/app', '@/app/*'],
      message:
        'Route files in `src/app/` are thin entry points and must not be imported by application code.',
    },
  ],
};

const WEB_ONLY_RESTRICTIONS = {
  paths: [
    {
      name: 'react-dom',
      message:
        'Web-only libraries (react-dom, Three.js, CSS Modules) must stay inside `*.web.{ts,tsx}` files.',
    },
    {
      name: 'three',
      message:
        'Web-only libraries (react-dom, Three.js, CSS Modules) must stay inside `*.web.{ts,tsx}` files.',
    },
  ],
  patterns: [
    {
      group: [
        'react-dom/*',
        'three/*',
        '@react-three/*',
        '**/*.module.css',
        '**/*.module.scss',
        '**/*.module.sass',
        './*.module.css',
        './*.module.scss',
        './*.module.sass',
      ],
      message:
        'Web-only libraries (react-dom, Three.js, CSS Modules) must stay inside `*.web.{ts,tsx}` files.',
    },
  ],
};

const IOS_ONLY_RESTRICTIONS = {
  paths: [],
  patterns: [
    {
      group: [
        '@expo/ui/swift-ui',
        '@expo/ui/swift-ui/*',
        '*realitykit-view*',
        '**/realitykit-view*',
      ],
      message: 'iOS-only libraries (SwiftUI, RealityKit) must stay inside `*.ios.{ts,tsx}` files.',
    },
  ],
};

const ANDROID_ONLY_RESTRICTIONS = {
  paths: [],
  patterns: [
    {
      group: [
        '@expo/ui/jetpack-compose',
        '@expo/ui/jetpack-compose/*',
        '*filament-view*',
        '**/filament-view*',
      ],
      message:
        'Android-only libraries (Jetpack Compose, Filament) must stay inside `*.android.{ts,tsx}` files.',
    },
  ],
};

const FIREBASE_RESTRICTIONS = {
  paths: [
    {
      name: 'firebase',
      message:
        'Keep Firebase SDK calls inside `src/shared/firebase/` or feature services, not in routes or pure domain models.',
    },
  ],
  patterns: [
    {
      group: ['firebase/*', '@react-native-firebase/*'],
      message:
        'Keep Firebase SDK calls inside `src/shared/firebase/` or feature services, not in routes or pure domain models.',
    },
  ],
};

const DOMAIN_RUNTIME_RESTRICTIONS = {
  paths: [
    {
      name: 'react',
      message:
        'Keep `src/shared/domain/` pure and independent of React, React Native, Expo, and renderer runtimes.',
    },
    {
      name: 'react-native',
      message:
        'Keep `src/shared/domain/` pure and independent of React, React Native, Expo, and renderer runtimes.',
    },
    {
      name: 'expo',
      message:
        'Keep `src/shared/domain/` pure and independent of React, React Native, Expo, and renderer runtimes.',
    },
  ],
  patterns: [
    {
      group: ['react/*', 'react-native/*', 'expo-*', '@expo/*'],
      message:
        'Keep `src/shared/domain/` pure and independent of React, React Native, Expo, and renderer runtimes.',
    },
  ],
};

function restrictedImports(...groups) {
  return [
    'error',
    {
      paths: groups.flatMap((group) => group.paths ?? []),
      patterns: groups.flatMap((group) => group.patterns ?? []),
    },
  ];
}

module.exports = defineConfig([
  globalIgnores([
    'dist/**',
    'web-build/**',
    '.expo/**',
    'ios/**',
    'android/**',
    'node_modules/**',
    '.serena/**',
    'coverage/**',
    'expo-env.d.ts',
  ]),

  expoConfig,

  {
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['**/*.d.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {
          assertionStyle: 'as',
          objectLiteralTypeAssertions: 'allow-as-parameter',
        },
      ],
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': 'allow-with-description',
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
          minimumDescriptionLength: 10,
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          vars: 'all',
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          ignoreVoid: true,
        },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        {
          ignoreConditionalTests: true,
          ignoreMixedLogicalExpressions: true,
        },
      ],
      'import/namespace': 'off',
    },
  },

  {
    files: ['src/**/*.{js,jsx,ts,tsx}', 'modules/**/*.{js,jsx,ts,tsx}'],
    plugins: {
      boundaries,
    },
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json',
          extensions: EXPO_EXTENSIONS,
        },
        node: {
          extensions: EXPO_EXTENSIONS,
        },
      },
      'boundaries/ignore': ['**/*.{test,spec}.{ts,tsx,js,jsx}', '**/__tests__/**'],
      'boundaries/elements': [
        { type: 'app', pattern: 'src/app', partialMatch: false, exclusive: true },
        {
          type: 'feature',
          pattern: 'src/features/*',
          capture: ['featureName'],
          partialMatch: false,
          exclusive: true,
        },
        {
          type: 'shared-domain',
          pattern: 'src/shared/domain',
          partialMatch: false,
          exclusive: true,
        },
        {
          type: 'shared-firebase',
          pattern: 'src/shared/firebase',
          partialMatch: false,
          exclusive: true,
        },
        { type: 'shared-ui', pattern: 'src/shared/ui', partialMatch: false, exclusive: true },
        {
          type: 'shared',
          pattern: 'src/shared/*',
          capture: ['sliceName'],
          partialMatch: false,
          exclusive: true,
        },
        { type: 'shared-root', pattern: 'src/shared', partialMatch: false },
        {
          type: 'starter',
          pattern: ['src/components', 'src/constants', 'src/hooks'],
          partialMatch: false,
          exclusive: true,
        },
        {
          type: 'native-module',
          pattern: 'modules/*',
          capture: ['moduleName'],
          partialMatch: false,
          exclusive: true,
        },
      ],
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-alert': 'error',
      curly: ['error', 'multi-line'],
      'import/no-cycle': ['error', { maxDepth: 4, ignoreExternal: true }],
      'import/no-self-import': 'error',
      'import/no-useless-path-segments': ['error', { noUselessIndex: true }],
      'import/no-duplicates': 'error',
      'import/newline-after-import': 'error',
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index']],
          pathGroups: [
            { pattern: '@/shared/**', group: 'internal', position: 'before' },
            { pattern: '@/features/**', group: 'internal', position: 'before' },
            { pattern: '@/**', group: 'internal', position: 'after' },
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          checkInternals: true,
          message:
            'Architectural boundary violation: "{{from.element.types.[0]}}" cannot import "{{to.element.types.[0]}}" ({{to.file.path}}). Use public feature index exports or shared contracts.',
          policies: [
            {
              from: { element: { type: 'app' } },
              allow: {
                to: [
                  { element: { type: 'feature', fileInternalPath: 'index.{ts,tsx}' } },
                  {
                    element: {
                      type: [
                        'shared-domain',
                        'shared-firebase',
                        'shared-ui',
                        'shared',
                        'shared-root',
                        'starter',
                      ],
                    },
                  },
                ],
              },
            },
            {
              from: { element: { type: 'feature' } },
              allow: {
                to: [
                  {
                    element: {
                      type: 'feature',
                      captured: { featureName: '{{ from.element.captured.featureName }}' },
                    },
                  },
                  { element: { type: 'feature', fileInternalPath: 'index.{ts,tsx}' } },
                  {
                    element: {
                      type: [
                        'shared-domain',
                        'shared-firebase',
                        'shared-ui',
                        'shared',
                        'shared-root',
                        'starter',
                        'native-module',
                      ],
                    },
                  },
                ],
              },
            },
            {
              from: { element: { type: 'shared-domain' } },
              allow: {
                to: { element: { type: 'shared-domain' } },
              },
            },
            {
              from: { element: { type: 'shared-firebase' } },
              allow: {
                to: {
                  element: {
                    type: ['shared-domain', 'shared-firebase', 'shared', 'shared-root'],
                  },
                },
              },
            },
            {
              from: { element: { type: 'shared-ui' } },
              allow: {
                to: {
                  element: {
                    type: ['shared-domain', 'shared-ui', 'shared', 'shared-root', 'starter'],
                  },
                },
              },
            },
            {
              from: { element: { type: ['shared', 'shared-root'] } },
              allow: {
                to: {
                  element: {
                    type: [
                      'shared-domain',
                      'shared-firebase',
                      'shared-ui',
                      'shared',
                      'shared-root',
                      'starter',
                    ],
                  },
                },
              },
            },
            {
              from: { element: { type: 'starter' } },
              allow: {
                to: {
                  element: {
                    type: ['starter', 'shared-domain', 'shared-ui', 'shared', 'shared-root'],
                  },
                },
              },
            },
            {
              from: { element: { type: 'native-module' } },
              allow: {
                to: { element: { type: ['shared-domain', 'native-module'] } },
              },
            },
          ],
        },
      ],
    },
  },

  {
    files: ['src/**/*.web.{ts,tsx}', 'src/app/+html.tsx'],
    rules: {
      'no-restricted-imports': restrictedImports(
        BASE_RESTRICTIONS,
        IOS_ONLY_RESTRICTIONS,
        ANDROID_ONLY_RESTRICTIONS,
      ),
    },
  },
  {
    files: ['src/**/*.ios.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrictedImports(
        BASE_RESTRICTIONS,
        WEB_ONLY_RESTRICTIONS,
        ANDROID_ONLY_RESTRICTIONS,
      ),
    },
  },
  {
    files: ['src/**/*.android.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrictedImports(
        BASE_RESTRICTIONS,
        WEB_ONLY_RESTRICTIONS,
        IOS_ONLY_RESTRICTIONS,
      ),
    },
  },
  {
    files: ['src/**/*.native.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrictedImports(
        BASE_RESTRICTIONS,
        WEB_ONLY_RESTRICTIONS,
        IOS_ONLY_RESTRICTIONS,
        ANDROID_ONLY_RESTRICTIONS,
      ),
    },
  },
  {
    files: ['src/shared/domain/**/*.{ts,tsx}'],
    ignores: ['**/*.{web,ios,android,native}.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrictedImports(
        BASE_RESTRICTIONS,
        WEB_ONLY_RESTRICTIONS,
        IOS_ONLY_RESTRICTIONS,
        ANDROID_ONLY_RESTRICTIONS,
        FIREBASE_RESTRICTIONS,
        DOMAIN_RUNTIME_RESTRICTIONS,
      ),
    },
  },
  {
    files: ['src/app/**/*.{ts,tsx}'],
    ignores: ['src/app/+html.tsx', '**/*.{web,ios,android,native}.{ts,tsx}'],
    rules: {
      'no-restricted-imports': restrictedImports(
        BASE_RESTRICTIONS,
        WEB_ONLY_RESTRICTIONS,
        IOS_ONLY_RESTRICTIONS,
        ANDROID_ONLY_RESTRICTIONS,
        FIREBASE_RESTRICTIONS,
      ),
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/app/**/*.{ts,tsx}',
      'src/shared/domain/**/*.{ts,tsx}',
      '**/*.{web,ios,android,native}.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': restrictedImports(
        BASE_RESTRICTIONS,
        WEB_ONLY_RESTRICTIONS,
        IOS_ONLY_RESTRICTIONS,
        ANDROID_ONLY_RESTRICTIONS,
      ),
    },
  },

  {
    files: ['scripts/**/*.js', 'tests/**/*.{js,mjs}', '*.config.{js,cjs,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    plugins: {
      local: localPlugin,
    },
    rules: {
      'local/no-comments': 'error',
    },
  },

  eslintConfigPrettier,
]);
