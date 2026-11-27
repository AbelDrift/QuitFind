import type { PasswordHashResult } from '@/lib/crypto';

// Hash the password (Argon2, 128 MiB) on a Web Worker background thread.
// Otherwise the UI thread (and the slow-login toast timer) is blocked by the hashing.
export const hashPasswordInWorker = (
  protoVersion: number,
  username: string,
  password: string,
  salt64: string
): Promise<PasswordHashResult> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/passwordHashing.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (ev) => {
      resolve(ev.data as PasswordHashResult);
      worker.terminate();
    };

    worker.onerror = (err) => {
      reject(new Error(err.message));
      worker.terminate();
    };

    worker.postMessage([protoVersion, username, password, salt64]);
  });
