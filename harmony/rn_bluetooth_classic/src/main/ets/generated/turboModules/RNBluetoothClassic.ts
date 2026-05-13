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

import { Tag } from "@rnoh/react-native-openharmony/ts"

export namespace RNBluetoothClassic {
  export const NAME = 'RNBluetoothClassic' as const

  export type BluetoothDeviceClass = {deviceClass: number, majorClass: number}
  
  export type BluetoothNativeDeviceSpec = {name: string, address: string, id: string, bonded?: boolean, deviceClass?: BluetoothDeviceClass, rssi: number, type: string, extra?: Object}
  
  export type StandardOptionsSpec = {connectorType?: string, acceptorType?: string, connectionType?: string, delimiter?: string, charset?: Object, readTimeout?: number, readSize?: number, secureSocket?: boolean, serviceName?: string}
  
  export interface Spec {
    openBluetoothSettings(): void;
  
    isBluetoothAvailable(): Promise<boolean>;
  
    isBluetoothEnabled(): Promise<boolean>;
  
    getBondedDevices(): Promise<BluetoothNativeDeviceSpec[]>;
  
    getConnectedDevices(): Promise<BluetoothNativeDeviceSpec[]>;
  
    connectToDevice(address: string, properties: StandardOptionsSpec): Promise<BluetoothNativeDeviceSpec>;
  
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
  
    startDiscovery(): Promise<BluetoothNativeDeviceSpec[]>;
  
    cancelDiscovery(): Promise<boolean>;
  
    pairDevice(address: string): Promise<BluetoothNativeDeviceSpec>;
  
    unpairDevice(address: string): Promise<boolean>;
  
    addListener(eventType: string): void;
  
    removeListener(eventType: string): void;
  
    removeAllListeners(eventType: string): void;
  
  }
}
