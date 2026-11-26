import { type FirebaseApp, type FirebaseOptions, getApps, initializeApp } from 'firebase/app';
import {
  type Firestore,
  connectFirestoreEmulator,
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { type FirebaseStorage, connectStorageEmulator, getStorage } from 'firebase/storage';

import { DEFAULT_FIREBASE_PROJECT, buildFirebaseStorageMediaUrl } from './firebaseProject';

export { buildFirebaseStorageMediaUrl } from './firebaseProject';

export const FIREBASE_EMULATOR_CONFIG = {
  projectId: 'zappd-local-emulator',
  storageBucket: 'zappd-local-emulator.appspot.com',
  firestoreHost: '127.0.0.1',
  firestorePort: 8080,
  storageHost: '127.0.0.1',
  storagePort: 9199,
} as const;

export type FirebaseEmulatorClients = {
  readonly app: FirebaseApp;
  readonly firestore: Firestore;
  readonly storage: FirebaseStorage;
};

let cachedClients: FirebaseEmulatorClients | null = null;

function readNonEmptyOption(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function getFirebaseOptions(): FirebaseOptions {
  if (process.env.EXPO_PUBLIC_FIREBASE_USE_EMULATORS === '1') {
    return {
      projectId: FIREBASE_EMULATOR_CONFIG.projectId,
      storageBucket: FIREBASE_EMULATOR_CONFIG.storageBucket,
      apiKey: 'local-emulator-api-key',
      appId: 'zappd-local-emulator',
    };
  }

  const projectId =
    readNonEmptyOption(process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID) ??
    DEFAULT_FIREBASE_PROJECT.projectId;
  const defaultBucket =
    projectId === DEFAULT_FIREBASE_PROJECT.projectId
      ? DEFAULT_FIREBASE_PROJECT.storageBucket
      : `${projectId}.appspot.com`;
  return {
    projectId,
    apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY?.trim(),
    appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
    authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
    storageBucket:
      readNonEmptyOption(process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET) ?? defaultBucket,
    messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID,
  };
}

export function getFirebaseApp(): FirebaseApp {
  return getApps().find((app) => app.name === '[DEFAULT]') ?? initializeApp(getFirebaseOptions());
}

export function usesFirebaseEmulators(): boolean {
  return getFirebaseApp().options.projectId === FIREBASE_EMULATOR_CONFIG.projectId;
}

export function resolveAssemblyAssetUrls(file: {
  readonly storagePath: string;
  readonly publicUrl: string;
}): readonly string[] {
  if (/^https?:\/\//.test(file.publicUrl) || usesFirebaseEmulators()) return [file.publicUrl];

  const storageBucket = getFirebaseApp().options.storageBucket?.trim();
  return storageBucket
    ? [buildFirebaseStorageMediaUrl(storageBucket, file.storagePath), file.publicUrl]
    : [file.publicUrl];
}

function initializeProjectFirestore(app: FirebaseApp): Firestore {
  try {
    return initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      ...(typeof window === 'undefined'
        ? {}
        : { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }),
    });
  } catch {
    return getFirestore(app);
  }
}

export function getFirebaseEmulatorClients(): FirebaseEmulatorClients {
  if (cachedClients !== null) {
    return cachedClients;
  }

  const app = getFirebaseApp();
  const firestore = initializeProjectFirestore(app);
  const storage = getStorage(app);

  if (usesFirebaseEmulators()) {
    try {
      connectFirestoreEmulator(
        firestore,
        FIREBASE_EMULATOR_CONFIG.firestoreHost,
        FIREBASE_EMULATOR_CONFIG.firestorePort,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already')) {
        throw error;
      }
    }

    try {
      connectStorageEmulator(
        storage,
        FIREBASE_EMULATOR_CONFIG.storageHost,
        FIREBASE_EMULATOR_CONFIG.storagePort,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('already')) {
        throw error;
      }
    }
  }

  cachedClients = { app, firestore, storage };
  return cachedClients;
}
