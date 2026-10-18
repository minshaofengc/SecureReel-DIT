// SPDX-License-Identifier: GPL-3.0-only
package com.securereelmobile.nativebridge
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
class SecureReelPackage: BaseReactPackage() {
  override fun getModule(name: String,context: ReactApplicationContext): NativeModule? = if(name=="SecureReel")SecureReelModule(context)else null
  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider { mapOf("SecureReel" to ReactModuleInfo("SecureReel","SecureReel",false,false,false,true)) }
}
