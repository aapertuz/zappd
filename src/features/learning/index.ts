export { LearningCallouts } from './components/LearningCallouts';
export {
  type LearningCalloutsHandle,
  type LearningCalloutsProps,
  type LearningCalloutsRenderedRects,
} from './components/calloutPresentation';
export {
  useComponentLearning,
  type LearningQuestionSubmission,
} from './hooks/useComponentLearning';
export { useTypewriterText } from './hooks/useTypewriterText';
export {
  computeLearningCalloutsLayout,
  type CalloutRect,
  type LearningCalloutPlacement,
  type LearningCalloutsGeometryFrame,
  type LearningCalloutsLayout,
  type PartAnchors,
} from './model/calloutLayout';
export { buildGroundedComponentExplanation } from './catalog';
export {
  buildLearningPrompt,
  evaluateLocalInferenceSufficiency,
  formatOfflineLearningFallback,
} from './model/learningPrompt';
export {
  INITIAL_LEARNING_STATE,
  reduceLearningState,
  type AnswerSlotState,
  type ExplanationSlotState,
  type LearningAction,
  type LearningCalloutSlotState,
  type LearningState,
} from './model/learningState';
export { classifyCanvasPrompt, classifyCanvasPromptWithConfidence } from './model/promptRouter';
export { advanceTypewriterProgress, isTypewriterWriting } from './model/typewriter';
export {
  hydrateComponentLearningContext,
  retrieveComponentLearningContext,
  type LearningContextRepository,
  type LearningOfflineStorage,
} from './services/componentContextStore';
export {
  runLearningRequest,
  type CloudLearningRunner,
  type LearningResult,
} from './services/learningEngine';
export { resolveCanvasPromptRoute } from './services/promptRoutingService';
