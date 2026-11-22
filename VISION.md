# Robotics Learning Platform: Product Vision

## Vision
Make robotics understandable through direct interaction. People should be able to see how a machine works, examine its individual parts, and learn how to build it within one interactive learning experience.

## Problem
Learning to build robotics projects often means switching between videos, diagrams, manuals, and parts lists. These resources rarely show how every component fits into the complete system or why it is needed. Seeing a finished machine is not the same as understanding it.

## Who It Serves
Curious learners, students, makers, educators, and aspiring builders who want to understand robotics through practical visual learning, regardless of their starting experience.

## Core Experience
The experience centers on an interactive canvas containing a detailed 3D model of a robotics project.

1. **Start with an intention.** A learner describes what they want to understand or build, such as a camera drone, or chooses an available project. In the current phase, the platform matches their intention to an existing verified assembly.
2. **Interact directly with the object.** Rotate it by dragging or touching, zoom in or out, and inspect it from different angles. The object itself is the primary interface.
3. **See the whole or the parts.** Switch between the assembled artifact and a separated view that reveals its components and how they fit together.
4. **Go deeper into any component.** Select a piece to focus on its own manipulable 3D model. Where the source material supports it, examine that component's internal pieces as well.
5. **Understand what and why.** Learn each part's name, purpose, operating principle, relationship to other parts, and reason for being included in this specific project.
6. **Learn how to build it.** Follow an ordered assembly guide connected to the relevant pieces and their placement in the complete object.
7. **Ask questions in context.** Get explanations about the selected part, the overall machine, or a particular assembly step without losing the visual context.

## Product Phases

### Phase 1: Verified Assemblies (Current Focus)
Learners interact with existing, verified CAD assemblies of robotics projects. The platform presents the complete artifact, its constituent parts, their relationships, and grounded explanations and build guidance wherever reliable source information is available.

A open ended request helps the learner find an appropriate supported project; it does not imply that the platform creates arbitrary new mechanical designs in this phase. The priority is a coherent, accurate learning experience built around trustworthy reference assemblies.

### Phase 2: Custom Projects (Future)
Learners describe a robotics project and its requirements, then generate a customized 3D design with its parts, relationships, explanations, and assembly sequence. They can modify requirements and examine how the design changes.

Generated designs must be distinguished from verified reference assemblies. Physical compatibility, feasibility, and safe construction require validation rather than assumption.

## Product Principles

- **Learning through interaction.** Manipulating an object should reveal how it works, not merely change its appearance.
- **Whole to part to whole.** Learners can move between the complete artifact, individual components, and deeper mechanisms while retaining context.
- **Accuracy over spectacle.** Prefer verified geometry, specifications, and relationships to visually convincing but unsupported details.
- **Explain the why.** Every component and assembly step should connect to the function of the larger system.
- **Depth on demand.** Keep the canvas approachable while allowing curious learners to inspect increasing levels of detail.
- **Honest guidance.** Clearly distinguish verified information from explanations, estimates, or suggestions that need further checking.

## Product Boundaries
The platform is a learning experience, not a replacement for engineering validation or professional CAD authoring. In Phase 1, it does not promise generation of unrestricted custom designs. Assembly guidance should not imply that a real build is safe or feasible unless the relevant constraints have been verified.

## Success Looks Like
A learner can start with a robotics project, understand what it does, manipulate the complete model, identify and inspect its parts, explain why those parts matter, and follow how they come together without needing to piece together disconnected learning resources.
