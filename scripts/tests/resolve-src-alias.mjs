import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolvedSpecifier = specifier.startsWith('@/')
      ? new URL(`../../src/${specifier.slice(2)}.ts`, import.meta.url).href
      : specifier;
    return nextResolve(resolvedSpecifier, context);
  },
});
