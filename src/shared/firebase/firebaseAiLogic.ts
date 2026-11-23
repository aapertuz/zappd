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

const ON_DEVICE_AVAILABILITY_TIMEOUT_MS = 1000;
const ON_DEVICE_STREAM_START_TIMEOUT_MS = 8000;
const READY_AVAILABILITY_STATES = new Set(['available', 'readily']);

type BrowserLanguageModelApi = {
  readonly availability?: (options?: {
    readonly expectedInputs?: readonly { readonly type: string }[];
  }) => Promise<unknown>;
};

function readBrowserLanguageModel(): BrowserLanguageModelApi | null {
  if (typeof window === 'undefined' || !('LanguageModel' in window)) return null;
  const candidate: unknown = Reflect.get(window, 'LanguageModel');
  if (candidate === null || (typeof candidate !== 'object' && typeof candidate !== 'function')) {
    return null;
  }
  const availability: unknown = Reflect.get(candidate, 'availability');
  if (typeof availability === 'function') {
    return {
      availability: (options) => Promise.resolve(Reflect.apply(availability, candidate, [options])),
    };
  }
  return {};
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function isOnDeviceModelReady(api: BrowserLanguageModelApi): Promise<boolean> {
  if (typeof api.availability !== 'function') return true;
  try {
    const status = await withTimeout(
      api.availability({ expectedInputs: [{ type: 'text' }] }),
      ON_DEVICE_AVAILABILITY_TIMEOUT_MS,
    );
    return typeof status === 'string' && READY_AVAILABILITY_STATES.has(status);
  } catch {
    return false;
  }
}

export function createFirebaseAiLogicLocalRunner(): LocalInferenceRunner {
  return async ({ prompt, onChunk }) => {
    const languageModel = readBrowserLanguageModel();
    if (languageModel === null) {
      return { available: false, reason: 'On-device AI is unavailable in this runtime.' };
    }
    if (!(await isOnDeviceModelReady(languageModel))) {
      return { available: false, reason: 'On-device AI model is not ready yet.' };
    }

    try {
      const ai = getAI(getFirebaseApp(), { backend: new GoogleAIBackend() });
      const model = getGenerativeModel(ai, {
        mode: InferenceMode.ONLY_ON_DEVICE,
        onDeviceParams: { createOptions: { expectedInputs: [{ type: 'text' }] } },
      });
      const streamResult = await withTimeout(
        model.generateContentStream(prompt),
        ON_DEVICE_STREAM_START_TIMEOUT_MS,
      );
      if (streamResult === null) {
        return { available: false, reason: 'On-device AI model timed out.' };
      }
      const { stream, response } = streamResult;
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
