// SPDX-License-Identifier: GPL-3.0-only
package com.securereelmobile.nativebridge
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import com.facebook.react.bridge.*
import org.json.JSONObject
import java.util.concurrent.Executors
class SecureReelModule(private val context: ReactApplicationContext): NativeSecureReelSpec(context), ActivityEventListener, LifecycleEventListener {
  private val engine=JobEngine.get(context)
  private val peer=PeerClient(context)
  private val archive=ReportArchive(context,engine)
  private val io=Executors.newFixedThreadPool(2)
  private val controls=Executors.newSingleThreadExecutor()
  private var picker: Promise?=null
  private var pickerRole="source"
  private var storagePromise: Promise?=null
  private var storagePaused=false
  init { context.addActivityEventListener(this);context.addLifecycleEventListener(this) }
  override fun getName()="SecureReel"
  private fun work(promise: Promise, executor: java.util.concurrent.Executor=io, action: ()->Any?) { executor.execute { try { promise.resolve(action()) }catch(e: Exception){
    if(e is PeerFailure){promise.reject(e.code,e.message);return@execute}
    if(e.message=="Pairing expired"){promise.reject("PAIRING_EXPIRED","二维码已过期，请在电脑上重新生成");return@execute}
    val unsupported=e.message=="This provider cannot guarantee safe no-overwrite copy. Use read-only verification."
    val safetyMessages=setOf("来源和目标位于同一存储卷","目标剩余容量未知，无法开始拷贝","共享容量不足","存储风险或位置已改变，请重新预检并明确确认","来源和目标不能选择同一个文件夹","目标写入授权不可用，请重新选择","请授予全部文件访问权限后拷贝")
    val safety=e.message?.split("；")?.all { it in safetyMessages }==true
    val message=when {
      safety -> e.message!!
      unsupported -> "该存储位置暂不支持安全拷贝，可以使用仅校验"
      e.message=="Reports require a finished task" -> "任务结束后才能生成报告"
      e.message?.startsWith("目标盘空间不足：")==true -> e.message!!
      e.message=="来源和目标不能选择同一个文件夹" -> e.message!!
      else -> "操作未完成，请检查目录授权、外设或电脑连接"
    }
    promise.reject(if(safety)"PREFLIGHT_REQUIRED" else if(unsupported)"UNSUPPORTED_VERIFIED_COMMIT" else "NATIVE_OPERATION_FAILED",message)
  } } }
  override fun pickRoot(role: String,promise: Promise) {
    if(role !in listOf("source","target")){promise.reject("INVALID_INPUT","Invalid folder role");return}
    context.runOnUiQueueThread {
      val activity=getCurrentActivity()
      if(activity==null||picker!=null){promise.reject("PICKER_UNAVAILABLE","Folder picker unavailable");return@runOnUiQueueThread}
      picker=promise;pickerRole=role
      val flags=Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION or (if(role=="target")Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
      try { activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(flags),4801) }
      catch(e: Exception){picker=null;promise.reject("PICKER_UNAVAILABLE","Folder picker unavailable")}
    }
  }
  override fun onActivityResult(activity: Activity,requestCode: Int,resultCode: Int,data: Intent?) {
    if(requestCode==4802){val pending=scanner;scanner=null;if(resultCode==Activity.RESULT_OK)pending?.resolve(data?.getStringExtra("code"))else pending?.reject(data?.getStringExtra("errorCode") ?: "SCAN_CANCELLED",data?.getStringExtra("error") ?: "已取消扫码");return}
    if(requestCode!=4801)return
    val promise=picker ?: return;picker=null
    val uri=data?.data
    if(resultCode!=Activity.RESULT_OK||uri==null){promise.reject("PICKER_CANCELLED","Folder selection cancelled");return}
    val role=pickerRole
    work(promise){
      val granted=(data?.flags ?: 0) and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      require(granted and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
      if(role=="source" || granted and Intent.FLAG_GRANT_WRITE_URI_PERMISSION == 0)
        context.contentResolver.takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION)
      else
        context.contentResolver.takePersistableUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      engine.authorize(uri,role).toString()
    }
  }
  override fun onNewIntent(intent: Intent) {}
  override fun storageAccess(promise: Promise) { promise.resolve(Environment.isExternalStorageManager()) }
  override fun requestStorageAccess(promise: Promise) {
    context.runOnUiQueueThread {
      if(Environment.isExternalStorageManager()){promise.resolve(true);return@runOnUiQueueThread}
      val activity=getCurrentActivity()
      if(activity==null||storagePromise!=null){promise.reject("SETTINGS_UNAVAILABLE","System storage settings unavailable");return@runOnUiQueueThread}
      storagePromise=promise;storagePaused=false
      try { activity.startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,Uri.parse("package:"+context.packageName))) }
      catch(e: Exception){storagePromise=null;promise.reject("SETTINGS_UNAVAILABLE","System storage settings unavailable")}
    }
  }
  override fun onHostPause() { if(storagePromise!=null)storagePaused=true }
  override fun onHostResume() { if(storagePaused){val promise=storagePromise;storagePromise=null;storagePaused=false;promise?.resolve(Environment.isExternalStorageManager())} }
  override fun onHostDestroy() { storagePromise?.reject("SETTINGS_UNAVAILABLE","Storage settings closed");storagePromise=null }

  override fun roots(probeCopyTargets: Boolean,promise: Promise)=work(promise){engine.roots(probeCopyTargets).toString()}
  override fun forgetRoot(rootId: String,promise: Promise)=work(promise){engine.forgetRoot(rootId);null}
  override fun preflightJob(draft: String,promise: Promise)=work(promise){require(draft.length<=65536);engine.preflight(draft).toString()}
  override fun createJob(draft: String,promise: Promise)=work(promise){require(draft.length<=65536);engine.create(draft).toString()}
  override fun control(jobId: String,action: String,promise: Promise)=work(promise,controls){engine.control(jobId,action).toString()}
  override fun getJob(jobId: String,promise: Promise)=work(promise){engine.getJob(jobId).toString()}
  override fun snapshot(promise: Promise)=work(promise){engine.snapshot().toString()}
  override fun saveProject(project: String,promise: Promise)=work(promise){engine.saveProject(project).toString()}
  override fun getSettings(promise: Promise)=work(promise){engine.getSettings().toString()}
  override fun saveSettings(settings: String,promise: Promise)=work(promise){engine.saveSettings(settings).toString()}
  override fun pendingMutation(key: String,body: String,promise: Promise)=work(promise){engine.pendingMutation(key,body).toString()}
  override fun getPendingMutation(key: String,promise: Promise)=work(promise){engine.getPendingMutation(key)?.toString() ?: "null"}
  override fun completeMutation(key: String,promise: Promise)=work(promise){engine.completeMutation(key);null}
  override fun runtimeStatus(promise: Promise) { val manager=context.getSystemService(android.app.NotificationManager::class.java);val power=context.getSystemService(android.os.PowerManager::class.java);promise.resolve(JSONObject().put("notificationsEnabled",manager.areNotificationsEnabled()).put("batteryUnrestricted",power.isIgnoringBatteryOptimizations(context.packageName)).toString()) }
  override fun requestNotifications(promise: Promise) { context.runOnUiQueueThread { val activity=getCurrentActivity();if(activity==null){promise.reject("SETTINGS_UNAVAILABLE","请先返回应用页面");return@runOnUiQueueThread};if(android.os.Build.VERSION.SDK_INT<33||context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)==android.content.pm.PackageManager.PERMISSION_GRANTED){promise.resolve(true)}else if(activity is com.facebook.react.modules.core.PermissionAwareActivity){activity.requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),4803,com.facebook.react.modules.core.PermissionListener { code,_,results -> if(code==4803){promise.resolve(results.firstOrNull()==android.content.pm.PackageManager.PERMISSION_GRANTED);true}else false })}else promise.resolve(false) } }
  override fun openBatterySettings(promise: Promise) { context.runOnUiQueueThread { try { getCurrentActivity()?.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) ?: error("No activity");promise.resolve(null) }catch(e: Exception){promise.reject("SETTINGS_UNAVAILABLE","无法打开系统电池设置")} } }
  override fun setKeepScreenOn(enabled: Boolean,promise: Promise) { context.runOnUiQueueThread { getCurrentActivity()?.window?.let { if(enabled)it.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)else it.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) };promise.resolve(null) } }
  private var scanner: Promise?=null
  override fun scanPairingCode(promise: Promise) { context.runOnUiQueueThread { val activity=getCurrentActivity();if(activity==null||scanner!=null){promise.reject("SCAN_UNAVAILABLE","扫码页面暂不可用");return@runOnUiQueueThread};scanner=promise;activity.startActivityForResult(Intent(activity,PairingScannerActivity::class.java),4802) } }
  override fun saveReport(jobId: String,bundle: String,promise: Promise)=work(promise){archive.save(jobId,bundle).toString()}
  override fun reports(jobId: String,promise: Promise)=work(promise){archive.reports(jobId).toString()}
  override fun shareReport(reportId: String,kind: String,promise: Promise)=work(promise){archive.share(reportId,kind)}
  override fun pairPeer(setup: String,deviceName: String,promise: Promise)=work(promise){require(setup.length<=4096);peer.pair(setup,deviceName).toString()}
  override fun peerInfo(promise: Promise)=work(promise){peer.info().toString()}
  override fun forgetPeer(promise: Promise)=work(promise){peer.forget();null}
  override fun peerRequest(method: String,path: String,body: String,promise: Promise)=work(promise){String(peer.request(method,path,body),Charsets.UTF_8)}
  override fun sharePeerReport(path: String,promise: Promise)=work(promise){require(path.matches(Regex("/api/v1/reports/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/(html|json|pdf)")));archive.sharePeer(peer.request("GET",path,""),path.substringAfterLast('/'))}
  override fun invalidate() { context.removeActivityEventListener(this);context.removeLifecycleEventListener(this);onHostDestroy();scanner?.reject("SCAN_CANCELLED","扫码页面已关闭");scanner=null;picker?.reject("PICKER_UNAVAILABLE","Folder picker closed");picker=null;super.invalidate() }
}
