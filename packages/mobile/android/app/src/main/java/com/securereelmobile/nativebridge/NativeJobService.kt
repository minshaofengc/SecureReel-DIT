// SPDX-License-Identifier: GPL-3.0-only
package com.securereelmobile.nativebridge
import android.app.*
import android.content.Intent
import android.os.*
import android.content.pm.ServiceInfo
import com.securereelmobile.R
internal class NativeJobService: Service() {
  private val handler=Handler(Looper.getMainLooper())
  private lateinit var wake: PowerManager.WakeLock
  private val update=object: Runnable {override fun run(){refresh();handler.postDelayed(this,2000)}}
  override fun onCreate() {
    super.onCreate()
    wake=getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"SecureReel:offload").apply {setReferenceCounted(false)}
    getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("offload","拷贝与校验进度",NotificationManager.IMPORTANCE_LOW))
    startForeground(412,notification(),ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    handler.post(update)
  }
  private fun notification(): Notification {
    val jobs=JobEngine.get(this).snapshot().getJSONArray("jobs")
    val active=ProjectData.notificationJob(jobs)
    val builder=Notification.Builder(this,"offload").setContentTitle(if(active?.optString("mode")=="verify")"本机校验进行中" else "本机拷贝进行中").setSmallIcon(R.drawable.ic_notification).setOngoing(true)
    val open=packageManager.getLaunchIntentForPackage(packageName)!!
    builder.setContentIntent(PendingIntent.getActivity(this,0,open,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    if(active!=null){
      val paused=active.optString("state")=="paused"
      builder.setContentText(if(paused)"已暂停，点击返回任务" else "${active.optString("name","素材任务")} · ${active.optInt("filesDone")}/${active.optInt("totalFiles")} 文件")
      for(action in listOf(if(paused)"resume" else "pause","cancel")){
        val intent=Intent(this,NativeJobService::class.java).putExtra("jobId",active.getString("id")).putExtra("action",action)
        builder.addAction(Notification.Action.Builder(null,when(action){"pause"->"暂停";"resume"->"继续";else->"停止"},PendingIntent.getService(this,action.hashCode(),intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
      }
    }else builder.setContentText("正在准备任务")
    return builder.build()
  }
  private fun refresh(){
    val engine=JobEngine.get(this)
    val jobs=engine.snapshot().getJSONArray("jobs")
    val active=(0 until jobs.length()).any {jobs.getJSONObject(it).optString("state") in listOf("queued","running")}
    if(active)wake.acquire(10*60*1000L) else if(!active&&wake.isHeld)wake.release()
    getSystemService(NotificationManager::class.java).notify(412,notification())
    if(!engine.hasWork())stopSelf()
  }
  override fun onStartCommand(intent: Intent?,flags: Int,startId: Int): Int {val id=intent?.getStringExtra("jobId");val action=intent?.getStringExtra("action");if(id!=null&&action in listOf("pause","resume","cancel"))Thread {try {JobEngine.get(this).control(id,action!!)}catch(_: Exception){} }.start();return START_NOT_STICKY}
  override fun onTimeout(startId: Int,fgsType: Int) {JobEngine.get(this).cancelForTimeout();stopSelf()}
  override fun onDestroy(){handler.removeCallbacks(update);if(wake.isHeld)wake.release();if(JobEngine.get(this).hasWork())JobEngine.get(this).cancelForTimeout();super.onDestroy()}
  override fun onBind(intent: Intent?): IBinder?=null
}
