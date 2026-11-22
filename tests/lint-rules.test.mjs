import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ESLint } = require('eslint');
const projectConfig = require('../eslint.config.js');

let tmpDir;
let eslint;

const FIXTURE_FILES = {
  'package.json': JSON.stringify({ name: 'zappd-lint-fixture', private: true }),
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ESNext',
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      paths: {
        '@/*': ['./src/*'],
      },
    },
    include: ['**/*.ts', '**/*.tsx'],
  }),
  'src/app/index.tsx': 'export default function IndexScreen() { return null; }\n',
  'src/app/other.tsx': 'export default function OtherScreen() { return null; }\n',
  'src/features/projects/index.ts': 'export const projectName = "demo";\n',
  'src/features/projects/internal.ts': 'export const internalSecret = 1;\n',
  'src/features/learning/index.ts': 'export const learningName = "lesson";\n',
  'src/features/learning/internal.ts': 'export const lessonHelper = 2;\n',
  'src/shared/domain/part.ts': 'export type PartId = string;\n',
  'src/shared/firebase/client.ts': 'export const db = {};\n',
  'src/shared/ui/Button.tsx': 'export function Button() { return null; }\n',
  'src/components/Scene.tsx': 'export function Scene() { return null; }\n',
  'src/components/Scene.web.tsx': 'export function Scene() { return null; }\n',
  'src/components/Scene.ios.tsx': 'export function Scene() { return null; }\n',
  'src/components/Scene.android.tsx': 'export function Scene() { return null; }\n',
  'src/components/Scene.native.tsx': 'export function Scene() { return null; }\n',
  'src/components/widget.module.css': '.box { color: red; }\n',
  'src/features/assembly-explorer/Scene.ios.tsx': 'export function Scene() { return null; }\n',
  'src/features/assembly-explorer/Scene.android.tsx': 'export function Scene() { return null; }\n',
  'src/features/assembly-explorer/renderer/AssemblyScene.ios.tsx':
    'export function AssemblyScene() { return null; }\n',
  'src/features/assembly-explorer/renderer/AssemblyScene.android.tsx':
    'export function AssemblyScene() { return null; }\n',
  'src/components/Orphan.ios.tsx': 'export function Orphan() { return null; }\n',
  'src/components/OrphanAndroid.android.tsx': 'export function OrphanAndroid() { return null; }\n',
  'src/components/NativeFallback.ios.tsx': 'export function NativeFallback() { return null; }\n',
  'src/components/NativeFallback.native.tsx': 'export function NativeFallback() { return null; }\n',
  'src/components/BaseFallback.android.tsx': 'export function BaseFallback() { return null; }\n',
  'src/components/BaseFallback.tsx': 'export function BaseFallback() { return null; }\n',
  'src/app/only-web.web.tsx': 'export default function OnlyWeb() { return null; }\n',
  'src/app/index.web.tsx': 'export default function IndexWeb() { return null; }\n',
  'src/app/+html.tsx': 'export default function Html() { return null; }\n',
  'modules/realitykit-view/index.ts': 'export const RealityKitView = {};\n',
  'modules/filament-view/index.ts': 'export const FilamentView = {};\n',
  'node_modules/react/index.d.ts': 'export {};\n',
  'node_modules/react-native/index.d.ts': 'export const Platform = { OS: "ios" };\n',
  'node_modules/react-dom/index.d.ts': 'export function createPortal() {}\n',
  'node_modules/three/index.d.ts': 'export class Scene {}\n',
  'node_modules/@expo/ui/index.d.ts': 'export const Host = {};\n',
  'node_modules/@expo/ui/swift-ui/index.d.ts': 'export const Host = {};\n',
  'node_modules/@expo/ui/swift-ui/modifiers/index.d.ts': 'export const padding = () => ({});\n',
  'node_modules/@expo/ui/jetpack-compose/index.d.ts': 'export const Host = {};\n',
  'node_modules/@expo/ui/jetpack-compose/modifiers/index.d.ts':
    'export const padding = () => ({});\n',
  'node_modules/realitykit-view/index.d.ts': 'export const RealityKitView = {};\n',
  'node_modules/filament-view/index.d.ts': 'export const FilamentView = {};\n',
  'node_modules/@react-navigation/native/index.d.ts': 'export const useNavigation = () => ({});\n',
  'node_modules/expo-router/index.d.ts': 'export const Link = () => null;\n',
  'node_modules/firebase/firestore/index.d.ts': 'export const getFirestore = () => ({});\n',
};

async function writeFixtureFiles(rootDir, files) {
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(rootDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf8');
  }
}

async function lintFixture(relPath, code) {
  const filePath = path.join(tmpDir, relPath);
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages;
}

function assertHasRule(messages, ruleId) {
  const match = messages.find((msg) => msg.ruleId === ruleId);
  assert.ok(
    match,
    `Expected rule "${ruleId}" to trigger, got: ${JSON.stringify(
      messages.map((m) => ({ ruleId: m.ruleId, message: m.message })),
    )}`,
  );
}

function assertNoRule(messages, ruleId) {
  const matches = messages.filter((msg) => msg.ruleId === ruleId);
  assert.equal(
    matches.length,
    0,
    `Expected no "${ruleId}" violations, got: ${JSON.stringify(
      matches.map((m) => ({ ruleId: m.ruleId, message: m.message })),
    )}`,
  );
}

describe('zappd lint rules', () => {
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zappd-lint-test-'));
    await writeFixtureFiles(tmpDir, FIXTURE_FILES);

    eslint = new ESLint({
      cwd: tmpDir,
      overrideConfigFile: true,
      overrideConfig: [
        ...projectConfig,
        {
          files: ['**/*.ts', '**/*.tsx'],
          ignores: ['**/*.d.ts'],
          languageOptions: {
            parserOptions: {
              projectService: true,
              tsconfigRootDir: tmpDir,
            },
          },
        },
        {
          files: ['src/**/*.{js,jsx,ts,tsx}', 'modules/**/*.{js,jsx,ts,tsx}'],
          settings: {
            react: { version: '19.3.0' },
            'boundaries/root-path': tmpDir,
            'import/resolver': {
              typescript: {
                alwaysTryTypes: true,
                project: path.join(tmpDir, 'tsconfig.json'),
              },
              node: {
                extensions: [
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
                  '.js',
                  '.jsx',
                  '.json',
                ],
              },
            },
          },
        },
      ],
    });
  });

  after(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe('boundaries/dependencies', () => {
    it('allows app to import public feature index and blocks feature internals or other routes', async () => {
      const allowed = await lintFixture(
        'src/app/index.tsx',
        "import { projectName } from '@/features/projects';\nexport default function Screen() { return projectName; }\n",
      );
      assertNoRule(allowed, 'boundaries/dependencies');

      const blockedInternal = await lintFixture(
        'src/app/index.tsx',
        "import { internalSecret } from '@/features/projects/internal';\nexport default function Screen() { return internalSecret; }\n",
      );
      assertHasRule(blockedInternal, 'boundaries/dependencies');

      const blockedRoute = await lintFixture(
        'src/app/index.tsx',
        "import OtherScreen from './other';\nexport default OtherScreen;\n",
      );
      assertHasRule(blockedRoute, 'boundaries/dependencies');
    });

    it('allows same-feature internals and cross-feature index, blocks cross-feature internals and app', async () => {
      const allowedBarrel = await lintFixture(
        'src/features/learning/index.ts',
        "import { projectName } from '@/features/projects';\nexport const label = projectName;\n",
      );
      assertNoRule(allowedBarrel, 'boundaries/dependencies');

      const allowedOwnInternal = await lintFixture(
        'src/features/learning/index.ts',
        "import { lessonHelper } from './internal';\nexport const count = lessonHelper;\n",
      );
      assertNoRule(allowedOwnInternal, 'boundaries/dependencies');

      const blockedCrossInternal = await lintFixture(
        'src/features/learning/index.ts',
        "import { internalSecret } from '@/features/projects/internal';\nexport const leak = internalSecret;\n",
      );
      assertHasRule(blockedCrossInternal, 'boundaries/dependencies');

      const blockedApp = await lintFixture(
        'src/features/learning/index.ts',
        "import Screen from '@/app/index';\nexport const bad = Screen;\n",
      );
      assertHasRule(blockedApp, 'boundaries/dependencies');
    });

    it('enforces shared/ui and shared/domain isolation', async () => {
      const uiAllowedDomain = await lintFixture(
        'src/shared/ui/Button.tsx',
        "import type { PartId } from '@/shared/domain/part';\nexport const id: PartId = 'p1';\n",
      );
      assertNoRule(uiAllowedDomain, 'boundaries/dependencies');

      const uiBlockedFeature = await lintFixture(
        'src/shared/ui/Button.tsx',
        "import { projectName } from '@/features/projects';\nexport const x = projectName;\n",
      );
      assertHasRule(uiBlockedFeature, 'boundaries/dependencies');

      const uiBlockedFirebase = await lintFixture(
        'src/shared/ui/Button.tsx',
        "import { db } from '@/shared/firebase/client';\nexport const x = db;\n",
      );
      assertHasRule(uiBlockedFirebase, 'boundaries/dependencies');

      const domainBlockedUi = await lintFixture(
        'src/shared/domain/part.ts',
        "import { Button } from '@/shared/ui/Button';\nexport const x = Button;\n",
      );
      assertHasRule(domainBlockedUi, 'boundaries/dependencies');

      const domainBlockedFirebase = await lintFixture(
        'src/shared/domain/part.ts',
        "import { db } from '@/shared/firebase/client';\nexport const x = db;\n",
      );
      assertHasRule(domainBlockedFirebase, 'boundaries/dependencies');
    });
  });

  describe('no-restricted-imports (platform & layer separation)', () => {
    it('blocks direct imports of platform-suffixed files and @react-navigation/*', async () => {
      for (const suffix of ['web', 'ios', 'android', 'native']) {
        const res = await lintFixture(
          'src/features/projects/index.ts',
          `import { Scene } from '@/components/Scene.${suffix}';\nexport const x = Scene;\n`,
        );
        assertHasRule(res, 'no-restricted-imports');
      }

      const navRes = await lintFixture(
        'src/features/projects/index.ts',
        "import { useNavigation } from '@react-navigation/native';\nexport const x = useNavigation;\n",
      );
      assertHasRule(navRes, 'no-restricted-imports');
    });

    it('allows universal @expo/ui in shared native files and blocks it in web and domain files', async () => {
      for (const filePath of [
        'src/features/projects/index.ts',
        'src/components/Scene.tsx',
        'src/components/Scene.native.tsx',
      ]) {
        const res = await lintFixture(
          filePath,
          "import { Host } from '@expo/ui';\nexport const x = Host;\n",
        );
        assertNoRule(res, 'no-restricted-imports');
      }

      for (const filePath of ['src/components/Scene.web.tsx', 'src/shared/domain/part.ts']) {
        const res = await lintFixture(
          filePath,
          "import { Host } from '@expo/ui';\nexport const x = Host;\n",
        );
        assertHasRule(res, 'no-restricted-imports');
      }
    });

    it('allows @expo/ui/swift-ui and @expo/ui/swift-ui/modifiers in *.ios.tsx and blocks them in *.web.tsx, *.android.tsx, and plain *.tsx', async () => {
      for (const filePath of [
        'src/components/Scene.ios.tsx',
        'src/features/assembly-explorer/renderer/AssemblyScene.ios.tsx',
      ]) {
        const res = await lintFixture(
          filePath,
          "import { Host } from '@expo/ui/swift-ui';\nimport { padding } from '@expo/ui/swift-ui/modifiers';\nexport const x = [Host, padding];\n",
        );
        assertNoRule(res, 'no-restricted-imports');
      }

      for (const filePath of [
        'src/components/Scene.web.tsx',
        'src/components/Scene.android.tsx',
        'src/components/Scene.tsx',
        'src/features/projects/index.ts',
        'src/app/index.tsx',
        'src/shared/domain/part.ts',
      ]) {
        for (const pkg of ['@expo/ui/swift-ui', '@expo/ui/swift-ui/modifiers']) {
          const res = await lintFixture(
            filePath,
            `import * as Pkg from '${pkg}';\nexport const x = Pkg;\n`,
          );
          assertHasRule(res, 'no-restricted-imports');
        }
      }
    });

    it('allows @expo/ui/jetpack-compose and @expo/ui/jetpack-compose/modifiers in *.android.tsx and blocks them in *.web.tsx, *.ios.tsx, and plain *.tsx', async () => {
      for (const filePath of [
        'src/components/Scene.android.tsx',
        'src/features/assembly-explorer/renderer/AssemblyScene.android.tsx',
      ]) {
        const res = await lintFixture(
          filePath,
          "import { Host } from '@expo/ui/jetpack-compose';\nimport { padding } from '@expo/ui/jetpack-compose/modifiers';\nexport const x = [Host, padding];\n",
        );
        assertNoRule(res, 'no-restricted-imports');
      }

      for (const filePath of [
        'src/components/Scene.web.tsx',
        'src/components/Scene.ios.tsx',
        'src/components/Scene.tsx',
        'src/features/projects/index.ts',
        'src/app/index.tsx',
        'src/shared/domain/part.ts',
      ]) {
        for (const pkg of ['@expo/ui/jetpack-compose', '@expo/ui/jetpack-compose/modifiers']) {
          const res = await lintFixture(
            filePath,
            `import * as Pkg from '${pkg}';\nexport const x = Pkg;\n`,
          );
          assertHasRule(res, 'no-restricted-imports');
        }
      }
    });

    it('allows universal @expo/ui and platform modifiers in *.native.tsx while blocking single-OS components, 3D bindings, and web libraries', async () => {
      const allowedNative = await lintFixture(
        'src/components/Scene.native.tsx',
        "import { Host } from '@expo/ui';\nimport { padding as iosPadding } from '@expo/ui/swift-ui/modifiers';\nimport { padding as androidPadding } from '@expo/ui/jetpack-compose/modifiers';\nexport const x = [Host, iosPadding, androidPadding];\n",
      );
      assertNoRule(allowedNative, 'no-restricted-imports');

      for (const pkg of [
        '@expo/ui/swift-ui',
        '@expo/ui/jetpack-compose',
        'realitykit-view',
        'filament-view',
        'react-dom',
        'three',
      ]) {
        const res = await lintFixture(
          'src/components/Scene.native.tsx',
          `import * as Pkg from '${pkg}';\nexport const x = Pkg;\n`,
        );
        assertHasRule(res, 'no-restricted-imports');
      }
    });

    it('blocks web libraries in non-web files and allows them in *.web.tsx', async () => {
      const allowedWeb = await lintFixture(
        'src/components/Scene.web.tsx',
        "import { createPortal } from 'react-dom';\nimport { Scene as ThreeScene } from 'three';\nexport const x = [createPortal, ThreeScene];\n",
      );
      assertNoRule(allowedWeb, 'no-restricted-imports');

      const nonWebFiles = [
        'src/features/projects/index.ts',
        'src/components/Scene.native.tsx',
        'src/components/Scene.ios.tsx',
        'src/components/Scene.android.tsx',
      ];
      for (const filePath of nonWebFiles) {
        for (const pkg of ['three', 'react-dom']) {
          const res = await lintFixture(
            filePath,
            `import * as Pkg from '${pkg}';\nexport const x = Pkg;\n`,
          );
          assertHasRule(res, 'no-restricted-imports');
        }
      }
    });

    it('restricts realitykit-view to *.ios.{ts,tsx} and filament-view to *.android.{ts,tsx}', async () => {
      const allowedIosPkg = await lintFixture(
        'src/features/assembly-explorer/renderer/AssemblyScene.ios.tsx',
        "import { RealityKitView } from 'realitykit-view';\nexport const x = RealityKitView;\n",
      );
      assertNoRule(allowedIosPkg, 'no-restricted-imports');

      const allowedIosLocal = await lintFixture(
        'src/components/Scene.ios.tsx',
        "import { RealityKitView } from '../../modules/realitykit-view';\nexport const x = RealityKitView;\n",
      );
      assertNoRule(allowedIosLocal, 'no-restricted-imports');

      const allowedAndroidPkg = await lintFixture(
        'src/features/assembly-explorer/renderer/AssemblyScene.android.tsx',
        "import { FilamentView } from 'filament-view';\nexport const x = FilamentView;\n",
      );
      assertNoRule(allowedAndroidPkg, 'no-restricted-imports');

      const allowedAndroidLocal = await lintFixture(
        'src/components/Scene.android.tsx',
        "import { FilamentView } from '../../modules/filament-view';\nexport const x = FilamentView;\n",
      );
      assertNoRule(allowedAndroidLocal, 'no-restricted-imports');

      for (const filePath of [
        'src/features/assembly-explorer/renderer/AssemblyScene.android.tsx',
        'src/components/Scene.android.tsx',
        'src/components/Scene.web.tsx',
        'src/components/Scene.native.tsx',
        'src/components/Scene.tsx',
      ]) {
        const res = await lintFixture(
          filePath,
          "import { RealityKitView } from 'realitykit-view';\nexport const x = RealityKitView;\n",
        );
        assertHasRule(res, 'no-restricted-imports');
      }

      for (const filePath of [
        'src/features/assembly-explorer/renderer/AssemblyScene.ios.tsx',
        'src/components/Scene.ios.tsx',
        'src/components/Scene.web.tsx',
        'src/components/Scene.native.tsx',
        'src/components/Scene.tsx',
      ]) {
        const res = await lintFixture(
          filePath,
          "import { FilamentView } from 'filament-view';\nexport const x = FilamentView;\n",
        );
        assertHasRule(res, 'no-restricted-imports');
      }
    });

    it('keeps shared/domain pure and blocks Firebase in routes and domain', async () => {
      for (const pkg of ['react-native', 'expo-router', 'firebase/firestore']) {
        const res = await lintFixture(
          'src/shared/domain/part.ts',
          `import * as Pkg from '${pkg}';\nexport const x = Pkg;\n`,
        );
        assertHasRule(res, 'no-restricted-imports');
      }

      const routeFirebase = await lintFixture(
        'src/app/index.tsx',
        "import { getFirestore } from 'firebase/firestore';\nexport const x = getFirestore;\n",
      );
      assertHasRule(routeFirebase, 'no-restricted-imports');
    });
  });

  describe('local/paired-native-platform-split', () => {
    it('blocks unpaired .ios.tsx and .android.tsx files without a matching sibling or fallback', async () => {
      const orphanIos = await lintFixture(
        'src/components/Orphan.ios.tsx',
        'export function Orphan() { return null; }\n',
      );
      assertHasRule(orphanIos, 'local/paired-native-platform-split');

      const orphanAndroid = await lintFixture(
        'src/components/OrphanAndroid.android.tsx',
        'export function OrphanAndroid() { return null; }\n',
      );
      assertHasRule(orphanAndroid, 'local/paired-native-platform-split');
    });

    it('allows .ios.tsx and .android.tsx files paired with the other OS, .native, or base file', async () => {
      const pairedIos = await lintFixture(
        'src/features/assembly-explorer/renderer/AssemblyScene.ios.tsx',
        'export function AssemblyScene() { return null; }\n',
      );
      assertNoRule(pairedIos, 'local/paired-native-platform-split');

      const pairedAndroid = await lintFixture(
        'src/features/assembly-explorer/renderer/AssemblyScene.android.tsx',
        'export function AssemblyScene() { return null; }\n',
      );
      assertNoRule(pairedAndroid, 'local/paired-native-platform-split');

      const sceneIos = await lintFixture(
        'src/components/Scene.ios.tsx',
        'export function Scene() { return null; }\n',
      );
      assertNoRule(sceneIos, 'local/paired-native-platform-split');

      const nativeFallbackIos = await lintFixture(
        'src/components/NativeFallback.ios.tsx',
        'export function NativeFallback() { return null; }\n',
      );
      assertNoRule(nativeFallbackIos, 'local/paired-native-platform-split');

      const baseFallbackAndroid = await lintFixture(
        'src/components/BaseFallback.android.tsx',
        'export function BaseFallback() { return null; }\n',
      );
      assertNoRule(baseFallbackAndroid, 'local/paired-native-platform-split');
    });
  });

  describe('local/no-platform-only-route', () => {
    it('blocks platform-suffixed routes in src/app/ without a matching base route file', async () => {
      const orphanWebRoute = await lintFixture(
        'src/app/only-web.web.tsx',
        'export default function OnlyWeb() { return null; }\n',
      );
      assertHasRule(orphanWebRoute, 'local/no-platform-only-route');
    });

    it('allows platform-suffixed routes with a base route file and +html.tsx', async () => {
      const pairedWebRoute = await lintFixture(
        'src/app/index.web.tsx',
        'export default function IndexWeb() { return null; }\n',
      );
      assertNoRule(pairedWebRoute, 'local/no-platform-only-route');

      const htmlRoute = await lintFixture(
        'src/app/+html.tsx',
        'export default function Html() { return null; }\n',
      );
      assertNoRule(htmlRoute, 'local/no-platform-only-route');
    });
  });

  describe('strict TypeScript ESLint rules', () => {
    it('blocks explicit any and @ts-ignore comments', async () => {
      const anyRes = await lintFixture(
        'src/shared/domain/part.ts',
        'export const badValue: any = 123;\n',
      );
      assertHasRule(anyRes, '@typescript-eslint/no-explicit-any');

      const tsIgnoreRes = await lintFixture(
        'src/shared/domain/part.ts',
        '// @ts-ignore\nexport const ignoredValue = 123;\n',
      );
      assertHasRule(tsIgnoreRes, '@typescript-eslint/ban-ts-comment');
    });
  });

  describe('local/no-comments', () => {
    it('blocks line, block, JSDoc, and JSX comments', async () => {
      const lineComment = await lintFixture(
        'src/shared/domain/part.ts',
        '// explanatory note\nexport const count = 1;\n',
      );
      assertHasRule(lineComment, 'local/no-comments');

      const blockComment = await lintFixture(
        'src/shared/domain/part.ts',
        '/* block note */\nexport const count = 1;\n',
      );
      assertHasRule(blockComment, 'local/no-comments');

      const jsdocComment = await lintFixture(
        'src/shared/domain/part.ts',
        '/** jsdoc note */\nexport const count = 1;\n',
      );
      assertHasRule(jsdocComment, 'local/no-comments');

      const jsxComment = await lintFixture(
        'src/shared/ui/Button.tsx',
        'export function Button() {\n  return <>\n    {/* jsx note */}\n  </>;\n}\n',
      );
      assertHasRule(jsxComment, 'local/no-comments');
    });

    it('allows triple-slash directives only in declaration files', async () => {
      const dtsDirective = await lintFixture(
        'src/types/env.d.ts',
        '/// <reference types="expo/types" />\n',
      );
      assertNoRule(dtsDirective, 'local/no-comments');

      const tsDirective = await lintFixture(
        'src/shared/domain/part.ts',
        '/// <reference types="expo/types" />\nexport const count = 1;\n',
      );
      assertHasRule(tsDirective, 'local/no-comments');
    });
  });
});
