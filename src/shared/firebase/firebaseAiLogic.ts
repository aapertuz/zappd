import {
  GoogleAIBackend,
  InferenceMode,
  InferenceSource,
  getAI,
  getGenerativeModel,
} from 'firebase/ai';

import { getFirebaseApp } from './firebaseClient';

type LocalInferenceResult =
  | { readonly available: true; readonly text: string; readonly inferenceSource: 'on_device' }
  | { readonly available: false; readonly reason: string };

export type LocalInferenceRunner = (input: {
  readonly prompt: string;
  readonly onChunk?: (chunk: string) => void;
}) => Promise<LocalInferenceResult>;

export function createFirebaseAiLogicLocalRunner(): LocalInferenceRunner {
  return async ({ prompt, onChunk }) => {
    if (typeof window === 'undefined' || !('LanguageModel' in window && window.LanguageModel)) {
      return { available: false, reason: 'On-device AI is unavailable in this runtime.' };
    }

    try {
      const ai = getAI(getFirebaseApp(), { backend: new GoogleAIBackend() });
      const model = getGenerativeModel(ai, {
        mode: InferenceMode.ONLY_ON_DEVICE,
        onDeviceParams: { createOptions: { expectedInputs: [{ type: 'text' }] } },
      });
      const { stream, response } = await model.generateContentStream(prompt);
      const finalResponse = response.then(
        (value) => value,
        () => null,
      );

      for await (const chunk of stream) {
        if (chunk.inferenceSource === InferenceSource.ON_DEVICE) {
          const text = chunk.text();
          if (text.length > 0) onChunk?.(text);
        }
      }

      const result = await finalResponse;
      if (result?.inferenceSource === InferenceSource.ON_DEVICE) {
        return { available: true, text: result.text(), inferenceSource: 'on_device' };
      }
    } catch {
      return { available: false, reason: 'The on-device model could not generate a response.' };
    }
    return { available: false, reason: 'The on-device model did not return a response.' };
  };
}
