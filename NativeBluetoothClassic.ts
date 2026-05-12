import type { TurboModule } from 'react-native/Libraries/TurboModule/RCTExport';
import { TurboModuleRegistry } from 'react-native';

export type BluetoothDeviceClass = {
  deviceClass: number;
  majorClass: number;
};
export type BluetoothNativeDeviceSpec = {
  name: string;
  address: string;
  id: string;
  bonded?: boolean;
  deviceClass?: BluetoothDeviceClass;
  rssi: number;
  type: string;
  extra?: Object;
};
export type StandardOptionsSpec = {
  connectorType?: string;
  acceptorType?: string;
  connectionType?: string;
  delimiter?: string;
  charset?: string | number;
  readTimeout?: number;
  readSize?: number;
  secureSocket?: boolean;
  serviceName?: string;
};

export interface Spec extends TurboModule {
openBluetoothSettings(): void;
isBluetoothAvailable(): Promise<boolean>;
isBluetoothEnabled(): Promise<boolean>;
getBondedDevices(): Promise<Array<BluetoothNativeDeviceSpec>>;
getConnectedDevices(): Promise<Array<BluetoothNativeDeviceSpec>>;
connectToDevice(address: string, properties?: StandardOptionsSpec): Promise<BluetoothNativeDeviceSpec>;
disconnectFromDevice(address: string): Promise<boolean>;
isDeviceConnected(address: string): Promise<boolean>;
getConnectedDevice(address: string): Promise<BluetoothNativeDeviceSpec>;
availableFromDevice(address: string): Promise<number>;
readFromDevice(address: string): Promise<string>;
clearFromDevice(address: string): Promise<boolean>;
writeToDevice(address: string, data: string): Promise<boolean>;
requestBluetoothEnabled(): Promise<boolean>;
setBluetoothAdapterName(name: string): Promise<boolean>;
accept(properties: StandardOptionsSpec): Promise<BluetoothNativeDeviceSpec>;
cancelAccept(): Promise<boolean>;
startDiscovery(): Promise<Array<BluetoothNativeDeviceSpec>>;
cancelDiscovery(): Promise<boolean>;
pairDevice(address: string): Promise<BluetoothNativeDeviceSpec>;
unpairDevice(address: string): Promise<boolean>;
addListener(eventType: string): void;
removeListener(eventType: string): void;
removeAllListeners(eventType: string): void;
}
export default TurboModuleRegistry.get<Spec>('RNBluetoothClassic') as Spec | null;