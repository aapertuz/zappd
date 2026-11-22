import { type FirebaseApp, getApp, getApps, initializeApp } from 'firebase/app';
import { type Firestore, connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
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

export function getFirebaseEmulatorClients(): FirebaseEmulatorClients {
  if (cachedClients !== null) {
    return cachedClients;
  }

  const existingApps = getApps();
  const app =
    existingApps.length > 0
      ? getApp()
      : initializeApp({
          projectId: FIREBASE_EMULATOR_CONFIG.projectId,
          storageBucket: FIREBASE_EMULATOR_CONFIG.storageBucket,
          apiKey: 'local-emulator-api-key',
        });

  const firestore = getFirestore(app);
  const storage = getStorage(app);

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

  cachedClients = { app, firestore, storage };
  return cachedClients;
}
