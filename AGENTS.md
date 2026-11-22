## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
  GENTS.md

## Before Editing

- Read root product.md and architecture.md; they define product intent and technical decisions. Do not duplicate them here.
- Inspect the affected feature, its tests, existing patterns, and git status before changing code.
- Keep changes focused; preserve unrelated work and avoid introducing dependencies or architecture changes without a clear need.

## Architecture Boundaries

- Organize by feature. Keep routes thin and expose cross-feature functionality through public feature APIs.
- Keep web, iOS, and Android implementations behind shared typed contracts; platform-specific code stays in its owning feature.
- Treat Firestore's component hierarchy, stable IDs, relationships, and assembly steps as the domain model, never mesh names or a single 3D file.
- Treat source CAD as engineering truth; GLB/USDZ are derived render assets. Do not mistake successful rendering for validated engineering.
- Respect Phase 1's verified CAD assemblies; do not introduce custom CAD generation unless the task explicitly requires Phase 2.

## Enforce Rules, Don't Just Describe Them

- Prefer sound API design and types that make invalid states difficult to represent.
- Use strict TypeScript and explicit domain types; avoid any, unsafe casts, and unvalidated data at system boundaries.
- Enforce feature import boundaries and platform separation with lint rules; add targeted rules when recurring violations appear.
- Convert each repeated agent mistake into a better abstraction, lint rule, type constraint, or regression test before adding prose.
- Do not write comments in code (enforced by ESLint `local/no-comments`); if logic needs clarification, express intent through descriptive variable, function, type, and file names and clearer structure.
- Never bypass failing checks by disabling rules, weakening types, or deleting tests.

## Verify Behavior

- Add or update tests for changed behavior; every bug fix needs a regression test.
- Prioritize tests for component identity/relationships, assembly steps, asset manifests, offline cache/sync, and local AI-to-cloud fallback.
- Verify user-visible 3D interactions and platform-specific UI on affected targets; use screenshots or recordings when useful.
- Run the repository's lint, typecheck, and relevant test/build scripts before completion; add missing checks where warranted, never claim unrun checks passed.
- Validate local AI only where supported; offline behavior must degrade gracefully without assuming connectivity or model availability.
- Report what changed, verification performed, and any remaining failures or untested platforms.
- Before finishing any task, verify all changes (`pnpm run check` and any relevant target tests) and commit them in logical commits grouped by context following Conventional Commits (enforced by commitlint; non-conforming commits are rejected).
