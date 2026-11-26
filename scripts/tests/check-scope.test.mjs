import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { ESLint } = require('eslint');
const prettier = require('prettier');

test('checks exclude copied tools and generated CAD but retain owned source', async () => {
  const eslint = new ESLint();
  for (const file of [
    '.claude/skills/example/script.ts',
    '.agents/skills/arena/example.ts',
    'skills/arena/example.ts',
    'agent/skills/example.ts',
    'data/generated.ts',
    'public/assemblies/model.ts',
  ]) {
    assert.equal(await eslint.isPathIgnored(file), true, file);
    assert.equal(
      (await prettier.getFileInfo(file, { ignorePath: '.prettierignore' })).ignored,
      true,
      file,
    );
  }
  for (const file of [
    'src/app/index.tsx',
    'backend/orchestrator/index.ts',
    'scripts/tests/check-scope.test.mjs',
    'modules/realitykit-view/index.ts',
    'app.json',
    '.agents/skills/verify-zappd/scripts/zappd-verify.mjs',
  ]) {
    assert.equal(
      (await prettier.getFileInfo(file, { ignorePath: '.prettierignore' })).ignored,
      false,
      file,
    );
    if (/\.(ts|tsx|mjs)$/.test(file)) assert.equal(await eslint.isPathIgnored(file), false, file);
  }
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  assert.ok(packageJson.scripts['test:lint'].includes('scripts/tests/*.test.mjs'));
});
