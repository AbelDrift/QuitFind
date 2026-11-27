import {
  ApiError,
  BaseApiService,
  HTTP,
  Location,
  Item,
  ONE_WEEK_SECONDS,
  Picture,
  requestV2,
} from './api';
import { base64Encode } from './crypto';
import {
  DataBlobType,
  decryptDataV2,
  decryptMasterKey,
  deriveAuthKeyAndPreMasterKey,
  deriveKeks,
  encryptDataV2,
} from './cryptov2';
import { CryptoKeysV2 } from './keystore';
import { UserData, useStore } from './store';

export const API_BASE = 'api/v2';

interface SaltResponse {
  salt64: string;
  protoVersion: number;
}

interface LoginRequest {
  username: string;
  passwordHash64: string;
  sessionDurationSeconds: number;
}

interface LoginResponse {
  accessToken: string;
  encMasterKey64: string;
}

interface PushUrlRequestResponse {
  url: string;
}

interface DataRequestResponse {
  items: EncryptedItem[];
}

interface EncryptedItem {
  clientItemIdHex: string;
  unixMillis: number;
  ciphertext64: string;
}

/**
 * QuitFind: the session of one device in the owner dashboard (see lib/owner.ts).
 * get(stale) logs in again when the server rejected the session `stale`.
 */
export interface DeviceSession {
  get(stale?: UserData): Promise<UserData>;
}

/**
 * Logs in with the password key K_pwk (from Argon2, or stored in the device register)
 * and derives all keys. `sessionToken` as in requestV2 ('' = log in as another account).
 */
export async function loginV2(
  username: string,
  // This is K_pwk, not K_auth!
  passwordHash: Uint8Array<ArrayBuffer>,
  sessionDurationSeconds: number,
  sessionToken?: string
): Promise<UserData> {
  const [authKey, preMasterKey] = await deriveAuthKeyAndPreMasterKey(username, passwordHash.buffer);

  // Get access token and encrypted master key
  const requestBody: LoginRequest = {
    username,
    passwordHash64: base64Encode(authKey),
    sessionDurationSeconds,
  };
  const response = await requestV2<LoginResponse>(
    HTTP.POST,
    `${API_BASE}/account/login`,
    requestBody,
    sessionToken
  );

  // Decrypt the master key and derive the KEKs from it
  const [masterKey, fingerprint] = await decryptMasterKey(
    username,
    preMasterKey,
    response.encMasterKey64
  );
  const [cmdKek, locationKek, pictureKek, deviceKek] = await deriveKeks(username, masterKey);

  const keysV2: CryptoKeysV2 = {
    // masterKey,
    cmdKek,
    locationKek,
    pictureKek,
    deviceKek,
  };

  return {
    fmdId: username,
    sessionToken: response.accessToken,
    fingerprint,
    keysV2,
    keysV1: null,
  };
}

export class ApiV2Service extends BaseApiService {
  // QuitFind: without a session, this is the logged-in account (as upstream)
  constructor(private readonly session?: DeviceSession) {
    super();
  }

  private async user(): Promise<UserData> {
    return this.session ? this.session.get() : useStore.getState().userData!;
  }

  private async request<T>(method: string, endpoint: string, body: object | null = null) {
    if (!this.session) return requestV2<T>(method, endpoint, body);

    const user = await this.session.get();
    try {
      return await requestV2<T>(method, endpoint, body, user.sessionToken);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
      // Token expired or forgotten by a server restart: log in again (stored K_pwk) and retry once
      return requestV2<T>(method, endpoint, body, (await this.session.get(user)).sessionToken);
    }
  }

  async getSalt(userName: string): Promise<[string, number]> {
    const response = await requestV2<SaltResponse>(
      HTTP.GET,
      `${API_BASE}/account/${userName}/salt`
    );
    return [response.salt64, response.protoVersion];
  }

  async login(
    username: string,
    _password: string,
    // This is K_pwk, not K_auth!
    passwordHash: Uint8Array<ArrayBuffer>,
    rememberMe: boolean
  ): Promise<void> {
    const sessionDurationSeconds = rememberMe ? ONE_WEEK_SECONDS : 0;

    const data = await loginV2(username, passwordHash, sessionDurationSeconds);

    // Store everything
    const { setUserData } = useStore.getState();
    await setUserData(data, rememberMe);
  }

  async logout(): Promise<void> {
    await this.request(HTTP.POST, `${API_BASE}/account/logout`);
  }

  async getPushUrl(): Promise<string> {
    const response = await this.request<PushUrlRequestResponse>(
      HTTP.GET,
      `${API_BASE}/account/push_url`
    );
    return response.url;
  }

  async deleteAccount(): Promise<void> {
    await this.request(HTTP.DELETE, `${API_BASE}/account`);
  }

  async sendCommand(command: string): Promise<void> {
    await this.postItem('command', (k) => k.cmdKek, new TextEncoder().encode(command));
  }

  getLocations(): Promise<Item<Location>[]> {
    return this.getItems<Location>('location', (k) => k.locationKek);
  }

  async getPictures(): Promise<Item<string>[]> {
    const pictures = await this.getItems<Picture>('picture', (k) => k.pictureKek);
    return pictures.map((p) => ({ ...p, item: p.item.raw64 }));
  }

  // QuitFind: the device register of an owner account (docs/apparatenregister.md)
  getDeviceItems<T>(): Promise<Item<T>[]> {
    return this.getItems<T>('device', (k) => k.deviceKek);
  }

  addDeviceItem(item: object): Promise<string> {
    const data = new TextEncoder().encode(JSON.stringify(item));
    return this.postItem('device', (k) => k.deviceKek, data);
  }

  async deleteDeviceItem(clientItemIdHex: string): Promise<void> {
    await this.request(HTTP.DELETE, `${API_BASE}/data/device/${clientItemIdHex}`);
  }

  // Get and decrypt all items of one type. Items that fail to decrypt are skipped.
  private async getItems<T>(
    type: DataBlobType,
    kek: (keys: CryptoKeysV2) => CryptoKey
  ): Promise<Item<T>[]> {
    const user = await this.user();
    const encrypted = await this.request<DataRequestResponse>(HTTP.GET, `${API_BASE}/data/${type}`);

    const decrypted: Item<T>[] = [];
    const decoder = new TextDecoder();

    for (const it of encrypted.items) {
      try {
        const bytes = await decryptDataV2(
          user.fmdId,
          kek(user.keysV2!),
          type,
          it.clientItemIdHex,
          it.unixMillis,
          it.ciphertext64
        );
        decrypted.push({
          clientItemIdHex: it.clientItemIdHex,
          unixMillis: it.unixMillis,
          item: JSON.parse(decoder.decode(bytes)) as T,
        });
      } catch {
        console.log(`Failed to decrypt ${type} ${it.clientItemIdHex}`);
      }
    }

    return decrypted;
  }

  // Encrypt one item and send it to the server. Returns its clientItemIdHex.
  private async postItem(
    type: DataBlobType,
    kek: (keys: CryptoKeysV2) => CryptoKey,
    data: Uint8Array<ArrayBuffer>
  ): Promise<string> {
    const user = await this.user();

    const [clientItemIdHex, unixMillis, ciphertext64] = await encryptDataV2(
      user.fmdId,
      kek(user.keysV2!),
      type,
      data
    );

    const bodyObj: DataRequestResponse = {
      items: [{ clientItemIdHex, unixMillis, ciphertext64 }],
    };
    await this.request(HTTP.POST, `${API_BASE}/data/${type}`, bodyObj);
    return clientItemIdHex;
  }

  async deleteAllCommands(): Promise<void> {
    await this.request(HTTP.DELETE, `${API_BASE}/data/command/all`);
  }

  async deleteAllLocations(): Promise<void> {
    await this.request(HTTP.DELETE, `${API_BASE}/data/location/all`);
  }

  async deleteAllPictures(): Promise<void> {
    await this.request(HTTP.DELETE, `${API_BASE}/data/picture/all`);
  }

  async deleteSingleLocation(clientItemIdHex: string): Promise<void> {
    await this.request(HTTP.DELETE, `${API_BASE}/data/location/${clientItemIdHex}`);
  }

  async deleteSinglePicture(clientItemIdHex: string): Promise<void> {
    await this.request(HTTP.DELETE, `${API_BASE}/data/picture/${clientItemIdHex}`);
  }

  async getTileServerUrl(): Promise<string> {
    const response = await fetch(`${API_BASE}/tileServerUrl`);

    const text = await response.text();
    if (!response.ok) {
      throw new Error(text || 'Request failed');
    }

    return text;
  }
}
