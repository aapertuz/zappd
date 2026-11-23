import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname } from 'node:path';

const repoRoot = new URL('../../', import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const relative = specifier.slice(2);
      const base = new URL(
        relative.startsWith('backend/') ? relative : `src/${relative}`,
        repoRoot,
      );
      for (const candidate of [new URL(`${base.href}.ts`), new URL(`${base.href}/index.ts`)]) {
        if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
      }
    }

    if (
      context.parentURL?.startsWith(repoRoot.href) &&
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      extname(specifier) === ''
    ) {
      const base = new URL(specifier, context.parentURL).href.replace(/\/$/, '');
      for (const candidate of [new URL(`${base}.ts`), new URL(`${base}/index.ts`)]) {
        if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
