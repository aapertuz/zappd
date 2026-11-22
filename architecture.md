# Architecture

## Application

- **Framework:** Expo + Expo Router with TypeScript; one application for web, iOS, and Android.
- **Shared code:** domain models, state, business logic, Firebase access, AI interfaces, and 3D interaction contracts.
- **Platform separation:** `.web.tsx`, `.ios.tsx`, and `.android.tsx` implementations where rendering differs.
- **Web UI:** React DOM, HTML, and CSS via Expo web/DOM components.
- **Native UI:** Expo UI with SwiftUI on iOS and Jetpack Compose on Android.
- **Native integration:** custom Expo modules expose native rendering views and commands to TypeScript; native development builds are required.

## Feature-Based Organization

- Organize application code by **feature/domain**, not by technical layer or platform.
- Each feature owns its screens, UI components, hooks/state, services, and tests; share code only when genuinely reused.
- Example feature boundaries: `projects/`, `assembly-explorer/`, `learning/`, and `offline/`; refine names as implementation evolves.
- Keep platform-specific implementations **inside the owning feature** (e.g., `Scene.web.tsx`, `Scene.ios.tsx`, `Scene.android.tsx`) behind shared interfaces.
- Reserve `shared/` for reusable domain contracts, design primitives, and infrastructure adapters; avoid feature-to-feature imports into internals.
- Expo Router route files remain thin entry points that delegate to features.

Example project tree (illustrative, not prescriptive):

```text
app/                                  # Thin Expo Router routes
  index.tsx
  projects/[projectId].tsx
features/
  projects/
    screens/ProjectScreen.tsx
    index.ts                           # Public feature API
  assembly-explorer/
    components/AssemblyScene.web.tsx
    components/AssemblyScene.ios.tsx
    components/AssemblyScene.android.tsx
    index.ts
  learning/
    components/
    index.ts
  offline/
    services/
    index.ts
shared/
  domain/                              # Common contracts and IDs
  firebase/                            # Shared Firebase adapters
  ui/                                  # Reusable design primitives
modules/
  realitykit-view/                     # Swift Expo module
  filament-view/                       # Kotlin Expo module
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
