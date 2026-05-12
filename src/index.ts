import { NativeModules , TurboModuleRegistry } from 'react-native';
import BluetoothDevice from './BluetoothDevice';
import BluetoothError from './BluetoothError';
import {
  BluetoothEvent,
  BluetoothDeviceEvent,
  BluetoothDeviceReadEvent,
  BluetoothEventListener,
  BluetoothEventSubscription,
  BluetoothEventType,
} from './BluetoothEvent';
import BluetoothModule from './BluetoothModule';
import BluetoothNativeDevice from './BluetoothNativeDevice';
import BluetoothNativeModule, { StandardOptions } from './BluetoothNativeModule';

const nativeBluetoothClassic = (() => {
  try {
    const fromTurbo = TurboModuleRegistry.get(
      'RNBluetoothClassic',
    ) as BluetoothNativeModule | null | undefined;
    if (fromTurbo != null) {
      return fromTurbo;
    }
  } catch {
  }
  return NativeModules.RNBluetoothClassic as BluetoothNativeModule;
})();

export default new BluetoothModule(nativeBluetoothClassic);

export type {
  BluetoothDevice,
  BluetoothError,
  BluetoothEvent,
  BluetoothDeviceEvent,
  BluetoothDeviceReadEvent,
  BluetoothEventListener,
  BluetoothEventSubscription,
  BluetoothEventType,
  BluetoothNativeDevice,
  BluetoothNativeModule,
  StandardOptions,
};
