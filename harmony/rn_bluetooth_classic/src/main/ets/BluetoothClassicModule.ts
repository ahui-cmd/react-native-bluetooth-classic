/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { TurboModule } from '@rnoh/react-native-openharmony/ts';
import { TM } from './generated/ts';

import util from '@ohos.util';
import { util as arkUtil } from '@kit.ArkTS';
import { access, connection, socket } from '@kit.ConnectivityKit';
import { common, Want } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';

type BluetoothNativeDeviceSpec = TM.RNBluetoothClassic.BluetoothNativeDeviceSpec;

type StandardOptionsSpec = TM.RNBluetoothClassic.StandardOptionsSpec;

type ConnectionRecord = {
  address: string;
  clientSocket: number;
  options: StandardOptionsSpec;
  readEventsEnabled: boolean;
  readListenerCount: number;
  sppReadCallback?: (data: ArrayBuffer) => void;
  socketStateTimer?: number;
  connectionMode: 'delimited' | 'binary';
  readSizeCap: number;
  readTimeoutMs: number;
  textBuffer: string;
  binaryStorage?: Uint8Array;
  binaryLength?: number;
  connectedAtMs: number;
};

const SPP_UUID = '00001101-0000-1000-8000-00805F9B34FB';
const DISCOVERY_DURATION_MS = 12_000;
const MAX_BUFFER_CHARS = 64 * 1024;
const ANDROID_DEFAULT_READ_SIZE = 1024;
const ANDROID_DEFAULT_READ_TIMEOUT_MS = 0;
const SPP_IO_ERROR_CODE = 2901054;
const SPP_WRITE_READY_MS = 800;
const SPP_WRITE_RETRY_DELAY_MS = 450;
const SPP_CONNECT_TIMEOUT_MS = 30_000;
const SPP_TYPE_RFCOMM = 0;

const HMOS_BLUETOOTH_SETTINGS_WANT: Want = {
  bundleName: 'com.huawei.hmos.settings',
  abilityName: 'com.huawei.hmos.settings.MainAbility',
  uri: 'bluetooth_entry',
};

function getBusinessErrorCode(e: any): number | null {
  const code = (e && (e.code ?? e.errorCode ?? e.errCode)) as any;
  return typeof code === 'number' ? code : null;
}

function getBusinessErrorMessage(e: any): string | null {
  const msg = (e && (e.message ?? e.errorMessage ?? e.errMsg)) as any;
  return typeof msg === 'string' ? msg : null;
}

function isSppIoError(e: any): boolean {
  const code = getBusinessErrorCode(e);
  if (code === SPP_IO_ERROR_CODE) {
    return true;
  }
  const msg = String((e as any)?.message ?? e);
  return msg.includes(`${SPP_IO_ERROR_CODE}`) || msg.toLowerCase().includes('spp io');
}

function splitDeviceScopedEvent(requestedEvent: string): { eventName: string; deviceKey: string | null } {
  if (requestedEvent.includes('@')) {
    const split = requestedEvent.split('@');
    return { eventName: split[0], deviceKey: split[1] ?? null };
  }
  return { eventName: requestedEvent, deviceKey: null };
}

function socketStateNumericLooksDisconnected(state: number): boolean {
  return state <= 0;
}

function socketStateStringLooksDisconnected(s: string): boolean {
  const lower = s.toLowerCase();
  return (
    lower.includes('close') ||
    lower.includes('closed') ||
    lower.includes('disconnect') ||
    lower.includes('disconnected')
  );
}

function isBluetoothBusyOrDisallowedCode(code: number | null): boolean {
  return code === 2900099 || code === 290099;
}

function isTransientLinkOrWriteError(e: any): boolean {
  const code = getBusinessErrorCode(e);
  const msg = String(getBusinessErrorMessage(e) ?? (e as any)?.message ?? e ?? '');
  const lower = msg.toLowerCase();
  if (isBluetoothBusyOrDisallowedCode(code)) {
    return true;
  }
  return (
    lower.includes('not connected') ||
    lower.includes('not established') ||
    lower.includes('no connection')
  );
}

function base64ToUint8Array(b64: string): Uint8Array {
  try {
    const helper = new (arkUtil as any).Base64Helper();
    const bytes = helper.decodeSync(String(b64 ?? ''));
    if (bytes instanceof Uint8Array) {
      return bytes;
    }
  } catch (_) {
  }

  const atobFn = (globalThis as any).atob as undefined | ((s: string) => string);
  if (typeof atobFn !== 'function') {
    throw new Error('Base64 decode unavailable (no Base64Helper/atob)');
  }
  const bin = atobFn(String(b64 ?? ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (!bytes || bytes.length === 0) {
    return '';
  }
  try {
    const helper = new (arkUtil as any).Base64Helper();
    if (typeof helper.encodeSync === 'function') {
      return helper.encodeSync(bytes);
    }
  } catch (_) {
  }
  const btoaFn = (globalThis as any).btoa as undefined | ((s: string) => string);
  if (typeof btoaFn !== 'function') {
    throw new Error('Base64 encode unavailable (no Base64Helper/btoa)');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] & 0xff);
  }
  return btoaFn(binary);
}

function uint8ArrayToString(bytes: Uint8Array, charset?: string | number | Object): string {
  let encoding = 'ascii';
  if (typeof charset === 'string' && charset.trim().length > 0) {
    encoding = charset;
  } else if (typeof charset === 'number') {
    encoding = 'utf-8';
  }
  try {
    const decoder = util.TextDecoder.create(encoding, { ignoreBOM: true });
    return decoder.decodeWithStream(bytes);
  } catch (_) {
    try {
      const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
      return decoder.decodeWithStream(bytes);
    } catch (_) {
      return '';
    }
  }
}

function safeNowIso(): string {
  try {
    return new Date().toISOString();
  } catch (_) {
    return `${Date.now()}`;
  }
}

function logBusinessError(scope: string, err: unknown): void {
  const be = err as BusinessError;
  console.error(
    `[RNBluetoothClassic] ${scope} errCode: ${String(be?.code ?? '')}, errMessage: ${String(be?.message ?? err ?? '')}`
  );
}

export class BluetoothClassicModule extends TurboModule implements TM.RNBluetoothClassic.Spec {
  private connectionsByAddress: Map<string, ConnectionRecord> = new Map();
  private addressCanonical: Map<string, string> = new Map();
  private listenerCounts: Map<string, number> = new Map();
  private acceptServerSocket: number | null = null;
  private acceptListenServiceName: string | null = null;
  private acceptListenSecure: boolean | null = null;
  private acceptCancelled: boolean = false;
  private acceptCallInFlight: boolean = false;
  private discoveryActive: boolean = false;
  private discoveryTimer: number | null = null;
  private discoveryDevices: Map<string, BluetoothNativeDeviceSpec> = new Map();
  private discoveryResolve: ((devices: BluetoothNativeDeviceSpec[]) => void) | null = null;
  private deviceFindCallback: ((ids: string[]) => void) | null = null;

  private btStateCallback: ((state: any) => void) | null = null;
  private lastBtStableEmitted: 'on' | 'off' | null = null;
  private readonly supportedEvents: Set<string> = new Set([
    'BLUETOOTH_ENABLED',
    'BLUETOOTH_DISABLED',
    'DEVICE_CONNECTED',
    'DEVICE_DISCONNECTED',
    'DEVICE_DISCOVERED',
    'DEVICE_READ',
    'ERROR',
  ]);

  openBluetoothSettings(): void {
    try {
      const uiCtx = (this as any)?.ctx?.uiAbilityContext as common.UIAbilityContext | undefined;
      if (!uiCtx || typeof uiCtx.startAbility !== 'function') {
        console.warn('[RNBluetoothClassic] openBluetoothSettings: UIAbilityContext unavailable');
        return;
      }

      uiCtx.startAbility(HMOS_BLUETOOTH_SETTINGS_WANT, (err) => {
        if (err) {
          console.warn(`[RNBluetoothClassic] openBluetoothSettings failed: ${JSON.stringify(err)}`);
        }
      });
    } catch (e) {
      console.warn(`[RNBluetoothClassic] openBluetoothSettings threw: ${JSON.stringify(e)}`);
    }
  }

  async isBluetoothAvailable(): Promise<boolean> {
    try {
      this.ensureBtStateListener();
      access.getState();
      return true;
    } catch (_) {
      return false;
    }
  }

  async isBluetoothEnabled(): Promise<boolean> {
    try {
      this.ensureBtStateListener();
      const state = access.getState();
      const n = this.normalizeBtAccessState(state);
      if (this.lastBtStableEmitted === 'off' && n !== 'off') {
        return false;
      }
      return n === 'on';
    } catch (_) {
      return false;
    }
  }

  async getBondedDevices(): Promise<BluetoothNativeDeviceSpec[]> {
    this.assertBluetoothAdapterEnabled();
    const ids = connection.getPairedDevices();
    return ids.map((id) => this.asNativeDevice(id, { bonded: true }));
  }

  async getConnectedDevices(): Promise<BluetoothNativeDeviceSpec[]> {
    return Array.from(this.connectionsByAddress.values()).map((rec) =>
    this.asNativeDevice(rec.address, { bonded: true })
    );
  }

  async connectToDevice(address: string, properties: StandardOptionsSpec): Promise<BluetoothNativeDeviceSpec> {
    this.assertBluetoothAdapterEnabled();
    await this.preflightForOperation('connect');

    this.assertRfcommConnectorOrAcceptor(properties, 'connector');
    const connectionMode = this.resolveConnectionMode(properties);
    const readSizeCap = this.resolveReadSizeCap(properties);
    const readTimeoutMs = this.resolveReadTimeoutMs(properties);

    const dialRaw = String(address ?? '').trim();
    const dialStack = this.resolveSppDialAddress(dialRaw);
    const primaryKey = this.inferPrimaryKeyForConnection(dialRaw);

    const existing = this.connectionsByAddress.get(primaryKey);
    if (existing) {
      if (!this.shouldReuseExistingConnection(existing)) {
        this.teardownConnection(primaryKey, { expectedSocketId: existing.clientSocket, emitEvent: true });
      } else {
        return this.asNativeDevice(primaryKey, { bonded: true });
      }
    }

    const secure = this.resolveSppSecure(properties);
    const clientSocket = await this.connectOnce(dialStack, secure, SPP_CONNECT_TIMEOUT_MS);
    await this.assertFreshSppOutboundSocketOrThrow(clientSocket);
    this.registerAliasesForPrimary(primaryKey, [dialRaw, dialStack, this.canonicalDeviceAddress(dialRaw), primaryKey]);
    const mergedOptions: StandardOptionsSpec = { ...(properties ?? {}), secureSocket: secure };

    this.connectionsByAddress.set(primaryKey, {
      address: primaryKey,
      clientSocket,
      options: mergedOptions,
      readEventsEnabled: false,
      readListenerCount: 0,
      connectionMode,
      readSizeCap,
      readTimeoutMs,
      textBuffer: '',
      binaryStorage: connectionMode === 'binary' ? new Uint8Array(readSizeCap) : undefined,
      binaryLength: connectionMode === 'binary' ? 0 : undefined,
      connectedAtMs: Date.now(),
    });

    const rec = this.connectionsByAddress.get(primaryKey);
    if (rec) {
      this.startSppReadForConnection(rec);
      this.syncReadSubscriptionStateFromListenerCounts(rec);
      if (rec.readEventsEnabled && rec.readListenerCount > 0) {
        this.flushIncomingTextBuffer(rec);
      }
      this.startSocketStateMonitor(rec);
    }

    this.emitDeviceEvent('DEVICE_CONNECTED', {
      device: this.asNativeDevice(primaryKey, { bonded: true }),
      eventType: 'DEVICE_CONNECTED',
      timestamp: safeNowIso(),
      socketId: clientSocket,
      secureSocket: secure,
    });

    return this.asNativeDevice(primaryKey, { bonded: true });
  }

  private resolveSppSecure(properties: StandardOptionsSpec | undefined): boolean {
    if (typeof properties?.secureSocket === 'boolean') {
      return properties.secureSocket;
    }
    return true;
  }

  private assertRfcommConnectorOrAcceptor(properties: StandardOptionsSpec | undefined, role: 'connector' | 'acceptor'): void {
    const raw = role === 'connector' ? properties?.connectorType : properties?.acceptorType;
    const v =
      typeof raw === 'string' && raw.trim().length > 0 ? raw.trim().toLowerCase() : 'rfcomm';
    if (v !== 'rfcomm') {
      if (role === 'connector') {
        throw new Error(`Invalid connector type: ${raw}`);
      }
      throw new Error(`No ConnectionAcceptorFactory configured for type ${raw}`);
    }
  }

  private resolveConnectionMode(properties: StandardOptionsSpec | undefined): 'delimited' | 'binary' {
    const raw = properties?.connectionType ?? 'delimited';
    const v = typeof raw === 'string' ? raw.trim().toLowerCase() : 'delimited';
    if (v === '' || v === 'delimited') {
      return 'delimited';
    }
    if (v === 'binary') {
      return 'binary';
    }
    throw new Error(`Invalid connection type: ${raw}`);
  }

  private resolveReadSizeCap(properties: StandardOptionsSpec | undefined): number {
    const raw = properties?.readSize;
    const n =
      typeof raw === 'number' && !Number.isNaN(raw) ? Math.floor(raw) : ANDROID_DEFAULT_READ_SIZE;
    return n > 0 ? n : ANDROID_DEFAULT_READ_SIZE;
  }

  private resolveReadTimeoutMs(properties: StandardOptionsSpec | undefined): number {
    const raw = properties?.readTimeout;
    const n =
      typeof raw === 'number' && !Number.isNaN(raw) ? Math.floor(raw) : ANDROID_DEFAULT_READ_TIMEOUT_MS;
    return n >= 0 ? n : 0;
  }

  private appendBinaryChunk(rec: ConnectionRecord, chunk: Uint8Array): void {
    const cap = rec.readSizeCap;
    const len = rec.binaryLength ?? 0;
    const storage = rec.binaryStorage;
    if (!storage || storage.length !== cap) {
      throw new Error('Binary storage not initialized');
    }
    if (len + chunk.length > cap) {
      throw new Error(`Binary buffer overflow (${len + chunk.length} > readSize ${cap})`);
    }
    storage.set(chunk, len);
    rec.binaryLength = len + chunk.length;
  }

  private stopBluetoothDiscovery(scope: string, force: boolean): void {
    try {
      if (!force) {
        let scanning = false;
        try {
          scanning = connection.isBluetoothDiscovering();
        } catch (_) {
          scanning = false;
        }
        if (!scanning) {
          return;
        }
      }
      connection.stopBluetoothDiscovery();
    } catch (err: unknown) {
      const code = getBusinessErrorCode(err as any);
      if (isBluetoothBusyOrDisallowedCode(code)) {
        return;
      }
      logBusinessError(scope, err);
    }
  }

  private async stopDiscoveryAndWait(timeoutMs: number = 2000): Promise<void> {
    if (this.discoveryActive) {
      try {
        this.cancelDiscoveryCore();
      } catch (err) {
        logBusinessError('stopDiscoveryAndWait/cancelDiscoveryCore', err);
      }
    } else {
      this.stopBluetoothDiscovery('stopDiscoveryAndWait/bestEffortStop', false);
    }

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        if (!connection.isBluetoothDiscovering()) {
          return;
        }
      } catch (_) {
        return;
      }
      await this.sleep(50);
    }
  }

  private resolveSppDialAddress(jsAddress: string): string {
    const trimmed = String(jsAddress ?? '').trim();
    try {
      const paired = connection.getPairedDevices();
      if (Array.isArray(paired)) {
        for (const id of paired) {
          if (typeof id === 'string' && this.sameBluetoothAddress(id, trimmed)) {
            return id;
          }
        }
      }
    } catch (_) {}
    return trimmed;
  }

  private connectOnce(address: string, secure: boolean, timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const deadline = Date.now() + timeoutMs;
      let timer: number | null = null;

      const clearTimer = (): void => {
        if (timer != null) {
          try {
            clearTimeout(timer);
          } catch (_) {}
          timer = null;
        }
      };

      const fail = (e: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimer();
        reject(e);
      };

      const succeed = (socketId: number): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimer();
        resolve(socketId);
      };

      const scheduleTimeout = (): void => {
        clearTimer();
        const remain = deadline - Date.now();
        if (remain <= 0) {
          fail(new Error(`Connection timeout after ${timeoutMs}ms`));
          return;
        }
        timer = setTimeout(() => {
          fail(new Error(`Connection timeout after ${timeoutMs}ms`));
        }, remain) as unknown as number;
      };

      const attemptConnect = (): void => {
        if (settled) {
          return;
        }
        scheduleTimeout();
        socket.sppConnect(address, { uuid: SPP_UUID, secure, type: SPP_TYPE_RFCOMM }, async (err: any, socketIdMaybe: number) => {
          if (settled) {
            if (!err && typeof socketIdMaybe === 'number' && socketIdMaybe > 0) {
              try { socket.sppCloseClientSocket(socketIdMaybe); } catch (_) {}
            }
            return;
          }

          const socketId = typeof socketIdMaybe === 'number' ? socketIdMaybe : 0;

          if (err) {
            const code = getBusinessErrorCode(err);
            const msg = err?.message ?? err?.errorMessage ?? err?.errMsg ?? err;
            const retryable = code === -1 || String(msg ?? '').toLowerCase().includes('inner error');
            if (retryable && Date.now() + 450 < deadline) {
              clearTimer();
              await this.sleep(400);
              attemptConnect();
              return;
            }
            fail(new Error(`sppConnect error: ${JSON.stringify({ code, message: msg })}`));
            return;
          }

          if (socketId <= 0) {
            if (Date.now() + 500 < deadline) {
              clearTimer();
              await this.sleep(450);
              attemptConnect();
              return;
            }
            fail(new Error(`sppConnect returned invalid socket id: ${socketId}`));
            return;
          }

          succeed(socketId);
        });
      };

      attemptConnect();
    });
  }

  async disconnectFromDevice(address: string): Promise<boolean> {
    this.assertBluetoothAdapterEnabled();
    const pk = this.lookupPrimaryKey(address);
    const rec = this.connectionsByAddress.get(pk);
    if (!rec) {
      throw new Error(`${address} is not currently connected`);
    }
    this.teardownConnection(pk, { expectedSocketId: rec.clientSocket, emitEvent: true });

    return true;
  }

  async isDeviceConnected(address: string): Promise<boolean> {
    this.assertBluetoothAdapterEnabled();
    return this.connectionsByAddress.has(this.lookupPrimaryKey(address));
  }

  async getConnectedDevice(address: string): Promise<BluetoothNativeDeviceSpec> {
    this.assertBluetoothAdapterEnabled();
    const pk = this.lookupPrimaryKey(address);
    if (!this.connectionsByAddress.has(pk)) {
      throw new Error(`${address} is not currently connected`);
    }
    return this.asNativeDevice(pk, { bonded: true });
  }

  async availableFromDevice(address: string): Promise<number> {
    const rec = this.requireConnection(address);
    this.startSppReadForConnection(rec);
    if (rec.connectionMode === 'binary') {
      return rec.binaryLength ?? 0;
    }
    const delimiter = this.getDelimiter(rec.options);
    if (!delimiter) {
      return rec.textBuffer.length;
    }
    return this.countDelimiterOccurrences(rec.textBuffer, delimiter);
  }

  async readFromDevice(address: string): Promise<string> {
    const rec = this.requireConnection(address);
    this.startSppReadForConnection(rec);
    if (rec.connectionMode === 'binary') {
      const len0 = rec.binaryLength ?? 0;
      if (len0 === 0 && (rec.readTimeoutMs ?? 0) > 0) {
        await this.sleep(rec.readTimeoutMs);
      }
      const len = rec.binaryLength ?? 0;
      if (len === 0 || !rec.binaryStorage) {
        return '';
      }
      const slice = rec.binaryStorage.subarray(0, len);
      const out = uint8ArrayToBase64(slice);
      rec.binaryLength = 0;
      return out;
    }

    const delimiter = this.getDelimiter(rec.options);
    if (!delimiter) {
      if (!rec.textBuffer) {
        if ((rec.readTimeoutMs ?? 0) > 0) {
          await this.sleep(rec.readTimeoutMs);
        }
        const s = rec.textBuffer ?? '';
        rec.textBuffer = '';
        return s;
      }
      const s = rec.textBuffer;
      rec.textBuffer = '';
      return s;
    }
    let msg = this.readOneDelimitedMessage(rec, delimiter);
    if (msg === null && (rec.readTimeoutMs ?? 0) > 0) {
      await this.sleep(rec.readTimeoutMs);
      msg = this.readOneDelimitedMessage(rec, delimiter);
    }
    return msg ?? '';
  }

  async clearFromDevice(address: string): Promise<boolean> {
    const rec = this.requireConnection(address);
    this.startSppReadForConnection(rec);
    rec.textBuffer = '';
    rec.binaryLength = 0;
    return true;
  }

  async writeToDevice(address: string, data: string): Promise<boolean> {
    const rec = this.requireConnection(address);
    const pk = rec.address;
    if (!this.isSocketUsable(rec.clientSocket)) {
      try {
        this.handleRemoteDisconnect(pk, rec.clientSocket, 'write on unusable socket');
      } catch (_) {
      }
      throw new Error('Socket is not connected');
    }
    const bytes = base64ToUint8Array(data);
    const out = new Uint8Array(bytes.length);
    out.set(bytes);
    const buf = out.buffer as ArrayBuffer;

    const sppWriteSync = socket.sppWrite as undefined | ((id: number, b: ArrayBuffer) => void);
    const writeOnceSync = () => {
      if (typeof sppWriteSync !== 'function') {
        throw new Error('sppWrite unavailable');
      }
      sppWriteSync(rec.clientSocket, buf);
    };

    const since = Date.now() - (rec.connectedAtMs || 0);
    if (since >= 0 && since < SPP_WRITE_READY_MS) {
      await this.sleep(SPP_WRITE_READY_MS - since);
    }

    try {
      writeOnceSync();
      return true;
    } catch (e) {
      if (isTransientLinkOrWriteError(e)) {
        await this.sleep(SPP_WRITE_RETRY_DELAY_MS);
        try {
          writeOnceSync();
          return true;
        } catch (e2) {
          e = e2;
        }
      }

      const code = getBusinessErrorCode(e);
      const message = getBusinessErrorMessage(e);
      if (isSppIoError(e)) {
        try {
          this.handleRemoteDisconnect(pk, rec.clientSocket, `write IO error: ${String(message ?? '')}`);
        } catch (_) {
        }
      }
      this.emitDeviceEvent('ERROR', {
        device: this.asNativeDevice(pk, { bonded: true }),
        eventType: 'ERROR',
        timestamp: safeNowIso(),
        op: 'writeToDevice',
        code,
        message,
        socketId: rec.clientSocket,
      } as any);
      throw e;
    }
  }

  async requestBluetoothEnabled(): Promise<boolean> {
    try {
      if (await this.isBluetoothEnabled()) {
        return true;
      }
      return await new Promise<boolean>((resolve) => {
        let finished = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const done = (ok: boolean) => {
          if (finished) {
            return;
          }
          finished = true;
          if (timer) {
            clearTimeout(timer);
          }
          try {
            access.off('stateChange', onChange);
          } catch (_) {
          }
          resolve(ok);
        };
        const onChange = (state: number | string) => {
          if (state === 2 || state === 'STATE_ON') {
            done(true);
          }
        };
        access.on('stateChange', onChange);
        access.enableBluetooth();
        timer = setTimeout(() => done(false), 5000);
      });
    } catch (_) {
      return false;
    }
  }

  async setBluetoothAdapterName(_name: string): Promise<boolean> {
    this.assertBluetoothAdapterEnabled();
    console.warn(
      '[RNBluetoothClassic] setBluetoothAdapterName: not supported on Harmony (use system Bluetooth settings to change device name).'
    );
    return false;
  }

  async accept(properties: StandardOptionsSpec): Promise<BluetoothNativeDeviceSpec> {
    this.assertBluetoothAdapterEnabled();
    await this.preflightForOperation('accept');
    if (this.acceptCallInFlight) {
      throw new Error('Bluetooth already in accepting state');
    }
    this.acceptCallInFlight = true;
    this.acceptCancelled = false;

    try {
      this.assertRfcommConnectorOrAcceptor(properties, 'acceptor');
      const connectionMode = this.resolveConnectionMode(properties);
      const readSizeCap = this.resolveReadSizeCap(properties);
      const readTimeoutMs = this.resolveReadTimeoutMs(properties);

      const serviceName = (properties?.serviceName as string) || 'RNBluetoothClassic';
      const secure = this.resolveSppSecure(properties);
      const pair = await this.acceptListenAndAcceptOneClient(serviceName, secure);
      if (!pair) {
        return {
          name: '',
          address: '',
          id: '',
          rssi: -1,
          type: 'classic',
          extra: { _acceptCancelled: true } as Object,
        };
      }
      const { address: remoteAddr, clientSocket } = pair;

      const primaryKey = this.primaryKeyForAcceptedRemote(remoteAddr);
      const existing = this.connectionsByAddress.get(primaryKey);
      if (existing) {
        this.teardownConnection(primaryKey, { expectedSocketId: existing.clientSocket, emitEvent: true });
      }
      this.registerAliasesForPrimary(primaryKey, [remoteAddr, this.canonicalDeviceAddress(remoteAddr), primaryKey]);
      const mergedOptions: StandardOptionsSpec = { ...(properties ?? {}), secureSocket: secure };
      const rec: ConnectionRecord = {
        address: primaryKey,
        clientSocket,
        options: mergedOptions,
        readEventsEnabled: false,
        readListenerCount: 0,
        connectionMode,
        readSizeCap,
        readTimeoutMs,
        textBuffer: '',
        binaryStorage: connectionMode === 'binary' ? new Uint8Array(readSizeCap) : undefined,
        binaryLength: connectionMode === 'binary' ? 0 : undefined,
        connectedAtMs: Date.now(),
      };
      this.connectionsByAddress.set(primaryKey, rec);

      this.startSppReadForConnection(rec);
      this.syncReadSubscriptionStateFromListenerCounts(rec);
      if (rec.readEventsEnabled && rec.readListenerCount > 0) {
        this.flushIncomingTextBuffer(rec);
      }
      this.startSocketStateMonitor(rec);

      this.emitDeviceEvent('DEVICE_CONNECTED', {
        device: this.asNativeDevice(primaryKey, { bonded: true }),
        eventType: 'DEVICE_CONNECTED',
        timestamp: safeNowIso(),
        socketId: clientSocket,
        secureSocket: secure,
      });

      return this.asNativeDevice(primaryKey, { bonded: true });
    } finally {
      this.acceptCallInFlight = false;
    }
  }

  private async getOrCreateSppListenServer(serviceName: string, secure: boolean): Promise<number> {
    const reuse =
      this.acceptServerSocket != null &&
        typeof this.acceptServerSocket === 'number' &&
        this.acceptServerSocket > 0 &&
        this.acceptListenServiceName === serviceName &&
        this.acceptListenSecure === secure;
    if (reuse) {
      return this.acceptServerSocket as number;
    }
    if (this.acceptServerSocket != null) {
      try {
        socket.sppCloseServerSocket(this.acceptServerSocket);
      } catch (e) {
        logBusinessError('getOrCreateSppListenServer/close previous listen', e);
      }
      this.acceptServerSocket = null;
      this.acceptListenServiceName = null;
      this.acceptListenSecure = null;
    }

    const options: socket.SppOptions = {
      uuid: SPP_UUID,
      secure,
      type: SPP_TYPE_RFCOMM,
    };
    const serverSocket = await new Promise<number>((resolve, reject) => {
      try {
        socket.sppListen(serviceName, options, (err: any, number: number) => {
          if (err) {
            reject(new Error(JSON.stringify(err)));
          } else {
            resolve(number);
          }
        });
      } catch (e) {
        reject(e as Error);
      }
    });
    this.acceptServerSocket = serverSocket;
    this.acceptListenServiceName = serviceName;
    this.acceptListenSecure = secure;
    return serverSocket;
  }

  private async waitSppAcceptOneClient(
    serverSocket: number,
    secure: boolean
  ): Promise<{ address: string; clientSocket: number } | null> {
    const acceptOnce = (): Promise<number> =>
    new Promise<number>((resolve, reject) => {
      try {
        socket.sppAccept(serverSocket, (err: any, number: number) => {
          if (this.acceptCancelled) {
            resolve(0);
            return;
          }
          if (err) {
            if (this.acceptCancelled) {
              resolve(0);
              return;
            }
            reject(new Error(JSON.stringify(err)));
            return;
          }
          const n = typeof number === 'number' && !Number.isNaN(number) ? number : 0;
          resolve(n);
        });
      } catch (e) {
        reject(e as Error);
      }
    });

    let clientSocket = 0;
    for (let z = 0; z < 6 && !this.acceptCancelled; z++) {
      const n = await acceptOnce();
      if (this.acceptCancelled) {
        return null;
      }
      if (n > 0) {
        clientSocket = n;
        break;
      }
      if (n < 0) {
        if (this.acceptCancelled) {
          return null;
        }
        this.emitAcceptError(secure, 'sppAccept invalid socket id', n);
        throw new Error(`sppAccept invalid socket id: ${String(n)}`);
      }
      await this.sleep(200);
    }

    if (this.acceptCancelled) {
      return null;
    }
    if (clientSocket <= 0) {
      throw new Error('sppAccept returned invalid socket id: 0');
    }

    let address: string | null = null;
    let prevId: string | null = null;
    for (let i = 0; i < 8; i++) {
      if (i > 0) {
        await this.sleep(150);
      }
      const cur = this.getDeviceIdForSocket(clientSocket);
      if (cur && prevId && this.sameBluetoothAddress(cur, prevId)) {
        address = cur;
        break;
      }
      if (cur) {
        prevId = cur;
      }
    }
    if (!address && prevId) {
      address = prevId;
    }
    if (!address) {
      try {
        socket.sppCloseClientSocket(clientSocket);
      } catch (_) {}
      this.emitAcceptError(secure, 'getDeviceIdForSocket null after accept', clientSocket);
      throw new Error('Accepted socket has no remote address');
    }

    return { address, clientSocket };
  }

  private async acceptListenAndAcceptOneClient(
    serviceName: string,
    secure: boolean
  ): Promise<{ address: string; clientSocket: number } | null> {
    const serverSocket = await this.getOrCreateSppListenServer(serviceName, secure);
    return await this.waitSppAcceptOneClient(serverSocket, secure);
  }

  private emitAcceptError(secure: boolean, message: string, socketId: number): void {
    this.emitDeviceEvent('ERROR', {
      device: { name: '', address: '', id: '', rssi: -1, type: 'classic' } as any,
      eventType: 'ERROR',
      timestamp: safeNowIso(),
      op: 'accept',
      message,
      socketId,
      secureSocket: secure,
    } as any);
  }

  async cancelAccept(): Promise<boolean> {
    this.assertBluetoothAdapterEnabled();
    this.acceptCancelled = true;
    if (this.acceptServerSocket != null) {
      try {
        socket.sppCloseServerSocket(this.acceptServerSocket);
      } catch (_) {
      }
      this.acceptServerSocket = null;
      this.acceptListenServiceName = null;
      this.acceptListenSecure = null;
    }
    return true;
  }

  async startDiscovery(): Promise<BluetoothNativeDeviceSpec[]> {
    this.assertBluetoothAdapterEnabled();
    await this.preflightForOperation('discovery');
    if (this.discoveryActive) {
      throw new Error('Bluetooth in discovery');
    }

    this.discoveryActive = true;
    this.discoveryDevices.clear();

    const onDeviceFind = (ids: string[]) => {
      if (Array.isArray(ids)) {
        for (const addr of ids) {
          if (typeof addr !== 'string' || addr.length === 0) {
            continue;
          }
          const spec = this.asNativeDevice(addr, { bonded: false });
          this.discoveryDevices.set(spec.address, spec);
          this.emitDeviceEvent('DEVICE_DISCOVERED', {
            device: spec,
            eventType: 'DEVICE_DISCOVERED',
            timestamp: safeNowIso(),
          });
        }
      }
    };

    this.deviceFindCallback = onDeviceFind;
    connection.on('bluetoothDeviceFind', onDeviceFind);

    const promise = new Promise<BluetoothNativeDeviceSpec[]>((resolve) => {
      this.discoveryResolve = resolve;
    });

    try {
      this.stopBluetoothDiscovery('startDiscovery/preStop', false);
      connection.startBluetoothDiscovery();
    } catch (e) {
      this.cleanupDiscoverySubscriptions();
      this.discoveryActive = false;
      throw e;
    }

    this.discoveryTimer = setTimeout(() => {
      this.finishDiscoveryResolve();
    }, DISCOVERY_DURATION_MS) as unknown as number;

    return promise;
  }

  private safeIsBluetoothDiscovering(): boolean {
    try {
      return !!connection.isBluetoothDiscovering();
    } catch (_) {
      return false;
    }
  }

  private cancelDiscoveryCore(): boolean {
    const wasRunning = this.discoveryActive || this.safeIsBluetoothDiscovering();
    this.stopBluetoothDiscovery('cancelDiscovery/stop', true);
    if (this.discoveryActive) {
      this.finishDiscoveryResolve();
    }
    return wasRunning;
  }

  async cancelDiscovery(): Promise<boolean> {
    this.assertBluetoothAdapterEnabled();
    return this.cancelDiscoveryCore();
  }

  async pairDevice(address: string): Promise<BluetoothNativeDeviceSpec> {
    this.assertBluetoothAdapterEnabled();
    try {
      const paired = connection.getPairedDevices();
      if (Array.isArray(paired) && paired.some((id) => this.sameBluetoothAddress(id, address))) {
        return this.asNativeDevice(address, { bonded: true });
      }
    } catch (_) {
    }
    await connection.pairDevice(address);
    return this.asNativeDevice(address, { bonded: true });
  }

  async unpairDevice(_address: string): Promise<boolean> {
    this.assertBluetoothAdapterEnabled();
    try {
      const uiCtx = (this as any)?.ctx?.uiAbilityContext as common.UIAbilityContext | undefined;
      if (!uiCtx || typeof uiCtx.startAbility !== 'function') {
        console.warn('[RNBluetoothClassic] unpairDevice: UIAbilityContext unavailable');
        return false;
      }

      uiCtx.startAbility(HMOS_BLUETOOTH_SETTINGS_WANT, (err) => {
        if (err) {
          console.warn(`[RNBluetoothClassic] unpairDevice failed: ${JSON.stringify(err)}`);
        }
      });
      return true;
    } catch (e) {
      console.warn(`[RNBluetoothClassic] unpairDevice threw: ${JSON.stringify(e)}`);
      return false;
    }
  }

  private sameBluetoothAddress(a: string, b: string): boolean {
    const norm = (s: string) => s.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    return norm(a) === norm(b);
  }

  private canonicalDeviceAddress(addr: string): string {
    const raw = String(addr ?? '').trim();
    if (!raw) {
      return raw;
    }
    const hex = raw.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (hex.length !== 12) {
      return raw;
    }
    const parts: string[] = [];
    for (let i = 0; i < 6; i++) {
      parts.push(hex.slice(i * 2, i * 2 + 2));
    }
    return parts.join(':');
  }

  private safeRemoteDeviceName(displayAddr: string, rawAddr: string): string {
    const tryOne = (a: string): string => {
      if (!a) {
        return '';
      }
      try {
        const n = connection.getRemoteDeviceName(a);
        return typeof n === 'string' && n.length > 0 ? n : '';
      } catch (_) {
        return '';
      }
    };
    const n1 = tryOne(displayAddr);
    if (n1) {
      return n1;
    }
    if (rawAddr && rawAddr !== displayAddr) {
      return tryOne(rawAddr);
    }
    return '';
  }

  private registerAliasesForPrimary(primaryKey: string, forms: string[]): void {
    for (const f of forms) {
      const t = String(f ?? '').trim();
      if (t.length > 0) {
        this.addressCanonical.set(t, primaryKey);
      }
      const c = this.canonicalDeviceAddress(t);
      if (c.length > 0 && c !== t) {
        this.addressCanonical.set(c, primaryKey);
      }
    }
  }

  private clearAddressAliasesForPrimary(primaryKey: string): void {
    const dels: string[] = [];
    this.addressCanonical.forEach((v, k) => {
      if (v === primaryKey) {
        dels.push(k);
      }
    });
    for (const k of dels) {
      this.addressCanonical.delete(k);
    }
  }

  private primaryKeyForAcceptedRemote(remoteAddr: string): string {
    const trimmed = String(remoteAddr ?? '').trim();
    if (!trimmed) {
      throw new Error('Accepted remote address is empty');
    }
    const canon = this.canonicalDeviceAddress(trimmed);
    return canon.length > 0 ? canon : trimmed;
  }

  private inferPrimaryKeyForConnection(dial: string): string {
    const trimmed = String(dial ?? '').trim();
    for (const k of this.connectionsByAddress.keys()) {
      if (this.sameBluetoothAddress(k, trimmed)) {
        return k;
      }
    }
    const canon = this.canonicalDeviceAddress(trimmed);
    return canon.length > 0 ? canon : trimmed;
  }

  private lookupPrimaryKey(addr: string): string {
    const trimmed = String(addr ?? '').trim();
    if (!trimmed) {
      return trimmed;
    }
    const via = this.addressCanonical.get(trimmed);
    if (via) {
      return via;
    }
    const canon = this.canonicalDeviceAddress(trimmed);
    const via2 = canon.length > 0 ? this.addressCanonical.get(canon) : undefined;
    if (via2) {
      return via2;
    }
    for (const k of this.connectionsByAddress.keys()) {
      if (this.sameBluetoothAddress(k, trimmed)) {
        this.registerAliasesForPrimary(k, [trimmed, canon]);
        return k;
      }
    }
    return canon.length > 0 ? canon : trimmed;
  }

  private normalizeBtAccessState(state: any): 'on' | 'off' | null {
    if (state === 2 || state === '2' || state === 'STATE_ON') {
      return 'on';
    }
    if (state === 0 || state === '0' || state === 'STATE_OFF') {
      return 'off';
    }
    const s = String(state ?? '');
    const u = s.toUpperCase();
    if (u.includes('TURNING')) {
      return null;
    }
    if (u.includes('STATE_ON') && !u.includes('OFF')) {
      return 'on';
    }
    if (u.includes('STATE_OFF')) {
      return 'off';
    }
    return null;
  }

  private assertBluetoothAdapterEnabled(): void {
    try {
      this.ensureBtStateListener();
      const state = access.getState();
      const n = this.normalizeBtAccessState(state);
      if (this.lastBtStableEmitted === 'off' && n !== 'off') {
        throw new Error('Bluetooth mAdapter is not enabled');
      }
      if (n !== 'on') {
        throw new Error('Bluetooth mAdapter is not enabled');
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'Bluetooth mAdapter is not enabled') {
        throw e instanceof Error ? e : new Error(msg);
      }
      throw new Error('Bluetooth mAdapter is not enabled');
    }
  }

  private emitBtStateChangeFromAccess(state: any): void {
    const stable = this.normalizeBtAccessState(state);
    if (stable === null) {
      return;
    }
    if (this.lastBtStableEmitted === stable) {
      return;
    }
    this.lastBtStableEmitted = stable;
    const name = stable === 'on' ? 'BLUETOOTH_ENABLED' : 'BLUETOOTH_DISABLED';
    this.emitDeviceEvent(name, {
      device: {
        name: '',
        address: '',
        id: '',
        rssi: -1,
        type: 'classic'
      } as any,
      eventType: name,
      timestamp: safeNowIso(),
      state: `${state}`,
      enabled: stable === 'on',
    });
  }

  addListener(requestedEvent: string): void {
    const { eventName, deviceKey } = splitDeviceScopedEvent(requestedEvent);

    if (!this.supportedEvents.has(eventName)) {
      throw new Error(`Unsupported eventType: ${requestedEvent}`);
    }

    const current = this.listenerCounts.get(requestedEvent) ?? 0;
    const next = current + 1;
    this.listenerCounts.set(requestedEvent, next);

    if (eventName === 'DEVICE_READ') {
      if (!deviceKey) {
        throw new Error(`DEVICE_READ requires device context: "DEVICE_READ@<address>"`);
      }
      const rec = this.connectionsByAddress.get(deviceKey);
      if (!rec) {
        throw new Error(`Cannot read from ${requestedEvent}, not currently connected`);
      }
      this.startSppReadForConnection(rec);
      rec.readEventsEnabled = true;
      rec.readListenerCount += 1;
      this.flushIncomingTextBuffer(rec);
      return;
    }

    if (eventName === 'BLUETOOTH_ENABLED' || eventName === 'BLUETOOTH_DISABLED') {
      this.ensureBtStateListener();
    }
  }

  removeListener(requestedEvent: string): void {
    const { eventName, deviceKey } = splitDeviceScopedEvent(requestedEvent);

    if (!this.supportedEvents.has(eventName)) {
      return;
    }

    const current = this.listenerCounts.get(requestedEvent) ?? 0;
    const next = Math.max(0, current - 1);
    this.listenerCounts.set(requestedEvent, next);

    if (eventName === 'DEVICE_READ' && deviceKey) {
      const rec = this.connectionsByAddress.get(deviceKey);
      if (!rec) {
        return;
      }

      rec.readEventsEnabled = false;
      rec.readListenerCount = Math.max(0, rec.readListenerCount - 1);
    }
  }

  removeAllListeners(requestedEvent: string): void {
    const { eventName, deviceKey } = splitDeviceScopedEvent(requestedEvent);

    if (!this.supportedEvents.has(eventName)) {
      return;
    }

    this.listenerCounts.set(requestedEvent, 0);

    if (eventName === 'DEVICE_READ' && deviceKey) {
      const rec = this.connectionsByAddress.get(deviceKey);
      if (rec) {
        rec.readEventsEnabled = false;
        rec.readListenerCount = 0;
      } else {
        throw new Error(`Cannot read from ${eventName}, not currently connected`);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private getDelimiter(options: StandardOptionsSpec | undefined): string {
    const d = options?.delimiter;
    if (typeof d === 'string') {
      return d;
    }
    return '\n';
  }

  private getCharsetOption(options: StandardOptionsSpec | undefined): string | number | undefined {
    const v = options?.charset as string | number | undefined;
    if (typeof v === 'string' || typeof v === 'number') {
      return v;
    }
    return undefined;
  }

  private countDelimiterOccurrences(buffer: string, delimiter: string): number {
    if (!buffer || !delimiter) {
      return 0;
    }
    let count = 0;
    let lastIndex = -1;
    while (true) {
      lastIndex = buffer.indexOf(delimiter, lastIndex + 1);
      if (lastIndex < 0) {
        break;
      }
      count++;
    }
    return count;
  }

  private readOneDelimitedMessage(rec: ConnectionRecord, delimiter: string): string | null {
    if (!delimiter) {
      const all = rec.textBuffer ?? '';
      rec.textBuffer = '';
      return all;
    }
    const buf = rec.textBuffer ?? '';
    const idx = buf.indexOf(delimiter, 0);
    if (idx < 0) {
      return null;
    }
    const msg = buf.substring(0, idx);
    rec.textBuffer = buf.substring(idx + delimiter.length);
    return msg;
  }

  private requireConnection(address: string): ConnectionRecord {
    this.assertBluetoothAdapterEnabled();
    const pk = this.lookupPrimaryKey(address);
    const rec = this.connectionsByAddress.get(pk);
    if (!rec) {
      throw new Error(`${address} is not currently connected`);
    }
    return rec;
  }

  private syncReadSubscriptionStateFromListenerCounts(rec: ConnectionRecord): void {
    const prefix = 'DEVICE_READ@';
    let total = 0;
    for (const [key, count] of this.listenerCounts.entries()) {
      if (count <= 0 || !key.startsWith(prefix)) {
        continue;
      }
      const deviceKey = key.substring(prefix.length);
      if (!deviceKey) {
        continue;
      }
      const pk = this.lookupPrimaryKey(deviceKey);
      if (pk === rec.address) {
        total += count;
      }
    }
    rec.readListenerCount = total;
    rec.readEventsEnabled = total > 0;
  }

  private flushIncomingTextBuffer(rec: ConnectionRecord): void {
    if (rec.connectionMode === 'binary') {
      return;
    }
    const delimiter = this.getDelimiter(rec.options);
    if (!delimiter) {
      if (rec.readEventsEnabled && rec.readListenerCount > 0 && (rec.textBuffer?.length ?? 0) > 0) {
        const msg = rec.textBuffer ?? '';
        rec.textBuffer = '';
        this.emitDeviceReadForConnection(rec, {
          device: this.asNativeDevice(rec.address, { bonded: true }),
          eventType: 'DEVICE_READ',
          timestamp: safeNowIso(),
          data: msg,
        });
      }
      return;
    }
    if (!rec.readEventsEnabled || rec.readListenerCount <= 0) {
      return;
    }
    while (true) {
      const idx = rec.textBuffer.indexOf(delimiter);
      if (idx < 0) {
        break;
      }
      const msg = rec.textBuffer.substring(0, idx);
      rec.textBuffer = rec.textBuffer.substring(idx + delimiter.length);
      this.emitDeviceReadForConnection(rec, {
        device: this.asNativeDevice(rec.address, { bonded: true }),
        eventType: 'DEVICE_READ',
        timestamp: safeNowIso(),
        data: msg,
      });
    }
  }

  private getDeviceIdForSocket(clientSocket: number): string | null {
    try {
      const s: any = socket as any;
      const names = ['getDeviceId', 'getDeviceIdSync', 'getRemoteDeviceId', 'getRemoteDeviceIdSync', 'getDeviceAddress', 'getDeviceAddressSync'];
      for (let i = 0; i < names.length; i++) {
        const fn = s[names[i]];
        if (typeof fn === 'function') {
          const v = fn.call(s, clientSocket);
          if (typeof v === 'string' && v.length > 0) {
            return v;
          }
        }
      }
    } catch (_) {
    }
    return null;
  }

  private asNativeDevice(
    address: string,
    overrides?: Partial<BluetoothNativeDeviceSpec> & { rssi?: number; name?: string; type?: string; extra?: Object }
  ): BluetoothNativeDeviceSpec {
    const displayAddr = this.canonicalDeviceAddress(address) || address;
    const name = overrides?.name ?? this.safeRemoteDeviceName(displayAddr, address);
    const cls = this.safeRemoteClass(displayAddr);

    return {
      name,
      address: displayAddr,
      id: displayAddr,
      bonded: overrides?.bonded ?? undefined,
      deviceClass: cls ?? undefined,
      rssi: overrides?.rssi ?? -1,
      type: overrides?.type ?? 'classic',
      extra: overrides?.extra ?? undefined,
    };
  }

  private safeRemoteClass(address: string): TM.RNBluetoothClassic.BluetoothDeviceClass | null {
    try {
      const dc: any = connection.getRemoteDeviceClass(address);
      const major = typeof dc?.majorClass === 'number' ? dc.majorClass : 0;
      const deviceClass =
        typeof dc?.minorClass === 'number' ? dc.minorClass : typeof dc?.deviceClass === 'number' ? dc.deviceClass : 0;
      return { majorClass: major, deviceClass };
    } catch (_) {
      return null;
    }
  }

  private emitDeviceEvent(eventName: string, body: Object): void {
    const rnInstance = (this as any)?.ctx?.rnInstance;
    if (rnInstance && typeof rnInstance.emitDeviceEvent === 'function') {
      rnInstance.emitDeviceEvent(eventName, body);
    }
  }

  private emitDeviceReadForConnection(rec: ConnectionRecord, body: Object): void {
    const names = new Set<string>();
    names.add(`DEVICE_READ@${rec.address}`);
    this.addressCanonical.forEach((primaryKey, aliasKey) => {
      if (primaryKey === rec.address) {
        names.add(`DEVICE_READ@${aliasKey}`);
      }
    });
    const rnInstance = (this as any)?.ctx?.rnInstance;
    if (!rnInstance || typeof rnInstance.emitDeviceEvent !== 'function') {
      return;
    }
    for (const ev of names) {
      const n = this.listenerCounts.get(ev) ?? 0;
      if (n <= 0) {
        continue;
      }
      rnInstance.emitDeviceEvent(ev, body);
    }
  }

  private ensureBtStateListener(): void {
    if (this.btStateCallback) {
      return;
    }
    this.btStateCallback = (state: any) => {
      this.emitBtStateChangeFromAccess(state);

      const stable = this.normalizeBtAccessState(state);
      if (stable === 'off' && this.discoveryActive) {
        this.finishDiscoveryResolve();
      }
    };
    try {
      access.on('stateChange' as any, this.btStateCallback as any);
    } catch (_) {
    }
    try {
      const initial = this.normalizeBtAccessState(access.getState());
      if (initial === 'on' || initial === 'off') {
        this.lastBtStableEmitted = initial;
      }
    } catch (_) {
    }
  }

  private startSppReadForConnection(rec: ConnectionRecord): void {
    if (rec.sppReadCallback) {
      return;
    }

    const cb = (dataBuffer: ArrayBuffer) => {
      const bytes = new Uint8Array(dataBuffer);
      if (rec.connectionMode === 'binary') {
        if (bytes.length === 0) {
          return;
        }
        try {
          this.appendBinaryChunk(rec, bytes);
          if (rec.readEventsEnabled && rec.readListenerCount > 0) {
            const len = rec.binaryLength ?? 0;
            if (len > 0 && rec.binaryStorage) {
              const data = uint8ArrayToBase64(rec.binaryStorage.subarray(0, len));
              rec.binaryLength = 0;
              this.emitDeviceReadForConnection(rec, {
                device: this.asNativeDevice(rec.address, { bonded: true }),
                eventType: 'DEVICE_READ',
                timestamp: safeNowIso(),
                data,
              });
            }
          }
        } catch (e) {
          logBusinessError(`sppRead binary addr=${rec.address}`, e);
          try {
            this.handleRemoteDisconnect(rec.address, rec.clientSocket, `binary read: ${String(e)}`);
          } catch (_) {}
        }
        return;
      }

      const chunkText = uint8ArrayToString(bytes, this.getCharsetOption(rec.options));
      if (!chunkText) {
        return;
      }

      rec.textBuffer = (rec.textBuffer ?? '') + chunkText;
      if (rec.textBuffer.length > MAX_BUFFER_CHARS) {
        rec.textBuffer = rec.textBuffer.slice(rec.textBuffer.length - MAX_BUFFER_CHARS);
      }

      const delimiter = this.getDelimiter(rec.options);
      if (!delimiter) {
        this.flushIncomingTextBuffer(rec);
        return;
      }
      if (!rec.readEventsEnabled || rec.readListenerCount <= 0) {
        return;
      }
      this.flushIncomingTextBuffer(rec);
    };

    rec.sppReadCallback = cb;
    try {
      socket.on('sppRead', rec.clientSocket, cb);
    } catch (e) {
      rec.sppReadCallback = undefined;
      logBusinessError(`startSppReadForConnection/socket.on addr=${rec.address} socket=${rec.clientSocket}`, e);
    }
  }

  private stopSppReadIfNeeded(rec: ConnectionRecord): void {
    if (!rec.sppReadCallback) {
      return;
    }
    try {
      socket.off('sppRead', rec.clientSocket, rec.sppReadCallback);
    } catch (_) {
      try {
        socket.off('sppRead', rec.clientSocket);
      } catch (_) {
      }
    }
    rec.sppReadCallback = undefined;
  }

  private startSocketStateMonitor(rec: ConnectionRecord): void {
    if (rec.socketStateTimer != null) {
      return;
    }
    const socketObj: any = socket as any;
    if (typeof socketObj.getSocketState !== 'function') {
      return;
    }

    const isDisconnectedState = (state: any): boolean => {
      if (state == null) {
        return false;
      }
      if (typeof state === 'number') {
        return socketStateNumericLooksDisconnected(state);
      }
      return socketStateStringLooksDisconnected(String(state));
    };

    const timer = setInterval(() => {
      const current = this.connectionsByAddress.get(rec.address);
      if (!current || current.clientSocket !== rec.clientSocket) {
        try {
          clearInterval(timer);
        } catch (_) {
        }
        return;
      }
      try {
        const state = socketObj.getSocketState(rec.clientSocket);
        if (isDisconnectedState(state)) {
          this.handleRemoteDisconnect(rec.address, rec.clientSocket, `state=${String(state)}`);
        }
      } catch (e) {
        this.handleRemoteDisconnect(rec.address, rec.clientSocket,
          `getSocketState threw: ${String((e as any)?.message ?? e)}`);
      }
    }, 1000) as unknown as number;

    rec.socketStateTimer = timer;
  }

  private stopSocketStateMonitor(rec: ConnectionRecord): void {
    if (rec.socketStateTimer == null) {
      return;
    }
    clearInterval(rec.socketStateTimer);
    rec.socketStateTimer = undefined;
  }

  private handleRemoteDisconnect(address: string, socketId: number, reason: string): void {
    if (!this.connectionsByAddress.has(address)) {
      return;
    }
    console.warn(`[RNBluetoothClassic] Remote disconnected: ${address} socket=${socketId} (${reason})`);
    this.teardownConnection(address, { expectedSocketId: socketId, emitEvent: true });
  }

  private shouldReuseExistingConnection(rec: ConnectionRecord): boolean {
    const socketId = rec.clientSocket;
    if (typeof socketId !== 'number' || socketId <= 0) {
      return false;
    }
    try {
      const socketObj: any = socket as any;
      if (typeof socketObj.getSocketState !== 'function') {
        return true;
      }
      const state = socketObj.getSocketState(socketId);
      if (state == null) {
        return false;
      }
      if (typeof state === 'number') {
        return !socketStateNumericLooksDisconnected(state);
      }
      return !socketStateStringLooksDisconnected(String(state));
    } catch (_) {
      return false;
    }
  }

  private isSocketUsable(socketId: number): boolean {
    if (typeof socketId !== 'number' || socketId <= 0) {
      return false;
    }
    try {
      const socketObj: any = socket as any;
      if (typeof socketObj.getSocketState !== 'function') {
        return true;
      }
      const state = socketObj.getSocketState(socketId);
      if (state == null) {
        return false;
      }
      if (typeof state === 'number') {
        return !socketStateNumericLooksDisconnected(state);
      }
      return !socketStateStringLooksDisconnected(String(state));
    } catch (_) {
      return false;
    }
  }

  private async assertFreshSppOutboundSocketOrThrow(clientSocket: number): Promise<void> {
    const socketObj: any = socket as any;
    if (typeof socketObj.getSocketState !== 'function') {
      return;
    }
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      let state: any;
      try {
        state = socketObj.getSocketState(clientSocket);
      } catch (e) {
        try {
          socket.sppCloseClientSocket(clientSocket);
        } catch (_) {}
        throw new Error(`Bluetooth SPP socket state check failed: ${String((e as any)?.message ?? e)}`);
      }
      if (state != null) {
        if (typeof state === 'number' && socketStateNumericLooksDisconnected(state)) {
          try {
            socket.sppCloseClientSocket(clientSocket);
          } catch (_) {}
          throw new Error(
            'Bluetooth SPP is not connected — the remote has no RFCOMM listener (start accept on the server) or the server app was closed.'
          );
        }
        if (typeof state !== 'number' && socketStateStringLooksDisconnected(String(state))) {
          try {
            socket.sppCloseClientSocket(clientSocket);
          } catch (_) {}
          throw new Error(
            'Bluetooth SPP is not connected — the remote has no RFCOMM listener (start accept on the server) or the server app was closed.'
          );
        }
      }
      if (this.isSocketUsable(clientSocket)) {
        return;
      }
      await this.sleep(60);
    }
  }

  private pruneStaleConnections(): void {
    if (this.connectionsByAddress.size === 0) {
      return;
    }
    for (const [address, rec] of this.connectionsByAddress.entries()) {
      if (this.shouldReuseExistingConnection(rec)) {
        continue;
      }
      this.teardownConnection(address, { expectedSocketId: rec.clientSocket, emitEvent: true });
    }
  }

  private async preflightForOperation(op: 'connect' | 'accept' | 'discovery'): Promise<void> {
    if (op !== 'accept') {
      this.pruneStaleConnections();
    }
    if (op === 'connect' || op === 'accept') {
      await this.stopDiscoveryAndWait();
    }
  }

  private teardownConnection(
    address: string,
    options?: { expectedSocketId?: number; emitEvent?: boolean }
  ): boolean {
    const rec = this.connectionsByAddress.get(address);
    if (!rec) {
      return false;
    }
    if (typeof options?.expectedSocketId === 'number' && rec.clientSocket !== options.expectedSocketId) {
      return false;
    }

    try {
      this.stopSppReadIfNeeded(rec);
      this.stopSocketStateMonitor(rec);
    } catch (err) {
      logBusinessError(`teardownConnection/stopReadOrMonitor ${address}`, err);
    }
    this.connectionsByAddress.delete(address);
    this.clearAddressAliasesForPrimary(address);
    try {
      socket.sppCloseClientSocket(rec.clientSocket);
    } catch (err) {
      logBusinessError(`teardownConnection/sppCloseClientSocket ${address}`, err);
    }

    if (options?.emitEvent !== false) {
      this.emitDeviceEvent('DEVICE_DISCONNECTED', {
        device: this.asNativeDevice(address, { bonded: true }),
        eventType: 'DEVICE_DISCONNECTED',
        timestamp: safeNowIso(),
      });
    }
    return true;
  }

  private finishDiscoveryResolve(): void {
    if (!this.discoveryActive) {
      return;
    }
    this.discoveryActive = false;
    if (this.discoveryTimer != null) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    this.stopBluetoothDiscovery('finishDiscoveryResolve/stop', true);
    this.cleanupDiscoverySubscriptions();
    const list = Array.from(this.discoveryDevices.values());
    this.discoveryResolve?.(list);
    this.discoveryResolve = null;
  }

  private cleanupDiscoverySubscriptions(): void {
    if (this.deviceFindCallback) {
      try {
        connection.off('bluetoothDeviceFind', this.deviceFindCallback);
      } catch (_) {
      }
      this.deviceFindCallback = null;
    }
  }
}