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

    const timer = setTimeout(() => {
      worker.terminate(); // a stuck worker must not block every later login
      reject(new Error('Password hashing timed out'));
    }, 120_000);

    worker.onmessage = (ev) => {
      clearTimeout(timer);
      resolve(ev.data as PasswordHashResult);
      worker.terminate();
    };

    worker.onerror = (err) => {
      clearTimeout(timer);
      reject(new Error(err.message));
      worker.terminate();
    };

    worker.postMessage([protoVersion, username, password, salt64]);
  });
