# Architecture

## Application

- **Framework:** Expo + Expo Router with TypeScript; one application for web, iOS, and Android.
- **Shared code:** domain models, state, business logic, Firebase access, AI interfaces, and 3D interaction contracts.
- **Web UI:** React DOM, HTML, and CSS via Expo web/DOM components in `.web.tsx` when web needs a dedicated interface.
- **Native UI:** universal `@expo/ui` by default across iOS and Android, with `@expo/ui/swift-ui` (`.ios.tsx`) and `@expo/ui/jetpack-compose` (`.android.tsx`) available when a component needs OS-specific controls not covered by universal `@expo/ui`.
- **Native integration:** custom Expo modules expose native 3D rendering views and platform-specific SDK capabilities to TypeScript; native development builds are required.

### Platform File Escalation

| Tier                         | Files                                             | When to use                                                                                                                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tier 1 (default)             | `Foo.ts` / `Foo.tsx`                              | Domain logic, state, hooks, thin `src/app/` routes, and UI whose layout and controls match across web, iOS, and Android (including minor differences via `Platform.select` or `Icon.select`).                                                                                        |
| Tier 2 (web + shared native) | `Foo.web.tsx` + `Foo.tsx` (or `Foo.native.tsx`)   | Web differs from mobile while iOS and Android share behavior: desktop pointer/hover/keyboard shortcuts or wide CSS layouts vs touch/bottom-sheet UX, browser DOM/IndexedDB/Cache API vs `expo-file-system` and universal `@expo/ui`, or distinct desktop web navigation chrome.      |
| Tier 3 (per platform)        | `Foo.web.tsx` + `Foo.ios.tsx` + `Foo.android.tsx` | iOS and Android themselves diverge: 3D rendering engines (`Three.js` vs `RealityKit` vs `Filament`), distinct native SDKs/runtimes (browser Prompt API vs Apple Foundation Models vs Android ML Kit Gemini Nano), or OS-exclusive native controls missing from universal `@expo/ui`. |

- **Start at Tier 1 and escalate only when needed:** stay in one shared file until web diverges (Tier 2), and split iOS from Android (Tier 3) only when iOS and Android themselves require different engines, native SDKs, or OS-exclusive controls.
- **Keep Tier 3 splits narrow:** isolate OS-specific SwiftUI controls (`GlassEffectContainer`, `Toolbar`, `ContextMenu`, `Popover`), Jetpack Compose controls (`HorizontalFloatingToolbar`, `FloatingActionButton`, `DropdownMenu`, `FilledIconButton`, `Snackbar`), and 3D bindings to the smallest leaf component behind a shared typed props contract. Every `.ios`/`.android` file must have a matching sibling for the other native platform or a `.native`/base fallback (enforced by ESLint).
- **Isolate platform imports by suffix:** keep `@expo/ui/swift-ui` and `realitykit-view` in `.ios`, `@expo/ui/jetpack-compose` and `filament-view` in `.android`, SwiftUI/Compose modifiers in `.ios`/`.android`/`.native`, and React DOM/Three.js/CSS Modules in `.web` (enforced by ESLint).
- **Keep `src/app/` routes universal and ask when ambiguous:** never place a platform-suffixed file in `src/app/` without a matching non-suffixed base route file (prefer splitting inside `src/features/` or `src/shared/`). Evaluate Tier 1 vs Tier 2 vs Tier 3 per component and ask when the right split is unclear.

## Feature-Based Organization

- Use `src/` as the application source root. Organize application code by **feature/domain**.
- Each feature owns its screens, UI components, hooks/state, services, and tests; share code only when genuinely reused.
- Example feature boundaries: `canvas/`, `projects/`, `assembly-explorer/`, `learning/`, and `offline/`; refine names as implementation evolves.
- Keep platform-specific implementations **inside the owning feature** behind shared typed interfaces following the three-tier escalation model: default to one shared file (Tier 1), add `.web.tsx` alongside a shared native file when web diverges (Tier 2, such as `canvas/components/CanvasView.tsx` and `CanvasView.web.tsx`), and isolate `.ios.tsx`/`.android.tsx` splits to the smallest leaf when iOS and Android themselves diverge (Tier 3, such as `assembly-explorer/renderer/AssemblyScene.{web,ios,android}.tsx` or an OS-specific native control in a feature or `shared/ui/`).
- Reserve `shared/` for reusable domain contracts, design primitives, and infrastructure adapters; avoid feature-to-feature imports into internals.
- Reserve `src/app/` for Expo Router routes and layouts. Keep route files as thin entry points that delegate to features.

Example project tree (illustrative, not prescriptive):

```text
src/
  app/                                  # Expo Router routes and layouts
    _layout.tsx
    index.tsx
    projects/[projectId].tsx
  features/
    canvas/
      components/CanvasView.tsx          # Shared iOS and Android UI (@expo/ui)
      components/CanvasView.web.tsx      # Web-optimal UI (React DOM and CSS)
      screens/CanvasScreen.tsx
      index.ts                           # Public feature API
    projects/
      screens/ProjectScreen.tsx
      index.ts
    assembly-explorer/
      renderer/AssemblyScene.web.tsx     # Three.js / React Three Fiber
      renderer/AssemblyScene.ios.tsx     # RealityKit binding
      renderer/AssemblyScene.android.tsx # Filament binding
      index.ts
    learning/
      components/
      index.ts
    offline/
      services/
      index.ts
  shared/
    domain/                             # Common contracts and IDs
    firebase/                           # Shared Firebase adapters
    ui/                                 # Reusable design primitives and isolated OS-specific leaf controls
modules/
  realitykit-view/                    # Swift Expo module
  filament-view/                      # Kotlin Expo module
```

## 3D Rendering

| Platform | Engine                         | Delivery format |
| -------- | ------------------------------ | --------------- |
| Web      | Three.js + React Three Fiber   | GLB             |
| iOS      | RealityKit (Swift Expo module) | USDZ            |
| Android  | Filament (Kotlin Expo module)  | GLB             |

- All renderers implement the same interactions: orbit/rotate, zoom, select component, isolate, assemble/disassemble, and exploded view.
- Shared assembly IDs, part transforms, and relationships drive every renderer; platform implementations handle input and presentation.
- 3D assets are _outputs_ of the CAD pipeline, not the source of engineering truth.

## Domain and Data

- **Firestore** is the primary database for project structures, specifications, relationships, explanations, and assembly steps.
- Hierarchy: `Project → Subsystem → Component → Subcomponent` (recursive as needed).
- Each node has a stable ID, parent reference, specifications, and references to its associated geometry/assets.
- Relationships explicitly record **which parts connect**, **how they connect**, and **why**; references use stable node IDs.
- Assembly instructions are ordered steps referencing the precise components and relationships involved.
- The hierarchy and connection data are independent of model file formats and renderers.

## CAD and Asset Pipeline

- **Geometry authoring:** build123d on top of OpenCascade, executed on a backend.
- Preserve original parametric/CAD definitions and use **STEP** for precise engineering geometry interchange.
- Export or convert geometry into **GLB** for web/Android and **USDZ** for iOS; preserve part boundaries and stable IDs for selection.
- **Firebase Storage** holds source CAD artifacts, STEP files, generated render assets, and versioned asset manifests.
- Firestore holds metadata, asset references, hierarchy, and assembly data; Storage holds binary files.
- **Phase 1:** import existing verified CAD assemblies and normalize their hierarchy and assets.
- **Phase 2:** allow custom AI planned CAD generation and validation through backend workflows.
- CAD validation must be explicit; successful geometry export does not imply mechanical correctness.

## AI

- **Firebase AI Logic:** on-device inference for **text explanations and questions only**, using the selected part and verified project metadata as context.
- **Cloud inference:** fallback when local inference is unavailable or insufficient and connectivity exists.
- Device/platform support and model capabilities are checked at runtime; never assume local inference is available everywhere.
- CAD planning, generation, and validation belong to separate backend workflows, not the on-device text model.
- Backend agent framework and model choices remain undecided.

## Offline and Synchronization

- Enable **Firestore offline persistence** where supported for project metadata, relationships, explanations, and steps.
- Explicitly download/cache GLB or USDZ assets and manifests; Firebase Storage URLs alone are not an offline strategy.
- The offline experience uses cached project data and models for full 3D inspection and assembly navigation.
- Local explanations and Q&A work offline **only on supported devices with an available on-device model**; otherwise show cached explanations without claiming live AI.
- Sync updated project data and asset versions when online; define cache eviction and download status in the implementation.
- Cloud fallback and newly generated CAD require connectivity.

## Cross-Cutting Rules

- Keep geometry, assembly semantics, explanations, and renderer state separate.
- Enforce feature boundaries; cross-feature communication uses public exports and shared contracts, not internal file imports.
- Resolve user selections by component ID; never infer component identity from mesh names alone.
- Treat source CAD and verified specifications as authoritative; AI-generated prose is not engineering validation.
- Unselected infrastructure details (backend runtime, queues, validation services, and AI orchestration) remain open decisions.
