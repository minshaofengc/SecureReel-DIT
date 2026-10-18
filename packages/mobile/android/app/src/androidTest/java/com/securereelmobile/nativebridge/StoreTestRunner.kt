// SPDX-License-Identifier: GPL-3.0-only
package com.securereelmobile.nativebridge

import android.app.Instrumentation
import android.os.Bundle
import android.app.Activity
import org.json.JSONArray
import org.json.JSONObject

/** Framework-only instrumentation: exercise actual Android SQLite across two app processes. */
class StoreTestRunner: Instrumentation() {
  private var mode="prepare"
  override fun onCreate(arguments: Bundle?) { super.onCreate(arguments);mode=arguments?.getString("mode") ?: "prepare";start() }
  override fun onStart() {
    val result=Bundle()
    try {
      if(mode=="ui-fixtures"){
        val engine=JobEngine.get(targetContext)
        for(count in listOf(0,1,20,50)) {
          val crew=JSONArray();repeat(count) {crew.put(JSONObject().put("name","拍摄人员%02d".format(it+1)).put("role",if(it%3==0)"摄影助理"else"DIT"))}
          val lenses=JSONArray();if(count==50)repeat(40) {lenses.put(JSONObject().put("model","Prime %02d".format(it+1)).put("detail","50mm"))}
          val name="界面验收 · ${count}人"
          val details=JSONObject().put("projectName",name).put("shootDay","2026-10-14").put("camera","ALEXA 35").put("notes","模拟器界面验收资料，非现场素材").put("crew",crew).put("lenses",lenses)
          val project=engine.saveProject(JSONObject().put("id","prj_"+count.toString().padStart(32,'0')).put("name",name).put("details",details).toString())
          check(project.getJSONObject("details").getJSONArray("crew").length()==count)
        }
        result.putString("stream","PASS native 0/1/20/50 crew and 40 lens UI fixtures\n");finish(Activity.RESULT_OK,result);return
      }
      if(mode=="scanner"){
        val activity=startActivitySync(android.content.Intent(targetContext,PairingScannerActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        waitForIdleSync()
        var focused=false
        repeat(30){if(!focused){runOnMainSync {focused=activity.hasWindowFocus()};if(!focused)Thread.sleep(100)}}
        check(focused) { "Scanner did not become a visible focused window" }
        var scannerFailure:Throwable?=null
        runOnMainSync { try {
          val expected=if(activity.resources.configuration.smallestScreenWidthDp>=600)android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LOCKED else android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
          check(activity.requestedOrientation==expected) { "Scanner must preserve expected orientation" }
          fun views(view:android.view.View):List<android.view.View> = listOf(view)+(if(view is android.view.ViewGroup)(0 until view.childCount).flatMap {views(view.getChildAt(it))}else emptyList())
          check(activity.window.decorView.width>0&&activity.window.decorView.height>0)
          val all=views(activity.window.decorView)
          check(all.any {it.contentDescription=="二维码取景框"}) { "Missing custom QR corners" }
          check(all.none {it is com.journeyapps.barcodescanner.ViewfinderView && it.visibility==android.view.View.VISIBLE}) { "Default laser overlay remains visible" }
          check(all.any {it.isClickable && it.contentDescription=="返回"})
        } catch(failure:Throwable){scannerFailure=failure} finally {activity.finish()} }
        scannerFailure?.let {throw it}
        result.putString("stream","PASS portrait scanner, custom QR frame, no default laser, return control\n");finish(Activity.RESULT_OK,result);return
      }
      if(mode=="timeout"){
        startActivitySync(android.content.Intent(targetContext,com.securereelmobile.MainActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine=JobEngine.get(targetContext);val roots=engine.roots(false)
        val source=(0 until roots.length()).map {roots.getJSONObject(it)}.first {it.getString("role")=="source"&&it.getString("folderName").contains("SecureReel-Test-Source")}
        val target=(0 until roots.length()).map {roots.getJSONObject(it)}.first {it.getString("role")=="target"&&it.getString("folderName").contains("SecureReel-Test-Target")}
        val job=engine.create(JSONObject().put("name","系统后台时限验证").put("mode","verify").put("sourceRootId",source.getString("id")).put("targetRootIds",JSONArray().put(target.getString("id"))).put("hashAlgorithm","sha256").put("manifestFormat","json").toString())
        val id=job.getString("id");engine.control(id,"start")
        java.io.File(targetContext.cacheDir,"timeout-test.json").writeText(JSONObject().put("id",id).toString())
        val deadline=System.currentTimeMillis()+30000
        while(engine.getJob(id).getString("state")!="interrupted"&&System.currentTimeMillis()<deadline)Thread.sleep(100)
        check(engine.getJob(id).getString("state")=="interrupted") { "Expected system timeout interruption, got "+engine.getJob(id).getString("state") }
        while(engine.hasWork()&&System.currentTimeMillis()<deadline)Thread.sleep(100)
        check(!engine.hasWork())
        result.putString("stream","PASS real Android foreground-service timeout safely interrupted task\n");finish(Activity.RESULT_OK,result);return
      }
      if(mode=="runtime"){
        startActivitySync(android.content.Intent(targetContext,com.securereelmobile.MainActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine=JobEngine.get(targetContext);val roots=engine.roots(false)
        val source=(0 until roots.length()).map {roots.getJSONObject(it)}.first {it.getString("role")=="source"&&it.getString("folderName").contains("SecureReel-Test-Source")}
        val target=(0 until roots.length()).map {roots.getJSONObject(it)}.first {it.getString("role")=="target"&&it.getString("folderName").contains("SecureReel-Test-Target")}
        val job=engine.create(JSONObject().put("name","锁屏驻留验证").put("mode","verify").put("sourceRootId",source.getString("id")).put("targetRootIds",JSONArray().put(target.getString("id"))).put("hashAlgorithm","sha256").put("manifestFormat","json").toString())
        val id=job.getString("id");val marker=java.io.File(targetContext.cacheDir,"runtime-test.json")
        val command=java.io.File(targetContext.cacheDir,"runtime-command.txt");command.delete()
        engine.control(id,"start");engine.control(id,"pause")
        Thread.sleep(3000);check(engine.getJob(id).getString("state")=="paused")
        marker.writeText(JSONObject().put("id",id).put("stage","paused").toString())
        val resumeDeadline=System.currentTimeMillis()+45000
        while((!command.exists()||command.readText().trim()!="resume")&&System.currentTimeMillis()<resumeDeadline)Thread.sleep(100)
        check(command.exists()&&command.readText().trim()=="resume") { "Host did not request resume" }
        engine.control(id,"resume");marker.writeText(JSONObject().put("id",id).put("stage","active").toString())
        val deadline=System.currentTimeMillis()+120000
        while(!SafetyPolicy.terminal(engine.getJob(id).getString("state"))&&System.currentTimeMillis()<deadline)Thread.sleep(500)
        val finished=engine.getJob(id);check(finished.getString("state")=="completed");check(finished.getInt("filesFailed")==0)
        Thread.sleep(3000);marker.writeText(JSONObject().put("id",id).put("stage","completed").toString())
        result.putString("stream","PASS actual long native verification after lockscreen/pause/resume; completed files="+finished.getInt("filesDone")+"\n");finish(Activity.RESULT_OK,result);return
      }
      if(mode=="existing-peer"){
        val before=java.io.File(targetContext.applicationInfo.dataDir,"shared_prefs/peer.xml").readBytes()
        val info=PeerClient(targetContext).info()
        val hadCredentials=targetContext.getSharedPreferences("peer",android.content.Context.MODE_PRIVATE).contains("encrypted")
        if(hadCredentials)check(info.has("clientId")&&info.getString("clientId").isNotEmpty()) { "Persisted pairing identity could not be decrypted after upgrade" }
        else check(info.length()==0) { "Upgrade silently recreated a revoked pairing" }
        check(java.io.File(targetContext.applicationInfo.dataDir,"shared_prefs/peer.xml").readBytes().contentEquals(before))
        result.putString("stream",if(hadCredentials)"PASS actual Android Keystore decrypted pre-upgrade paired desktop identity; encrypted preferences unchanged\n" else "PASS actual Android pre-upgrade revoked/empty pairing remains disconnected; preferences unchanged\n");finish(Activity.RESULT_OK,result);return
      }
      if(mode in listOf("peer","peer-revoked")){
        val peer=PeerClient(targetContext)
        if(mode=="peer-revoked"){
          try {peer.request("GET","/api/v1/snapshot","");error("Revoked token accepted")}catch(e: PeerFailure){check(e.code=="PEER_AUTH")}
          result.putString("stream","PASS native revoked token rejected\n");finish(Activity.RESULT_OK,result);return
        }
        val setup=JSONObject(java.io.File(targetContext.cacheDir,"peer-test-setup.json").readText())
        val matrix=com.google.zxing.qrcode.QRCodeWriter().encode(setup.toString(),com.google.zxing.BarcodeFormat.QR_CODE,720,720)
        val pixels=IntArray(720*720){i->if(matrix.get(i%720,i/720))android.graphics.Color.BLACK else android.graphics.Color.WHITE}
        val decoded=com.google.zxing.qrcode.QRCodeReader().decode(com.google.zxing.BinaryBitmap(com.google.zxing.common.HybridBinarizer(com.google.zxing.RGBLuminanceSource(720,720,pixels))))
        check(decoded.text==setup.toString())
        val expired=JSONObject(setup.toString()).put("expiresAt",0)
        try{peer.pair(expired.toString(),"Android device test");error("Expiry accepted")}catch(e: IllegalArgumentException){check(e.message=="Pairing expired")}
        val bad=JSONObject(setup.toString()).put("fingerprint","0".repeat(64))
        try{peer.pair(bad.toString(),"Android device test");error("Wrong pin accepted")}catch(e: PeerFailure){check(e.code=="PEER_CERTIFICATE")}
        val paired=peer.pair(setup.toString(),"Android device test");check(paired.has("clientId"))
        check(PeerClient(targetContext).info().getString("clientId")==paired.getString("clientId"))
        for(path in listOf("/api/v1/snapshot","/api/v1/roots","/api/v1/projects")){
          val response=JSONObject(String(peer.request("GET",path,""),Charsets.UTF_8));check(response.getInt("version")==1&&response.getBoolean("ok"))
          if(path.endsWith("snapshot"))check(response.toString().contains("DIT"))
        }
        try {peer.request("POST","/api/v1/jobs","{}");error("Invalid body accepted")}catch(e: PeerFailure){check(e.code=="PEER_VALIDATION")}
        result.putString("stream","PASS actual Android pinnedTLS pairing, identity persistence, snapshot/roots/projects; expiry and wrong pin rejected\n");finish(Activity.RESULT_OK,result);return
      }
      if(mode=="safety"){
        val engine=JobEngine.get(targetContext)
        val roots=engine.roots(false)
        val source=(0 until roots.length()).map { roots.getJSONObject(it) }.first { it.getString("role")=="source"&&it.optBoolean("accessible") }
        val target=(0 until roots.length()).map { roots.getJSONObject(it) }.first { it.getString("role")=="target"&&it.optBoolean("accessible") }
        val draft=JSONObject().put("name","只读预检验证").put("mode","verify").put("sourceRootId",source.getString("id")).put("targetRootIds",JSONArray().put(target.getString("id"))).put("hashAlgorithm","xxhash64").put("manifestFormat","json")
        fun inventory(root: JSONObject): List<String> {
          val uri=android.net.Uri.parse(root.getString("uri"));val rows=mutableListOf<String>()
          fun walk(id:String){targetContext.contentResolver.query(android.provider.DocumentsContract.buildChildDocumentsUriUsingTree(uri,id),arrayOf(android.provider.DocumentsContract.Document.COLUMN_DOCUMENT_ID,android.provider.DocumentsContract.Document.COLUMN_MIME_TYPE,android.provider.DocumentsContract.Document.COLUMN_SIZE,android.provider.DocumentsContract.Document.COLUMN_LAST_MODIFIED),null,null,null).use { c -> check(c!=null);while(c.moveToNext()){rows.add(c.getString(0)+":"+c.getLong(2)+":"+c.getLong(3));if(c.getString(1)==android.provider.DocumentsContract.Document.MIME_TYPE_DIR)walk(c.getString(0))} }}
          val tree=android.provider.DocumentsContract.getTreeDocumentId(uri)
          targetContext.contentResolver.query(android.provider.DocumentsContract.buildDocumentUriUsingTree(uri,tree),arrayOf(android.provider.DocumentsContract.Document.COLUMN_LAST_MODIFIED),null,null,null).use { c -> check(c!=null&&c.moveToFirst());rows.add("root:"+c.getLong(0)) }
          walk(tree);return rows.sorted()
        }
        val rawSource=engine.store.get("root",source.getString("id"))!!;val rawTarget=engine.store.get("root",target.getString("id"))!!
        val beforeSource=inventory(rawSource);val beforeTarget=inventory(rawTarget)
        val preflightResult=engine.preflight(draft.toString());check(preflightResult.getJSONArray("blockingReasons").length()==0);check(preflightResult.getJSONArray("risks").length()==0);check(preflightResult.isNull("independentDeviceGroups"));check(preflightResult.getJSONObject("source").getString("path")==source.getString("id"))
        check(inventory(rawSource)==beforeSource&&inventory(rawTarget)==beforeTarget) { "Read-only preflight wrote fixture roots" }
        if(source.getString("volumeId")==target.getString("volumeId")){
          val copy=engine.preflight(JSONObject(draft.toString()).put("mode","copy").toString());check(copy.getJSONArray("blockingReasons").toString().contains("同一存储卷"));check(copy.getJSONArray("risks").toString().contains("independence-unknown"))
          try {engine.create(JSONObject(draft.toString()).put("mode","copy").put("preflightConfirmation",JSONObject().put("fingerprint",copy.getString("fingerprint")).put("acceptRisks",true)).toString());error("same-source-volume copy accepted")}catch(_:IllegalArgumentException){}
        }
        check(inventory(rawSource)==beforeSource&&inventory(rawTarget)==beforeTarget)
        result.putString("stream","PASS actual Android read-only SAF preflight, opaque roots, unknown topology, same-source-volume native refusal; no fixture writes\n");finish(Activity.RESULT_OK,result);return
      }
      if(mode=="resume-safety"){
        startActivitySync(android.content.Intent(targetContext,com.securereelmobile.MainActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        val engine=JobEngine.get(targetContext);val roots=engine.roots(false)
        val source=(0 until roots.length()).map {roots.getJSONObject(it)}.first {it.getString("role")=="source"&&it.optBoolean("accessible")}
        val target=(0 until roots.length()).map {roots.getJSONObject(it)}.first {it.getString("role")=="target"&&it.optBoolean("accessible")}
        val draft=JSONObject().put("name","旧任务恢复安全快照回归").put("mode","verify").put("sourceRootId",source.getString("id")).put("targetRootIds",JSONArray().put(target.getString("id"))).put("hashAlgorithm","xxhash64").put("manifestFormat","json")
        val created=engine.create(draft.toString());val id=created.getString("id")
        val legacy=engine.store.get("job",id)!!.put("state","interrupted");legacy.remove("backupSafety");legacy.remove("preflightConfirmation");engine.store.put("job",id,legacy)
        val checked=engine.preflight(JSONObject().put("id",id).toString());val consent=JSONObject().put("fingerprint",checked.getString("fingerprint")).put("acceptRisks",true)
        engine.control(id,JSONObject().put("action","resume").put("preflightConfirmation",consent).toString())
        val saved=engine.store.get("job",id)!!
        check(saved.optJSONObject("backupSafety")?.optString("fingerprint")==checked.getString("fingerprint")) { "retryIncomplete discarded the freshly validated safety snapshot" }
        check(saved.optJSONObject("preflightConfirmation")?.toString()==consent.toString()) { "retryIncomplete discarded fresh user consent" }
        val deadline=System.currentTimeMillis()+90000
        while(!SafetyPolicy.terminal(engine.getJob(id).getString("state"))&&System.currentTimeMillis()<deadline)Thread.sleep(100)
        val finished=engine.getJob(id);check(finished.getString("state")=="completed"&&finished.getInt("filesFailed")==0)
        val free=target.getLong("freeBytes");val capacityFixture=JSONObject(legacy.toString()).put("id","job_capacity_resume_fixture").put("mode","copy").put("totalBytes",free+1024)
        engine.store.put("job",capacityFixture.getString("id"),capacityFixture)
        try {
          val shortage=engine.preflight(JSONObject().put("id",capacityFixture.getString("id")).toString())
          check(shortage.getJSONArray("risks").toString().contains("insufficient-space"))
          check(!shortage.getJSONArray("blockingReasons").toString().contains("容量不足")) { "Known capacity shortage must require consent, not hard-block recovery" }
        }finally {engine.store.remove("job",capacityFixture.getString("id"))}
        result.putString("stream","PASS actual Android legacy interrupted task resume retained fresh evidence and consent; independent reread completed; native known shortage is acknowledgement risk\n");finish(Activity.RESULT_OK,result);return
      }
      if(mode=="report"){
        val engine=JobEngine.get(targetContext);val id="job_"+"c".repeat(32)
        val project=ProjectData.taskProject(JSONObject().put("projectName","电影").put("cardLabel","A001").put("crew",JSONArray().put(JSONObject().put("role","摄影师").put("name","张三"))),null)
        val job=JSONObject().put("id",id).put("name","报告资料测试").put("mode","verify").put("state","completed").put("sourceRootId","test_source").put("sourceLabel","测试来源").put("targetRootIds",JSONArray().put("test_target")).put("hashAlgorithm","xxhash64").put("manifestFormat","json").put("totalFiles",0).put("totalBytes",0).put("filesDone",0).put("filesFailed",0).put("bytesDone",0).put("project",project).put("parentProjectName","测试母项目").put("origin","local")
        val safety=JSONObject().put("fingerprint","native-report-fixture").put("checkedAt","2026-10-18T00:00:00Z").put("independentDeviceGroups",JSONObject.NULL)
        fun identity(path:String)=JSONObject().put("path",path).put("label",path).put("filesystemId","shared-test-volume").put("capacityPoolId","shared-test-volume").put("physicalDeviceIds",JSONArray()).put("availableBytes",200).put("present",true)
        safety.put("source",identity("test_source")).put("targets",JSONArray().put(identity("test_target"))).put("requiredBytes",120).put("blockingReasons",JSONArray())
        safety.put("groups",JSONArray().put(JSONObject().put("id","shared-test-volume").put("paths",JSONArray(listOf("a","b"))).put("requiredBytes",120).put("availableBytes",200).put("sufficient",true)))
        safety.put("risks",JSONArray().put(JSONObject().put("code","shared-filesystem").put("paths",JSONArray(listOf("a","b")))))
        job.put("backupSafety",safety)
        engine.store.put("job",id,job)
        val archive=ReportArchive(targetContext,engine)
        val bundle=JSONObject().put("json",engine.getJob(id).toString()).put("manifest",JSONObject().put("algorithm","xxhash64").put("files",JSONArray()).toString()).put("manifestName","manifest.json")
        val first=archive.save(id,bundle.toString())
        val folder=java.io.File(targetContext.filesDir,"reports/$id/R%03d".format(java.util.Locale.ROOT,first.getInt("revision")))
        val html=java.io.File(folder,"report.html").readText();check(html.contains("测试母项目")&&html.contains("张三")&&html.contains("摄影师")&&html.contains("A001")&&html.contains("本机（安卓）"))
        check(html.contains("独立物理设备组：未知")&&html.contains("不能算作独立物理备份")&&html.contains("shared-filesystem"))
        check(JSONObject(java.io.File(folder,"report.json").readText()).getJSONObject("backupSafety").getString("fingerprint")=="native-report-fixture")
        check(JSONObject(java.io.File(folder,"report.json").readText()).getJSONObject("project").getJSONArray("crew").getJSONObject(0).getString("name")=="张三")
        check(java.io.File(folder,"report.pdf").readBytes().take(4).toByteArray().toString(Charsets.US_ASCII)=="%PDF")
        val old=java.io.File(folder,"report.json").readBytes()
        archive.save(id,bundle.toString())
        check(java.io.File(folder,"report.json").readBytes().contentEquals(old))
        result.putString("stream","PASS native report full metadata and immutable revisions\n");finish(Activity.RESULT_OK,result);return
      }
      val name="checkpoint-device-test.sqlite"
      if(mode in listOf("prepare","data"))targetContext.deleteDatabase(name)
      val store=CheckpointStore(targetContext,name)
      try {
        val id="job_device_test"
        if(mode=="data"){
          val old=JSONObject().put("id","prj_"+"a".repeat(32)).put("name","电影").put("camera","ALEXA").put("notes","旧备注")
          store.put("project",old.getString("id"),old)
          val migrated=store.projects().getJSONObject(0)
          check(migrated.getJSONObject("details").getString("camera")=="ALEXA")
          val saved=store.saveProject(JSONObject().put("id",old.getString("id")).put("details",JSONObject().put("crew",JSONArray().put(JSONObject().put("role","摄影师").put("name","张三")))))
          check(saved.getJSONObject("details").getString("notes")=="旧备注")
          check(store.saveProject(JSONObject().put("id",old.getString("id")).put("name","新名")).getJSONObject("details").getJSONArray("crew").length()==1)
          val settings=store.saveSettings(JSONObject().put("themeMode","dark").put("keepScreenOn",true));check(settings.getBoolean("keepScreenOn"))
          val beforePending=store.all("pending-mutation").length()
          check(store.getPendingMutation("not-created")==null);check(store.all("pending-mutation").length()==beforePending)
          val pending=store.pendingMutation("desktop/create","{\"name\":\"first\"}")
          check(store.getPendingMutation("desktop/create")!!.getString("requestId")==pending.getString("requestId"))
          val longKey="client:"+"a".repeat(320)+":/jobs/"+"b".repeat(64)
          val longPending=store.pendingMutation(longKey,"{}")
          store.close()
          val reopened=CheckpointStore(targetContext,name)
          try {
            check(reopened.pendingMutation(longKey,"{}").getString("requestId")==longPending.getString("requestId"))
            reopened.completeMutation(longKey)
            check(reopened.get("pending-mutation",longKey)==null)
            check(reopened.getSettings().getString("themeMode")=="dark")
            check(reopened.projects().getJSONObject(0).getString("id")==old.getString("id"))
            check(reopened.pendingMutation("desktop/create","{\"name\":\"second\"}").toString()==pending.toString())
            reopened.completeMutation("desktop/create")
            check(reopened.pendingMutation("desktop/create","{}").getString("requestId")!=pending.getString("requestId"))
          }finally { reopened.close() }
        }else if(mode=="prepare"){
          val job=JSONObject().put("id",id).put("mode","copy").put("state","running").put("totalFiles",2).put("totalBytes",6).put("filesDone",0).put("filesFailed",0).put("bytesDone",0)
          val captured=JSONArray();for(i in 0..1)captured.put(JSONObject().put("relativePath","clip$i.mov").put("bytes",3).put("uri","content://fixture/$i"))
          store.createJob(job,captured)
          store.appendResult(id,0,file("clip0.mov","verified",false))
          store.put("commit","$id:1:0",JSONObject().put("hash","44bc2cf5ad770999").put("bytes",3).put("relative","clip1.mov").put("rootId","target_1"))
          check(store.resultCount(id)==1)
        }else {
          check(mode=="recover")
          store.recover()
          val saved=store.get("job",id)!!
          check(saved.getString("state")=="interrupted" && saved.getInt("filesDone")==1 && saved.getLong("bytesDone")==3L)
          check(store.capturedAt(id,1).getString("relativePath")=="clip1.mov")
          check(store.get("commit","$id:1:0")!!.getString("hash")=="44bc2cf5ad770999")
          check(store.retryIncomplete(id).getInt("filesDone")==1)
          store.appendResult(id,1,file("clip1.mov","cancelled",true))
          check(store.get("job",id)!!.getInt("filesFailed")==1)
          val retry=store.retryIncomplete(id)
          check(store.get("commit","$id:1:0")!!.getString("hash")=="44bc2cf5ad770999")
          check(retry.getInt("filesDone")==1 && retry.getInt("filesFailed")==0 && retry.getLong("bytesDone")==3L)
          store.appendResult(id,1,file("clip1.mov","verified",false))
          check(store.get("job",id)!!.getInt("filesDone")==2 && store.get("job",id)!!.getLong("bytesDone")==6L)
          check(store.results(id).length()==2 && store.isolatedTargets(id).isEmpty())
        }
      }finally{store.close()}
      result.putString("stream","PASS Android SQLite $mode across process restart\n")
      finish(Activity.RESULT_OK,result)
    }catch(failure: Throwable){result.putString("stream","FAIL Android SQLite $mode: ${failure.javaClass.simpleName}: ${failure.message}\n");finish(Activity.RESULT_CANCELED,result)}
  }
  private fun file(path: String,status: String,cancelled: Boolean): JSONObject = JSONObject().put("relativePath",path).put("bytes",3).put("sourceHash","44bc2cf5ad770999").put("cancelled",cancelled).put("sourceFailed",false).put("targets",JSONArray().put(JSONObject().put("rootId","target_1").put("status",status).put("hash",if(status=="verified")"44bc2cf5ad770999" else "").put("bytes",3)))
}
