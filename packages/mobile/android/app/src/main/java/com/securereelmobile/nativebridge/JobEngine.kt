// SPDX-License-Identifier: GPL-3.0-only
package com.securereelmobile.nativebridge

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

internal class JobEngine private constructor(val context: Context) {
  val store = CheckpointStore(context)
  private val executor = Executors.newSingleThreadExecutor()
  private val gates = ConcurrentHashMap<String, Gate>()
  private val lock = Any()
  private val direct=DirectStorage(context)
  init { store.recover() }
  class Gate {
    var commitIntent: ((Int,String,Long)->Unit)?=null
    var recovery: ((Int)->String)?=null
    fun prepareCommit(target: Int,hash: String,bytes: Long){requireNotNull(commitIntent)(target,hash,bytes)}
    fun recoveryHash(target: Int): String=recovery?.invoke(target) ?: ""
    @Volatile var interruption: String?=null
    @Volatile var started=false
    @Volatile var requireAllFiles=false
    @Volatile var paused=false
    @Volatile var cancelled=false
    fun awaitChunk(): Boolean {
      while(paused && !cancelled)Thread.sleep(100)
      if(requireAllFiles&&!android.os.Environment.isExternalStorageManager()){
        interruption="文件访问权限已失效，请重新授权后继续"
        cancelled=true
      }
      return !cancelled
    }
  }
  private external fun copyFile(source: String, targets: Array<String>, relative: String, algorithm: String, expectedBytes: Long, gate: Gate): String
  private external fun verifyFile(source: Int, targets: IntArray, algorithm: String, expectedBytes: Long, gate: Gate): String
  private fun root(id: String, role: String, probeCopy: Boolean=false): JSONObject = store.get("root",id)?.also {
    require(it.getString("role")==role); require(accessible(it.getString("uri"))) { "Folder permission unavailable" }; describeLocation(it);require(it.getBoolean("accessible")) { "磁盘未连接或目录授权已失效，请重新选择后继续" };updateCapability(it,probeCopy)
  } ?: error("Folder unavailable")
  fun accessible(raw: String): Boolean = context.contentResolver.persistedUriPermissions.any { it.uri.toString()==raw && it.isReadPermission }
  private fun describeLocation(root: JSONObject) {
    val uri=Uri.parse(root.getString("uri"));val tree=DocumentsContract.getTreeDocumentId(uri)
    var folder=tree.substringAfter(':',tree).ifEmpty { "存储根目录" }
    var disk=uri.authority?.let { context.packageManager.resolveContentProvider(it,0)?.loadLabel(context.packageManager)?.toString() } ?: "文档位置";var connected=true;var free: Long?=null
    if(uri.authority=="com.android.externalstorage.documents"){
      val volumeId=tree.substringBefore(':')
      val volume=context.getSystemService(android.os.storage.StorageManager::class.java).storageVolumes.find { if(volumeId=="primary")it.isPrimary else it.uuid?.equals(volumeId,true)==true }
      connected=volume!=null && volume.state in listOf(android.os.Environment.MEDIA_MOUNTED,android.os.Environment.MEDIA_MOUNTED_READ_ONLY)
      disk=if(volume?.isPrimary==true)"手机内置存储" else if(volume!=null) volume.getDescription(context)+(volume.uuid?.let { " · "+it.uppercase(java.util.Locale.ROOT) } ?: "") else root.optString("diskName").ifEmpty { "未连接的存储盘 · "+volumeId }
      if(connected)free=try { volume?.directory?.let { android.os.StatFs(it.path).availableBytes } }catch(e: Exception){null}
    }
    if(uri.authority!="com.android.externalstorage.documents"){
      folder=try { context.contentResolver.query(DocumentsContract.buildDocumentUriUsingTree(uri,tree),arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME),null,null,null).use { if(it?.moveToFirst()==true)it.getString(0) else "已选项目文件夹" } }catch(e: Exception){"已选项目文件夹"}
    }
    root.put("diskName",disk).put("folderName",folder).put("connected",connected).put("freeBytes",free ?: JSONObject.NULL)
      .put("accessible",accessible(root.getString("uri"))&&connected).put("writable",context.contentResolver.persistedUriPermissions.any { it.uri.toString()==root.getString("uri")&&it.isWritePermission }).put("label","$disk · $folder")
  }
  private fun updateCapability(root: JSONObject, probeCopy: Boolean=false) {
    val knownSources=store.all("root")
    val sharesSourceVolume=(0 until knownSources.length()).any { val source=knownSources.getJSONObject(it);source.getString("role")=="source" && source.getString("volumeId")==root.getString("volumeId") }
    val knownJobs=store.all("job")
    val verifying=(0 until knownJobs.length()).any { val job=knownJobs.getJSONObject(it);job.getString("mode")=="verify"&&!SafetyPolicy.terminal(job.getString("state")) }
    val supported=if(probeCopy) SafetyPolicy.probeCopyTarget(true,root.getString("role"),sharesSourceVolume,verifying) { direct.supports(root.getString("uri")) }
      else root.optBoolean("supportsVerifiedCommit") && root.optBoolean("accessible") && root.optBoolean("writable") && !sharesSourceVolume && !verifying && android.os.Environment.isExternalStorageManager()
    root.put("supportsVerifiedCommit",supported)
    root.put("disabledReason",when {
      supported || root.getString("role")=="source" -> ""
      !root.optBoolean("accessible") -> "磁盘未连接或目录授权失效，请重新选择"
      Uri.parse(root.getString("uri")).authority!="com.android.externalstorage.documents" -> "这个位置支持可读取的校验，暂不支持独立拷贝"
      sharesSourceVolume -> "这个盘上已有来源授权，请选择另一块独立备份盘"
      verifying -> "先结束未完成的仅校验任务，再检测拷贝支持"
      !android.os.Environment.isExternalStorageManager() -> "先授予所有文件访问，再检测拷贝支持"
      !root.optBoolean("writable") -> "当前为只读授权，可重新选择目录并授予写入权限"
      else -> "请检测这个目标是否支持安全拷贝"
    })
  }
  fun roots(probeCopy: Boolean=false): JSONArray = synchronized(lock) { store.all("root").also { roots -> for(i in 0 until roots.length()){val r=roots.getJSONObject(i);describeLocation(r);updateCapability(r,probeCopy);if(probeCopy)store.put("root",r.getString("id"),r);r.remove("uri")} } }
  fun authorize(uri: Uri, role: String): JSONObject {
    require(role in listOf("source","target")); require(DocumentsContract.isTreeUri(uri))
    require(accessible(uri.toString()))
    val registered=store.all("root")
    for(index in 0 until registered.length()){val existing=registered.getJSONObject(index);if(existing.getString("role")==role&&existing.getString("uri")==uri.toString()){
      existing.put("writable",context.contentResolver.persistedUriPermissions.any { it.uri==uri&&it.isWritePermission });describeLocation(existing);updateCapability(existing);store.put("root",existing.getString("id"),existing);return JSONObject(existing.toString()).apply { remove("uri") }
    }}
    val id="root_"+UUID.randomUUID().toString().replace("-","")
    val tree=DocumentsContract.getTreeDocumentId(uri)
    val writable=context.contentResolver.persistedUriPermissions.any { it.uri==uri&&it.isWritePermission }
    val r=JSONObject().put("id",id).put("label",tree.substringAfter(':').ifEmpty { "Selected folder" }).put("role",role)
      .put("accessible",true).put("writable",writable).put("supportsVerifiedCommit",false)
      .put("disabledReason","This Android document provider cannot guarantee atomic no-overwrite commit; read-only verification is available.")
      .put("volumeId",uri.authority+":"+tree.substringBefore(':').lowercase()).put("uri",uri.toString())
    describeLocation(r);updateCapability(r);store.put("root",id,r); return JSONObject(r.toString()).apply { remove("uri") }
  }
  fun forgetRoot(id: String) = synchronized(lock) {
    val root=store.get("root",id) ?: return@synchronized
    val jobs=store.all("job")
    for(i in 0 until jobs.length()){val job=jobs.getJSONObject(i);if(job.getString("state") in listOf("queued","running","paused","interrupted")) {
      val targets=job.getJSONArray("targetRootIds")
      require(job.getString("sourceRootId")!=id && (0 until targets.length()).none { targets.getString(it)==id }) { "This folder is still used by an unfinished task" }
    }}
    val uri=Uri.parse(root.getString("uri"));val registered=store.all("root")
    val sharedUri=(0 until registered.length()).any { val item=registered.getJSONObject(it);item.getString("id")!=id && item.getString("uri")==uri.toString() }
    if(!sharedUri)context.contentResolver.persistedUriPermissions.find { it.uri==uri }?.let { permission ->
      val flags=(if(permission.isReadPermission)Intent.FLAG_GRANT_READ_URI_PERMISSION else 0) or (if(permission.isWritePermission)Intent.FLAG_GRANT_WRITE_URI_PERMISSION else 0)
      context.contentResolver.releasePersistableUriPermission(uri,flags)
    }
    store.remove("root",id)
  }
  private data class Entry(val relative: String,val uri: Uri,val bytes: Long)
  private fun list(uri: Uri): List<Entry> {
    val result= mutableListOf<Entry>(); val seen=mutableSetOf<String>();var metadataBytes=0L;var directoryBytes=0L
    fun walk(id: String,prefix: String,depth: Int) {
      directoryBytes+=id.toByteArray(Charsets.UTF_8).size
      require(seen.size<10000 && directoryBytes<=16*1024*1024) { "Folder inventory too large; choose a smaller batch folder" }
      require(depth<=64 && seen.add(id)) { "Unsupported directory structure" }
      context.contentResolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(uri,id),arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE,DocumentsContract.Document.COLUMN_SIZE),null,null,null).use { cursor ->
        requireNotNull(cursor) { "Folder unavailable" }
        while(cursor.moveToNext()){
          val name=cursor.getString(1);require(!name.contains('/')); SafetyPolicy.relative(name)
          val rel=prefix+name; SafetyPolicy.relative(rel)
          if(cursor.getString(2)==DocumentsContract.Document.MIME_TYPE_DIR)walk(cursor.getString(0),"$rel/",depth+1)
          else {
            val document=DocumentsContract.buildDocumentUriUsingTree(uri,cursor.getString(0))
            metadataBytes+=rel.toByteArray(Charsets.UTF_8).size+document.toString().toByteArray(Charsets.UTF_8).size+64
            require(result.size<100000&&metadataBytes<=16*1024*1024) { "Folder inventory too large; choose a smaller batch folder" }
            result.add(Entry(rel,document,cursor.getLong(3).coerceAtLeast(0)))
          }
        }
      }
    }
    walk(DocumentsContract.getTreeDocumentId(uri),"",0); return result.sortedBy { it.relative }
  }
  private fun resolve(root: Uri,relative: String): Uri {
    SafetyPolicy.relative(relative);var id=DocumentsContract.getTreeDocumentId(root)
    for(component in relative.split('/')){
      var found: String?=null
      context.contentResolver.query(DocumentsContract.buildChildDocumentsUriUsingTree(root,id),arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME),null,null,null).use { c ->
        requireNotNull(c);while(c.moveToNext())if(c.getString(1)==component){require(found==null) { "Ambiguous document name" };found=c.getString(0)}
      }
      id=requireNotNull(found) { "Target file unavailable" }
    }
    return DocumentsContract.buildDocumentUriUsingTree(root,id)
  }
  /** Read-only SAF metadata/StatFs inspection. A StorageVolume UUID identifies a filesystem, not USB hardware. */
  fun preflight(raw: String): JSONObject {
    val draft=JSONObject(raw)
    if(draft.has("id")){
      val job=store.get("job",draft.getString("id")) ?: error("Task unavailable")
      return preflight(job,job.getLong("totalBytes"))
    }
    val source=root(draft.getString("sourceRootId"),"source")
    val bytes=list(Uri.parse(source.getString("uri"))).fold(0L) { total,entry -> Math.addExact(total,entry.bytes) }
    return preflight(draft,bytes)
  }
  private fun preflight(draft: JSONObject,requiredBytes: Long): JSONObject {
    require(requiredBytes in 0..9007199254740991L)
    val mode=draft.getString("mode");require(mode in listOf("copy","verify"))
    val source=root(draft.getString("sourceRootId"),"source")
    val ids=draft.getJSONArray("targetRootIds");require(ids.length() in 1..2)
    val targets=(0 until ids.length()).map { root(ids.getString(it),"target") }
    require(targets.map { it.getString("id") }.toSet().size==targets.size)
    val risks=JSONArray();val reasons=JSONArray();val groups=JSONArray()
    fun identity(r: JSONObject)=JSONObject().put("path",r.getString("id")).put("label",r.getString("label"))
      .put("filesystemId",r.optString("volumeId").ifEmpty { null } ?: JSONObject.NULL)
      .put("capacityPoolId",r.optString("volumeId").ifEmpty { null } ?: JSONObject.NULL)
      .put("physicalDeviceIds",JSONArray()).put("availableBytes",r.opt("freeBytes") ?: JSONObject.NULL).put("present",r.optBoolean("accessible"))
    fun risk(code: String,paths: List<String>) { risks.put(JSONObject().put("code",code).put("paths",JSONArray(paths))) }
    targets.forEach { target ->
      if(target.getString("uri")==source.getString("uri"))reasons.put("来源和目标不能选择同一个文件夹")
      if(mode=="copy"&&target.getString("volumeId")==source.getString("volumeId"))reasons.put("来源和目标位于同一存储卷")
      if(mode=="copy"&&!target.optBoolean("writable"))reasons.put("目标写入授权不可用，请重新选择")
    }
    if(mode=="copy"){
      if(!android.os.Environment.isExternalStorageManager())reasons.put("请授予全部文件访问权限后拷贝")
      for((id,pool) in targets.groupBy { it.getString("volumeId") }){
        val required=SafetyPolicy.requiredForPool(requiredBytes,pool.size)
        val available=if(pool.any { it.isNull("freeBytes") })null else pool.minOf { it.getLong("freeBytes") }
        val paths=pool.map { it.getString("id") }
        val sufficient=available!=null&&available>=required
        groups.put(JSONObject().put("id",id).put("paths",JSONArray(paths)).put("requiredBytes",required).put("availableBytes",available ?: JSONObject.NULL).put("sufficient",sufficient))
        if(!sufficient){if(available==null)reasons.put("目标剩余容量未知，无法开始拷贝");risk("insufficient-space",paths)}
        if(pool.size>1)risk("shared-filesystem",paths)
      }
      risk("independence-unknown",targets.map { it.getString("id") })
    }
    // Free space is rechecked, not part of consent identity: writing a file must not invalidate unchanged device consent.
    val binding=JSONArray().put(mode).put(requiredBytes).put(draft.optString("hashAlgorithm")).put(draft.optString("manifestFormat"))
    (listOf(source)+targets).forEach { binding.put(JSONArray().put(it.getString("id")).put(it.getString("uri")).put(it.getString("volumeId"))) }
    val fingerprint=java.security.MessageDigest.getInstance("SHA-256").digest(binding.toString().toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 255) }
    return JSONObject().put("fingerprint",fingerprint).put("checkedAt",java.time.Instant.now().toString())
      .put("source",identity(source)).put("targets",JSONArray(targets.map { identity(it) })).put("groups",groups).put("risks",risks)
      .put("blockingReasons",reasons).put("requiredBytes",requiredBytes).put("independentDeviceGroups",JSONObject.NULL)
  }
  private fun enforcePreflight(result: JSONObject,confirmation: JSONObject?) {
    if(confirmation!=null)require(confirmation.keys().asSequence().toSet()==setOf("fingerprint","acceptRisks") && confirmation.get("fingerprint") is String && confirmation.get("acceptRisks") is Boolean)
    val reasons=result.getJSONArray("blockingReasons")
    require(reasons.length()==0) { (0 until reasons.length()).joinToString("；") { reasons.getString(it) } }
    SafetyPolicy.confirmation(result.getString("fingerprint"),confirmation?.optString("fingerprint") ?: "",confirmation?.optBoolean("acceptRisks")==true,result.getJSONArray("risks").length()>0)
  }
  fun create(raw: String): JSONObject {
    val draft=JSONObject(raw)
    val fields=setOf("name","mode","sourceRootId","targetRootIds","hashAlgorithm","manifestFormat")
    require(draft.keys().asSequence().all { it in fields+setOf("projectName","project","parentProjectId","preflightConfirmation") } && fields.all { draft.has(it) })
    for(field in fields-setOf("targetRootIds"))require(draft.get(field) is String)
    if(draft.has("projectName"))require(draft.get("projectName") is String && draft.getString("projectName").length<=160)
    val parentId=if(draft.has("parentProjectId")&&!draft.isNull("parentProjectId")){require(draft.get("parentProjectId") is String);draft.getString("parentProjectId")}else null
    val parent=parentId?.let { store.get("project",it)?.let { project -> ProjectData.migrate(project) } ?: error("Mother project unavailable") }
    val project=ProjectData.taskProject(draft.optJSONObject("project") ?: JSONObject().also { if(draft.has("projectName"))it.put("projectName",draft.getString("projectName")) },parent)
    if(draft.has("project"))require(draft.get("project") is JSONObject)
    val mode=draft.getString("mode");require(mode in listOf("copy","verify"))
    val name=draft.getString("name").trim();require(name.length in 1..120)
    val algorithm=draft.getString("hashAlgorithm");require(algorithm in listOf("xxhash64","xxh3","xxh128","md5","sha1","sha256","asc-c4"))
    val format=draft.getString("manifestFormat");require(format in listOf("asc-mhl-2.0","mhl-v1","csv","json"));require(!(format=="asc-mhl-2.0"&&algorithm=="sha256"));require(format!="mhl-v1"||algorithm in listOf("xxhash64","md5","asc-c4"))
    val source=root(draft.getString("sourceRootId"),"source")
    val targetIds=draft.getJSONArray("targetRootIds");require(targetIds.length() in 1..2)
    val unique=mutableSetOf<String>();if(mode=="copy")require(direct.resolve(source.getString("uri"))!=null) { "This provider cannot guarantee safe no-overwrite copy. Use read-only verification." };for(i in 0 until targetIds.length()){
      val target=root(targetIds.getString(i),"target",mode=="copy");require(unique.add(target.getString("id")));require(target.getString("uri")!=source.getString("uri")) { "来源和目标不能选择同一个文件夹" }
      if(mode=="copy") { require(target.getString("volumeId")!=source.getString("volumeId")) { "来源和目标位于同一存储卷" };require(target.getBoolean("supportsVerifiedCommit")) { "This provider cannot guarantee safe no-overwrite copy. Use read-only verification." } }
    }
    val targetLabels=JSONObject();for(i in 0 until targetIds.length())targetLabels.put(targetIds.getString(i),store.get("root",targetIds.getString(i))!!.getString("label"))
    val files=list(Uri.parse(source.getString("uri"))) // Capture entire source list before starting any worker.
    val safety=preflight(draft,files.fold(0L) { total,entry -> Math.addExact(total,entry.bytes) })
    enforcePreflight(safety,draft.optJSONObject("preflightConfirmation"))
    val id="job_"+UUID.randomUUID().toString().replace("-","")
    val job=JSONObject(draft.toString()).put("id",id).put("name",name).put("state","queued").put("backupSafety",safety)
      .put("project",project).put("projectName",project.getString("projectName")).put("parentProjectId",parentId ?: JSONObject.NULL).put("parentProjectName",parent?.getString("name") ?: JSONObject.NULL).put("origin","local").put("sourceLabel",source.getString("label")).put("targetLabels",targetLabels).put("totalFiles",files.size).put("totalBytes",files.sumOf { it.bytes }).put("filesDone",0).put("filesFailed",0).put("bytesDone",0)
    val captured=JSONArray();files.forEach { captured.put(JSONObject().put("relativePath",it.relative).put("bytes",it.bytes).put("uri",it.uri.toString())) }
    return synchronized(lock) {
      require(store.get("root",source.getString("id"))!=null && accessible(source.getString("uri")))
      for(i in 0 until targetIds.length())require(store.get("root",targetIds.getString(i))!=null)
      store.createJob(job,captured) // Durable queue only; the user must explicitly start.

      publicJob(job)
    }
  }

  private fun publicJob(job: JSONObject): JSONObject = JSONObject(job.toString()).apply { remove("captured");remove("files");remove("_anyVerified");if(!has("origin"))put("origin","local") }
  fun getJob(id: String): JSONObject = synchronized(lock) { val job=store.get("job",id) ?: error("Task unavailable");publicJob(job).put("files",store.results(id)) }
  fun saveProject(raw: String): JSONObject { require(raw.toByteArray(Charsets.UTF_8).size<=65536);return store.saveProject(JSONObject(raw)) }
  fun getSettings(): JSONObject=store.getSettings()
  fun saveSettings(raw: String): JSONObject { require(raw.length<=4096);return store.saveSettings(JSONObject(raw)) }
  fun pendingMutation(key: String,body: String): JSONObject=store.pendingMutation(key,body)
  fun getPendingMutation(key: String): JSONObject?=store.getPendingMutation(key)
  fun completeMutation(key: String)=store.completeMutation(key)
  fun snapshot(): JSONObject { val jobs=store.all("job");val out=JSONArray();for(i in 0 until jobs.length())out.put(publicJob(jobs.getJSONObject(i)));return JSONObject().put("jobs",out).put("projects",store.projects()) }
  fun control(id: String, rawAction: String): JSONObject = synchronized(lock) {
    val command=if(rawAction.startsWith("{"))JSONObject(rawAction) else JSONObject().put("action",rawAction)
    val action=command.getString("action")
    var job=store.get("job",id) ?: error("Task unavailable")
    require(action in listOf("start","pause","resume","cancel"));require(!SafetyPolicy.terminal(job.getString("state")))
    val gate=gates[id]
    if(action=="start"&&gate!=null)return@synchronized publicJob(job)
    var launch=false
    if(action in listOf("start","resume")){
      val safety=preflight(job,job.getLong("totalBytes"))
      val confirmation=command.optJSONObject("preflightConfirmation") ?: job.optJSONObject("preflightConfirmation")
      enforcePreflight(safety,confirmation)
      job.put("backupSafety",safety)
      if(confirmation!=null)job.put("preflightConfirmation",confirmation)
    }
    when(action){
      "start" -> {launch=SafetyPolicy.shouldLaunch(job.getString("state"),action,gate!=null)}
      "pause" -> {require(gate!=null);gate.paused=true;job.put("state","paused")}
      "cancel" -> {if(gate!=null)gate.cancelled=true else job.put("state","cancelled")}
      "resume" -> {if(gate!=null){gate.paused=false;job.put("state",if(gate.started)"running" else "queued")}else {
        launch=SafetyPolicy.shouldLaunch(job.getString("state"),action,false)
        val safety=job.getJSONObject("backupSafety");val confirmation=job.optJSONObject("preflightConfirmation")
        job=store.retryIncomplete(id).put("backupSafety",safety)
        if(confirmation!=null)job.put("preflightConfirmation",confirmation)
      }}
    }
    if(launch){
      try { root(job.getString("sourceRootId"),"source");val targets=job.getJSONArray("targetRootIds");for(i in 0 until targets.length())root(targets.getString(i),"target");if(job.getString("mode")=="copy")require(android.os.Environment.isExternalStorageManager()) { "请重新授予文件访问权限" } }
      catch(e: Exception){job.put("state","interrupted").put("phase","磁盘或目录授权不可用，请检查后继续");store.put("job",id,job);throw e}
      val next=Gate().apply {requireAllFiles=job.getString("mode")=="copy"};gates[id]=next
      try {context.startForegroundService(Intent(context,NativeJobService::class.java))}
      catch(e: Exception){gates.remove(id);throw e} // Keep durable queued/interrupted state on launch failure.
      job.put("state","queued")
    }
    try {store.put("job",id,job)}catch(e: Exception){if(launch){gates.remove(id);if(!hasWork())context.stopService(Intent(context,NativeJobService::class.java))};throw e}
    if(launch)enqueue(id)
    publicJob(job)
  }

  fun cancelForTimeout() = synchronized(lock) {
    gates.values.forEach { it.cancelled=true;it.paused=false }
    val jobs=store.all("job")
    for(i in 0 until jobs.length()){val j=jobs.getJSONObject(i);if(j.getString("state") in listOf("queued","running","paused")){j.put("state","interrupted").put("phase","Android background time limit reached");store.put("job",j.getString("id"),j)}}
  }
  fun hasWork(): Boolean = gates.isNotEmpty()
  private fun enqueue(id: String) { executor.execute { run(id) } }
  private fun run(id: String) {
    val gate=gates[id] ?: return
    var job=store.get("job",id) ?: return
    try {
      if(job.getString("mode")=="copy")enforcePreflight(preflight(job,job.getLong("totalBytes")),job.optJSONObject("preflightConfirmation"))
      synchronized(lock){ gate.started=true;job=store.get("job",id)!!;if(!gate.paused)job.put("state","running");store.put("job",id,job) }
      val source=root(job.getString("sourceRootId"),"source"); val ids=job.getJSONArray("targetRootIds")
      val targetRoots=(0 until ids.length()).map { idIndex -> try { Uri.parse(root(ids.getString(idIndex),"target").getString("uri")) }catch(e: Exception){null} }
      val copy=job.getString("mode")=="copy"
      val sourcePath=if(copy)requireNotNull(direct.resolve(source.getString("uri"))) { "Source access unavailable" }else null
      val targetPaths=targetRoots.map { it?.let { uri -> direct.resolve(uri.toString())?.path } }
      val isolated=mutableSetOf<Int>()
      if(copy)isolated.addAll(store.isolatedTargets(id))
      val totalFiles=job.getInt("totalFiles")
      for(i in store.resultCount(id) until totalFiles){
        if(!gate.awaitChunk())break
        val entry=store.capturedAt(id,i);val relative=entry.getString("relativePath")
        val file=JSONObject().put("relativePath",relative).put("bytes",entry.getLong("bytes"))
        gate.recovery={ target -> store.get("commit","$id:$i:$target")?.let { if(it.getLong("bytes")==entry.getLong("bytes")&&it.getString("relative")==relative&&it.getString("rootId")==ids.getString(target))it.getString("hash") else "" } ?: "" }
        gate.commitIntent={ target,hash,bytes -> require(bytes==entry.getLong("bytes"));store.put("commit","$id:$i:$target",JSONObject().put("hash",hash).put("bytes",bytes).put("relative",relative).put("rootId",ids.getString(target))) }

        try {
          try { root(job.getString("sourceRootId"),"source");for(t in 0 until ids.length()){val currentTarget=root(ids.getString(t),"target");if(copy)require(currentTarget.optBoolean("writable")) { "目标写入授权不可用，请重新选择" }} }
          catch(e: Exception){gate.interruption="磁盘已断开或授权失效，请检查后继续";gate.cancelled=true;break}
          require(accessible(source.getString("uri")))
          val result = if(copy) {
            require(android.os.Environment.isExternalStorageManager()) { "Storage permission revoked" }
            JSONObject(copyFile(sourcePath!!.path,targetPaths.mapIndexed { index,path -> if(index in isolated || targetRoots[index]?.let { direct.resolve(it.toString()) }==null) "" else path ?: "" }.toTypedArray(),relative,job.getString("hashAlgorithm"),entry.getLong("bytes"),gate))
          } else {
            context.contentResolver.openFileDescriptor(Uri.parse(entry.getString("uri")),"r").use { sourceFd ->
              requireNotNull(sourceFd)
              val opened=targetRoots.map { uri -> try { if(uri==null)null else context.contentResolver.openFileDescriptor(resolve(uri,relative),"r") }catch(e: Exception){null} }
              try { JSONObject(verifyFile(sourceFd.fd,opened.map { it?.fd ?: -1 }.toIntArray(),job.getString("hashAlgorithm"),entry.getLong("bytes"),gate)) }
              finally { opened.forEach { it?.close() } }
            }
          }
          // A disappeared volume or revoked grant is recoverable, not a failed file checkpoint.
          // Keep commit intents so a verified publish can be reconciled on explicit resume.
          if(gate.interruption!=null)break
          try { root(job.getString("sourceRootId"),"source");for(t in 0 until ids.length()){val currentTarget=root(ids.getString(t),"target");if(copy)require(currentTarget.optBoolean("writable")) { "目标写入授权不可用，请重新选择" }} }
          catch(e: Exception){gate.interruption="磁盘已断开或授权失效，请检查后继续";gate.cancelled=true;break}
          val targets=result.getJSONArray("targets");for(t in 0 until targets.length()) {
            targets.getJSONObject(t).put("rootId",ids.getString(t))
            if(copy&&targets.getJSONObject(t).getString("status")=="failed"&&!result.optBoolean("sourceFailed"))isolated.add(t)
          }
          file.put("sourceHash",result.optString("sourceHash")).put("bytes",result.getLong("bytes")).put("targets",targets)
          file.put("sourceFailed",result.optBoolean("sourceFailed")).put("cancelled",result.optBoolean("cancelled"))
        }catch(e: Exception){file.put("sourceFailed",true).put("sourceHash","").put("targets",JSONArray().also { a -> for(t in 0 until ids.length())a.put(JSONObject().put("rootId",ids.getString(t)).put("status","failed").put("bytes",0).put("hash","")) })}
        synchronized(lock){
          job=store.appendResult(id,i,file)
          if(!file.optBoolean("sourceFailed")&&!file.optBoolean("cancelled"))for(target in 0 until ids.length())store.remove("commit","$id:$i:$target")

        }
        if(file.optBoolean("sourceFailed")||file.optBoolean("cancelled"))break
      }
      synchronized(lock){
        job=store.get("job",id)!!
        val last=store.lastResult(id)
        if(gate.interruption!=null)job.put("state","interrupted").put("phase",gate.interruption)
        if(job.getString("state")!="interrupted")job.put("state",SafetyPolicy.finalState(last?.optBoolean("sourceFailed")==true,gate.cancelled,job.getInt("filesFailed"),job.optBoolean("_anyVerified")))
        store.put("job",id,job)
      }
    }catch(e: Exception){synchronized(lock){job=store.get("job",id)!!;if(job.getString("state")!="interrupted")job.put("state","interrupted").put("phase",if(e.message in setOf("共享容量不足","目标剩余容量未知，无法开始拷贝","存储风险或位置已改变，请重新预检并明确确认"))e.message+"，请重新预检后继续" else "运行中断，请检查磁盘与授权后继续");store.put("job",id,job)}}
    finally { gates.remove(id);if(!hasWork())context.stopService(Intent(context,NativeJobService::class.java)) }
  }
  companion object {
    init { System.loadLibrary("securereel_android") }
    @Volatile private var shared: JobEngine?=null
    fun get(context: Context): JobEngine = shared ?: synchronized(this){shared ?: JobEngine(context.applicationContext).also { shared=it }}
  }
}
