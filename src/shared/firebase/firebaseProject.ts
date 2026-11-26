export const DEFAULT_FIREBASE_PROJECT = {
  projectId: 'zappd-7e788',
  storageBucket: 'zappd-7e788.firebasestorage.app',
} as const;

export function buildFirebaseStorageMediaUrl(storageBucket: string, storagePath: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(storageBucket)}/o/${encodeURIComponent(storagePath)}?alt=media`;
}
