export {
  computeLearningCalloutsLayout,
  type LearningCalloutPlacement,
  type LearningCalloutsLayout,
} from './model/calloutLayout';
export { buildGroundedComponentExplanation } from './model/catalogExplanations';
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
export { classifyCanvasPrompt } from './model/promptRouter';
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
