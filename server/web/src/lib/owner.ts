// QuitFind owner mode: the encrypted device register of an owner account (docs/apparatenregister.md)
// and one session per device. The K_pwk values of the devices exist only in memory: they come from
// the decrypted register and are forgotten at logout.
import { create } from 'zustand';
import i18next from 'i18next';

import { ApiError, HTTP, ONE_WEEK_SECONDS, requestV2 } from './api';
import { API_BASE, ApiV2Service, DeviceSession, loginV2 } from './apiv2';
import { base64Decode, base64Encode, CRYPTO_PROTO_V2 } from './crypto';
import { deriveAuthKeyAndPreMasterKey, encryptNewMasterKey } from './cryptov2';
import { hashPasswordInWorker } from './hashWorker';
import { UserData, useStore } from './store';

export const DEVICE_TYPES = ['phone', 'tablet', 'laptop', 'pc', 'tag'] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];
export const TAG_KINDS = ['mac', 'ibeacon', 'eddystone', 'fmdn'] as const;

export interface DeviceEntry {
  v: 1;
  kind: 'device';
  username: string;
  server: string; // '' = this server
  pwk64: string; // K_pwk of the device account
  name: string;
  type: DeviceType;
  tag?: { kind: string; id: string; eik64?: string };
  addedAt: number;
}

interface SettingsEntry {
  v: 1;
  kind: 'settings';
  registrationToken: string;
}

// A register item as stored on the server, with its clientItemIdHex
export type Stored<T> = T & { id: string };
type RegisterItem = Stored<DeviceEntry> | Stored<SettingsEntry>;

interface OwnerState {
  // 'loading' until the register of the logged-in account is read; 'owner' shows the dashboard
  status: 'loading' | 'owner' | 'none';
  items: RegisterItem[];
}

export const useOwner = create<OwnerState>()(() => ({ status: 'loading', items: [] }));

// One entry per account. Duplicates (an edit whose delete failed): the newest item wins.
export function registerDevices(items: RegisterItem[]): Stored<DeviceEntry>[] {
  const byAccount = new Map<string, Stored<DeviceEntry>>();
  for (const it of items) if (it.kind === 'device') byAccount.set(it.username, it);
  return [...byAccount.values()];
}

export const registerSettings = (items: RegisterItem[]) =>
  items.findLast((it): it is Stored<SettingsEntry> => it.kind === 'settings');

// Decrypted items are authentic (AES-GCM with the owner's key), but may come from other or older
// apps: skip what is unusable, keep unknown fields (they are written back on an edit).
function parseItem(id: string, it: Record<string, unknown>): RegisterItem | null {
  if (it.kind === 'settings') {
    return {
      ...it,
      v: 1,
      kind: 'settings',
      registrationToken: String(it.registrationToken ?? ''),
      id,
    };
  }
  if (it.kind !== 'device' || typeof it.username !== 'string' || typeof it.pwk64 !== 'string') {
    return null;
  }
  const type = DEVICE_TYPES.find((t) => t === it.type) ?? 'phone';
  return { ...(it as unknown as DeviceEntry), name: String(it.name || it.username), type, id };
}

const strip = <T extends { id: string }>({ id: _id, ...rest }: T) => rest;

// ------- Sessions -------

let loginQueue: Promise<unknown> = Promise.resolve();

// Logins and Argon2 runs (128 MiB each) strictly one after another, never in parallel
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = loginQueue.then(job);
  loginQueue = run.catch(() => undefined);
  return run;
}

// The session of one device, in memory only. Always a 1-week token; after a 401 it logs in
// again with the stored K_pwk (no Argon2 needed). A rejected key (403), a gone account (404) or a
// locked one (423) is not retried: 7 failed logins lock the account, also for the device itself.
class Session implements DeviceSession {
  current: Promise<UserData> | null;

  constructor(
    readonly device: DeviceEntry,
    first?: UserData
  ) {
    this.current = first ? Promise.resolve(first) : null;
  }

  async get(stale?: UserData): Promise<UserData> {
    const cur = this.current;
    if (stale && cur && (await cur.catch(() => null)) === stale && this.current === cur) {
      this.current = null;
    }
    if (!this.current) {
      const { username, pwk64 } = this.device;
      const key = refusalKey(this.device);
      const refused = readRefusals()[key];
      // geweigerde sleutel: niet opnieuw proberen, ook niet na herladen (7 missers = account 10 min op slot)
      if (refused && (refused.status !== 423 || Date.now() - refused.at < LOCK_MS)) {
        return Promise.reject(new ApiError('refused', refused.status));
      }
      const login = serial(() => loginV2(username, base64Decode(pwk64), ONE_WEEK_SECONDS, ''));
      this.current = login;
      login.then(
        () => writeRefusal(key, null),
        (error) => {
          const status = error instanceof ApiError ? error.status : 0;
          if ([403, 404, 423].includes(status)) writeRefusal(key, { status, at: Date.now() });
          if (this.current === login && status !== 403 && status !== 404) this.current = null; // 423/netwerk: later opnieuw
        }
      );
    }
    return this.current;
  }
}

const sessions = new Map<string, { session: Session; api: ApiV2Service }>();

// Geweigerde logins per apparaat, bewaard in localStorage onder een hash (geen gebruikersnamen in klare tekst)
const REFUSED = 'quitfind-refused';
const LOCK_MS = 10 * 60_000;
type Refusal = { status: number; at: number };
function refusalKey(d: DeviceEntry): string {
  let h = 0x811c9dc5;
  for (const c of `${d.username}:${d.addedAt}`)
    h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16);
}
function readRefusals(): Record<string, Refusal> {
  try {
    return JSON.parse(localStorage.getItem(REFUSED) ?? '{}') as Record<string, Refusal>;
  } catch {
    return {};
  }
}
function writeRefusal(key: string, r: Refusal | null) {
  try {
    const all = readRefusals();
    if (r) all[key] = r;
    else delete all[key];
    localStorage.setItem(REFUSED, JSON.stringify(all));
  } catch {
    // privévenster of geblokkeerde opslag: dan alleen de bescherming binnen deze sessie
  }
}

// The API of one device's own account (locations, commands, pictures)
export function deviceApi(device: DeviceEntry, first?: UserData): ApiV2Service {
  let s = sessions.get(device.username);
  if (!s || first || s.session.device.pwk64 !== device.pwk64) {
    const session = new Session(device, first);
    s = { session, api: new ApiV2Service(session) };
    sessions.set(device.username, s);
  }
  return s.api;
}

function endSession(username: string) {
  // also on the server, but never log in just to log out
  void sessions
    .get(username)
    ?.session.current?.then((u) =>
      requestV2(HTTP.POST, `${API_BASE}/account/logout`, null, u.sessionToken)
    )
    .catch(() => undefined);
  sessions.delete(username);
}

// Owner logged out: forget the register, every device session and every K_pwk
useStore.subscribe((state, prev) => {
  if (prev.isLoggedIn && !state.isLoggedIn) {
    for (const username of [...sessions.keys()]) endSession(username);
    useOwner.setState({ status: 'loading', items: [] });
  }
});

// ------- Register -------

const owner = () => new ApiV2Service(); // the logged-in owner account

export async function loadRegister(): Promise<void> {
  const user = useStore.getState().userData;
  const { status } = useOwner.getState();

  let items: RegisterItem[] = [];
  try {
    if (user?.keysV2?.deviceKek) {
      const raw = await owner().getDeviceItems<Record<string, unknown>>();
      items = raw.flatMap(({ clientItemIdHex, item }) => parseItem(clientItemIdHex, item) ?? []);
    }
  } catch (error) {
    if (status === 'owner') throw error; // a refresh failed: keep showing the register we have
    console.warn('No device register', error); // e.g. a server without the "device" type
  }

  if (useStore.getState().userData !== user) return; // logged out meanwhile
  // once shown, the dashboard stays (also after removing the last device)
  const isOwner = items.length > 0 || status === 'owner';
  useOwner.setState({ status: isOwner ? 'owner' : 'none', items });
}

// Create a protocol v2 account in the browser, with the same key schedule as FMD Android
async function createAccount(username: string, password: string, registrationToken: string) {
  const salt64 = base64Encode(crypto.getRandomValues(new Uint8Array(16)));
  const pwk = (await hashPasswordInWorker(
    CRYPTO_PROTO_V2,
    username,
    password,
    salt64
  )) as Uint8Array<ArrayBuffer>;
  const [authKey, preMasterKey] = await deriveAuthKeyAndPreMasterKey(username, pwk.buffer);

  const { accessToken } = await requestV2<{ accessToken: string }>(
    HTTP.POST,
    `${API_BASE}/account/register`,
    {
      username,
      salt64,
      passwordHash64: base64Encode(authKey),
      protoVersion: CRYPTO_PROTO_V2,
      encMasterKey64: await encryptNewMasterKey(username, preMasterKey),
      registrationToken,
    },
    ''
  );
  return { pwk, accessToken };
}

// Login page: a new owner account. Its settings item marks it as an owner account (dashboard)
// and keeps the registration token for new tags.
export async function createOwnerAccount(
  username: string,
  password: string,
  registrationToken: string,
  rememberMe: boolean
) {
  const { pwk } = await serial(() => createAccount(username, password, registrationToken));
  const duration = rememberMe ? ONE_WEEK_SECONDS : 0;
  const user = await serial(() => loginV2(username, pwk, duration, ''));

  const session = { get: () => Promise.resolve(user) };
  await new ApiV2Service(session).addDeviceItem({ v: 1, kind: 'settings', registrationToken });

  useStore.setState({ protoVersion: CRYPTO_PROTO_V2 });
  await useStore.getState().setUserData(user, rememberMe);
}

// "Add device": link an existing FMD account. Argon2 once, check it by logging in, keep only K_pwk.
export async function linkDevice(
  username: string,
  password: string,
  name: string,
  type: DeviceType
) {
  if (registerDevices(useOwner.getState().items).some((d) => d.username === username)) {
    throw new Error(i18next.t('dashboard:owner.already_linked'));
  }
  const [salt64, protoVersion] = await owner().getSalt(username);
  if (protoVersion !== CRYPTO_PROTO_V2) throw new Error(i18next.t('dashboard:owner.v1_account'));

  const { pwk, user } = await serial(async () => {
    const pwk = (await hashPasswordInWorker(
      protoVersion,
      username,
      password,
      salt64
    )) as Uint8Array<ArrayBuffer>;
    return { pwk, user: await loginV2(username, pwk, ONE_WEEK_SECONDS, '') };
  });

  const device: DeviceEntry = {
    v: 1,
    kind: 'device',
    username,
    server: '',
    pwk64: base64Encode(pwk),
    name,
    type,
    addedAt: Date.now(),
  };
  await owner().addDeviceItem(device);
  deviceApi(device, user); // keep the session of the check
  await loadRegister();
}

// "Add tag": a new account t-<16 hex> with a random password nobody needs (the register keeps K_pwk).
// `registrationToken`: as entered; otherwise the one from the settings item.
export async function addTag(
  name: string,
  tag: { kind: string; id: string },
  registrationToken?: string
) {
  const settings = registerSettings(useOwner.getState().items);
  const token = registrationToken ?? settings?.registrationToken ?? '';
  const username = `t-${crypto.getRandomValues(new Uint8Array(8)).toHex()}`;
  const password = base64Encode(crypto.getRandomValues(new Uint8Array(24))); // geheimen-check: ok (willekeurig)

  const { pwk, accessToken } = await serial(() => createAccount(username, password, token));
  const device: DeviceEntry = {
    v: 1,
    kind: 'device',
    username,
    server: '',
    pwk64: base64Encode(pwk),
    name,
    type: 'tag',
    tag,
    addedAt: Date.now(),
  };
  try {
    await owner().addDeviceItem(device);
  } catch (error) {
    // no tag account that no register knows about
    await requestV2(HTTP.DELETE, `${API_BASE}/account`, null, accessToken).catch(() => undefined);
    throw error;
  }

  if (token !== settings?.registrationToken) {
    const old = settings ? strip(settings) : {};
    await owner().addDeviceItem({ ...old, v: 1, kind: 'settings', registrationToken: token });
    if (settings) await owner().deleteDeviceItem(settings.id);
  }
  await loadRegister();
}

// Edit = post the new item, then delete the old one(s): a failure leaves a duplicate, never a lost device
export async function editDevice(device: Stored<DeviceEntry>, name: string, type: DeviceType) {
  const newId = await owner().addDeviceItem({ ...strip(device), name, type });
  await deleteItemsOf(device.username, newId);
  await loadRegister();
}

// Remove from the register only: the device account and its data stay on the server
export async function removeDevice(device: Stored<DeviceEntry>) {
  await deleteItemsOf(device.username);
  endSession(device.username);
  await loadRegister();
}

async function deleteItemsOf(username: string, keep?: string) {
  for (const it of useOwner.getState().items) {
    if (it.kind === 'device' && it.username === username && it.id !== keep) {
      await owner().deleteDeviceItem(it.id);
    }
  }
}
