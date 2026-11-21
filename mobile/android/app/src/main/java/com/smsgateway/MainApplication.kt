package com.smsgateway

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Our own TurboModule. Autolinking only discovers packages in
          // node_modules; a module that lives inside the app must be added here by
          // hand, or `TurboModuleRegistry.getEnforcing('SmsGateway')` throws at
          // startup with a message that does not mention this file at all.
          add(SmsGatewayPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
