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

function getFirebaseOptions(): FirebaseOptions {
  const projectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID?.trim();
  const apiKey = process.env.EXPO_PUBLIC_FIREBASE_API_KEY?.trim();
  if (projectId && apiKey) {
    return {
      projectId,
      apiKey,
      appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
      authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
      storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ?? `${projectId}.appspot.com`,
      messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      measurementId: process.env.EXPO_PUBLIC_FIREBASE_MEASUREMENT_ID,
    };
  }

  return {
    projectId: FIREBASE_EMULATOR_CONFIG.projectId,
    storageBucket: FIREBASE_EMULATOR_CONFIG.storageBucket,
    apiKey: 'local-emulator-api-key',
    appId: 'zappd-local-emulator',
  };
}

export function getFirebaseApp(): FirebaseApp {
  return getApps().find((app) => app.name === '[DEFAULT]') ?? initializeApp(getFirebaseOptions());
}

export function usesFirebaseEmulators(): boolean {
  return getFirebaseApp().options.projectId === FIREBASE_EMULATOR_CONFIG.projectId;
}

function initializeProjectFirestore(app: FirebaseApp): Firestore {
  if (typeof window !== 'undefined') {
    try {
      return initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
      });
    } catch {
      return getFirestore(app);
    }
  }
  return getFirestore(app);
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
