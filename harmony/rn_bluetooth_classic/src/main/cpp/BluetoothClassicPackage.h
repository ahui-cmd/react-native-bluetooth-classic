#pragma once

#include "RNOH/generated/BaseReactNativeBluetoothClassicPackage.h"

namespace rnoh {

class BluetoothClassicPackage : public BaseReactNativeBluetoothClassicPackage {
    using Super = BaseReactNativeBluetoothClassicPackage;

public:
    BluetoothClassicPackage(Package::Context ctx) : Super(ctx) {}
};

} // namespace rnoh