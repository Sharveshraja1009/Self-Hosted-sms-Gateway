package com.smsgateway

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers SmsGatewayModule with React Native.
 *
 * `BaseReactPackage` is the TurboModule-aware base: modules are constructed
 * lazily, on first use from JS, rather than eagerly at startup. For this module
 * that laziness is load-bearing - its constructor registers broadcast receivers,
 * and doing that before the app has decided whether it is even configured would
 * be wasted work on every cold start.
 */
class SmsGatewayPackage : BaseReactPackage() {

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == SmsGatewayModule.NAME) SmsGatewayModule(reactContext) else null

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(
            SmsGatewayModule.NAME to ReactModuleInfo(
                SmsGatewayModule.NAME,
                SmsGatewayModule.NAME,
                false, // canOverrideExistingModule
                false, // needsEagerInit
                false, // isCxxModule
                true, // isTurboModule
            ),
        )
    }
}
