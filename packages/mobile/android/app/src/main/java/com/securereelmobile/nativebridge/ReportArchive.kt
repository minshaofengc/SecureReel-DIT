// SPDX-License-Identifier: GPL-3.0-only
package com.securereelmobile.nativebridge
import android.content.Context
import android.content.Intent
import android.graphics.Paint
import android.graphics.pdf.PdfDocument
import androidx.core.content.FileProvider
import org.json.JSONObject
import org.json.JSONArray
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardOpenOption
internal class ReportArchive(private val context: Context,private val engine: JobEngine) {
  private val archive=File(context.filesDir,"reports").apply { mkdirs() }
  @Synchronized fun save(jobId: String, raw: String): JSONObject {
    require(jobId.matches(Regex("job_[a-f0-9]{32}")))
    val job=engine.getJob(jobId)
    require(SafetyPolicy.terminal(job.getString("state"))) { "Reports require a finished task" }
    val bundle=JSONObject(raw);require(raw.toByteArray().size<=16*1024*1024)
    val submitted=JSONObject(bundle.getString("json"))
    for(key in listOf("id","name","mode","state","totalFiles","totalBytes","filesDone","filesFailed","bytesDone","sourceRootId","targetRootIds","hashAlgorithm","manifestFormat"))require(equalValue(job.get(key),submitted.get(key))) { "Report does not match the saved task" }
    val nativeFiles=job.getJSONArray("files");val submittedFiles=submitted.getJSONArray("files");require(nativeFiles.length()==submittedFiles.length())
    for(i in 0 until nativeFiles.length()){val actual=nativeFiles.getJSONObject(i);val input=submittedFiles.getJSONObject(i);for(key in listOf("relativePath","bytes","sourceHash","targets"))require(equalValue(actual.get(key),input.get(key)))}
    val groundTruth=JSONObject(job.toString()).apply { remove("captured");put("format","securereel-mobile-report");put("version",1) }

    validateManifest(job,bundle.getString("manifest"))
    val manifestName=bundle.getString("manifestName");SafetyPolicy.relative(manifestName);require(!manifestName.contains('/'));require(manifestName.length<=128)
    val jobDir=File(archive,jobId).apply { mkdirs() };var revision=1;var folder: File
    while(true){folder=File(jobDir,"R%03d".format(java.util.Locale.ROOT,revision));if(folder.mkdir())break;require(folder.exists());revision++;require(revision<100000)}
    fun write(name: String, content: String) { Files.write(File(folder,name).toPath(),content.toByteArray(Charsets.UTF_8),StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE) }
    try {
      write("report.html",nativeHtml(job));write("report.json",groundTruth.toString(2));write(manifestName,bundle.getString("manifest"))
      // A real native summary PDF, independent of WebView print lifecycle. HTML retains the full detailed layout.
      val pdf=PdfDocument();try {
        val paint=Paint().apply { textSize=11f }
        val lines=mutableListOf((if(job.getString("mode")=="verify")"素材复核报告" else "素材拷贝与校验报告"),job.getString("name"),"执行设备：本机（安卓）","母项目："+job.optString("parentProjectName").takeUnless { it=="null" }.orEmpty(),"来源："+job.optString("sourceLabel",job.getString("sourceRootId")),"状态："+display(job.getString("state")),"校验算法："+job.getString("hashAlgorithm"),"已校验文件："+job.getInt("filesDone")+" / "+job.getInt("totalFiles"),"失败文件："+job.getInt("filesFailed"),"完整校验值及各目标结果同时保存在 JSON 和 HTML 报告。")
        lines.addAll(projectLines(job));lines.addAll(safetyLines(job))
        val files=job.getJSONArray("files");for(i in 0 until files.length()){val f=files.getJSONObject(i);lines.add(f.getString("relativePath"));lines.add(f.optString("sourceHash"));val ts=f.getJSONArray("targets");for(t in 0 until ts.length()){val v=ts.getJSONObject(t);lines.add((job.optJSONObject("targetLabels")?.optString(v.getString("rootId"))?.takeIf { it.isNotEmpty() } ?: v.getString("rootId"))+"："+display(v.getString("status")));lines.add(v.optString("hash"))}}
        val wrapped=lines.flatMap { wrap(it,paint,523f) }
        wrapped.chunked(45).forEachIndexed { index, pageLines -> val page=pdf.startPage(PdfDocument.PageInfo.Builder(595,842,index+1).create());pageLines.forEachIndexed { i,line -> page.canvas.drawText(line,36f,48f+i*16f,paint) };pdf.finishPage(page) }
        Files.newOutputStream(File(folder,"report.pdf").toPath(),StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE).use { pdf.writeTo(it) }
      }finally{pdf.close()}
      val report=JSONObject().put("id","${jobId}_R%03d".format(java.util.Locale.ROOT,revision)).put("jobId",jobId).put("revision",revision).put("createdAt",java.time.Instant.now().toString()).put("formats",JSONArray(listOf("html","json","manifest","pdf"))).put("manifestName",manifestName)
      write("index.json",report.toString());return report
    }catch(e: Exception){throw IllegalStateException("Report could not be archived")}
  }
  private fun validateManifest(job: JSONObject,manifest: String) {
    val files=job.getJSONArray("files")
    val verified=JSONArray();for(i in 0 until files.length()){val file=files.getJSONObject(i);val targets=file.getJSONArray("targets");if((0 until targets.length()).any { val target=targets.getJSONObject(it);target.getString("status")=="verified"&&target.getString("hash")==file.getString("sourceHash") })verified.put(file)}
    when(job.getString("manifestFormat")) {
      "json" -> { val value=JSONObject(manifest);require(value.getString("algorithm")==job.getString("hashAlgorithm"));require(equalValue(verified,value.getJSONArray("files"))) }
      "csv" -> {
        fun csv(value: String): String {val safe=if(value.trimStart().firstOrNull() in listOf('=','+','-','@'))"'"+value else value;return "\""+safe.replace("\"","\"\"")+"\""}
        val rows=mutableListOf<String>();for(i in 0 until files.length()){val file=files.getJSONObject(i);val targets=file.getJSONArray("targets");for(t in 0 until targets.length()){val target=targets.getJSONObject(t);rows.add(listOf(file.getString("relativePath"),file.getLong("bytes").toString(),job.getString("hashAlgorithm"),file.getString("sourceHash"),target.getString("rootId"),target.getString("hash"),target.getString("status")).joinToString(","){csv(it)})}}
        require(manifest=="\ufeff\"path\",\"size\",\"algorithm\",\"source_hash\",\"target\",\"target_hash\",\"status\"\r\n"+rows.joinToString("\r\n"))
      }
      else -> {
        require(!manifest.contains("<!DOCTYPE",ignoreCase=true)) { "DTD is not permitted" }
        val factory=javax.xml.parsers.DocumentBuilderFactory.newInstance().apply { isNamespaceAware=true;isValidating=false;isExpandEntityReferences=false }
        val document=factory.newDocumentBuilder().parse(java.io.ByteArrayInputStream(manifest.toByteArray(Charsets.UTF_8)))
        val hashes=document.getElementsByTagNameNS("*","hash");require(hashes.length==verified.length())
        val element=when(job.getString("hashAlgorithm")){"xxhash64"->if(job.getString("manifestFormat")=="asc-mhl-2.0")"xxh64" else "xxhash64";"asc-c4"->"c4";else->job.getString("hashAlgorithm")}
        for(i in 0 until hashes.length){val hash=hashes.item(i) as org.w3c.dom.Element;val file=verified.getJSONObject(i)
          fun text(name: String): String {val nodes=hash.getElementsByTagNameNS("*",name);require(nodes.length==1);return nodes.item(0).textContent}
          val pathName=if(hash.getElementsByTagNameNS("*","path").length==1)"path" else "file"
          require(text(pathName)==file.getString("relativePath"));val size=if(job.getString("manifestFormat")=="asc-mhl-2.0")(hash.getElementsByTagNameNS("*",pathName).item(0) as org.w3c.dom.Element).getAttribute("size")else text("size");require(size==file.getLong("bytes").toString());require(text(element)==file.getString("sourceHash"))
        }
      }
    }
  }
  private fun equalValue(expected: Any,actual: Any): Boolean = when {
    expected is JSONObject && actual is JSONObject -> expected.keys().asSequence().filter { it !in listOf("sourceFailed","cancelled") }.all { actual.has(it)&&equalValue(expected.get(it),actual.get(it)) } && actual.keys().asSequence().all { expected.has(it) }
    expected is JSONArray && actual is JSONArray -> expected.length()==actual.length() && (0 until expected.length()).all { equalValue(expected.get(it),actual.get(it)) }
    expected is Number && actual is Number -> expected.toDouble()==actual.toDouble()
    else -> expected==actual
  }
  private fun wrap(raw: String,paint: Paint,width: Float): List<String> {
    val out=mutableListOf<String>()
    for(line in raw.replace("\r\n","\n").replace('\r','\n').map { if(it<' '&&it!='\n')' 'else it }.joinToString("").split('\n')){
      if(line.isEmpty()){out.add("");continue}
      var start=0;while(start<line.length){var end=start;var fit=start
        while(end<line.length){end+=Character.charCount(line.codePointAt(end));if(paint.measureText(line.substring(start,end))>width && fit>start)break;fit=end}
        out.add(line.substring(start,fit));start=fit
      }
    }
    return out
  }
  private fun display(value: String): String = when(value){"completed"->"已完成";"completed-with-errors"->"部分失败";"failed"->"失败";"cancelled"->"已取消";"verified"->"已校验";"collision"->"重名冲突";"mismatch"->"校验不一致";else->value}
  private fun escape(value: String)=value.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("\"","&quot;").replace("'","&#39;")
  private fun projectLines(job: JSONObject): List<String> {
    val project=job.optJSONObject("project") ?: return emptyList()
    val lines=mutableListOf<String>()
    for((key,label) in listOf("projectName" to "项目名称","shootDay" to "拍摄日期","camera" to "摄影机","cardLabel" to "卡号","notes" to "项目备注","copyNotes" to "本次拷贝备注")){val value=project.optString(key);if(value.isNotEmpty())lines.add("$label：$value")}
    for((key,label) in listOf("crew" to "拍摄人员","lenses" to "镜头")){val rows=project.optJSONArray(key) ?: continue;for(i in 0 until rows.length()){val row=rows.getJSONObject(i);lines.add(label+"："+if(key=="crew")row.optString("role")+" · "+row.optString("name") else row.optString("model")+" · "+row.optString("detail"))}}
    return lines
  }
  private fun safetyLines(job: JSONObject): List<String> {
    val safety=job.optJSONObject("backupSafety") ?: return emptyList()
    val lines=mutableListOf("备份存储安全", "独立物理设备组："+if(safety.isNull("independentDeviceGroups"))"未知" else safety.getInt("independentDeviceGroups").toString(),"预检时间："+safety.getString("checkedAt"),"预检身份："+safety.getString("fingerprint"))
    val risks=safety.getJSONArray("risks");for(i in 0 until risks.length())lines.add(when(risks.getJSONObject(i).getString("code")){"shared-filesystem","shared-device"->"多个目标共享存储卷或设备，不能算作独立物理备份";"independence-unknown"->"无法确认物理设备独立性；卷标不同不代表独立硬盘";"source-device"->"来源与目标共享物理设备";else->"目标容量不足或未知"})
    val groups=safety.getJSONArray("groups");for(i in 0 until groups.length()){val group=groups.getJSONObject(i);lines.add("共享容量组："+group.getString("id")+"；需 "+group.getLong("requiredBytes")+" 字节；可用 "+if(group.isNull("availableBytes"))"未知" else group.getLong("availableBytes").toString()+" 字节")}
    lines.addAll(safety.toString(2).split("\n"))
    return lines
  }
  private fun nativeHtml(job: JSONObject): String {
    val rows=StringBuilder();val files=job.getJSONArray("files")
    for(i in 0 until files.length()){val file=files.getJSONObject(i);rows.append("<tr><td>").append(escape(file.getString("relativePath"))).append("</td><td>").append(file.getLong("bytes")).append("</td><td>").append(escape(file.getString("sourceHash"))).append("</td><td>")
      val targets=file.getJSONArray("targets");for(t in 0 until targets.length()){val target=targets.getJSONObject(t);val id=target.getString("rootId");val label=job.optJSONObject("targetLabels")?.optString(id)?.takeIf { it.isNotEmpty() } ?: id;rows.append(escape(label)).append(": ").append(escape(display(target.getString("status")))).append("<br>").append(escape(target.getString("hash"))).append("<br>")};rows.append("</td></tr>")
    }
    return "<!doctype html><html><head><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><style>body{font:14px sans-serif;padding:24px}td,th{border:1px solid;padding:8px;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}</style></head><body><h1>SecureReel DIT</h1><p>"+escape(job.getString("name"))+"</p><p>"+(if(job.getString("mode")=="verify")"仅校验" else "拷贝与校验")+" · "+escape(display(job.getString("state")))+" · "+escape(job.getString("hashAlgorithm"))+"</p><p>执行设备：本机（安卓）</p><p>母项目："+escape(job.optString("parentProjectName").takeUnless { it=="null" }.orEmpty())+"</p>"+(projectLines(job)+safetyLines(job)).joinToString(""){"<p>"+escape(it)+"</p>"}+"<p>来源："+escape(job.optString("sourceLabel",job.getString("sourceRootId")))+"</p><p>已校验文件："+job.getInt("filesDone")+" / "+job.getInt("totalFiles")+"；失败文件："+job.getInt("filesFailed")+"</p><table><thead><tr><th>文件</th><th>字节数</th><th>源校验值</th><th>各目标结果</th></tr></thead><tbody>"+rows+"</tbody></table></body></html>"
  }
  fun reports(jobId: String): JSONArray {
    require(jobId.matches(Regex("job_[a-f0-9]{32}")));return JSONArray().also { a -> File(archive,jobId).listFiles()?.sortedBy { it.name }?.forEach { f -> val index=File(f,"index.json");if(index.isFile)a.put(JSONObject(index.readText())) } }
  }
  fun share(id: String,kind: String): Boolean {
    val m=Regex("(job_[a-f0-9]{32})_(R[0-9]{3,5})").matchEntire(id) ?: error("Report unavailable")
    require(kind in listOf("html","json","manifest","pdf"))
    val folder=File(File(archive,m.groupValues[1]),m.groupValues[2]);val index=JSONObject(File(folder,"index.json").readText())
    val filename=when(kind){"manifest"->index.getString("manifestName");else->"report.$kind"};SafetyPolicy.relative(filename)
    return shareFile(File(folder,filename),kind)
  }
  fun sharePeer(bytes: ByteArray,kind: String): Boolean {
    require(kind in listOf("html","json","pdf"));val file=File(context.cacheDir,"shared-reports/${java.util.UUID.randomUUID()}.$kind");file.parentFile!!.mkdirs();Files.write(file.toPath(),bytes,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE);return shareFile(file,kind)
  }
  private fun shareFile(file: File,kind: String): Boolean {
    require(file.isFile)
    val uri=FileProvider.getUriForFile(context,context.packageName+".reports",file)
    val intent=Intent(Intent.ACTION_SEND).setType(when(kind){"pdf"->"application/pdf";"html"->"text/html";"json"->"application/json";else->"application/octet-stream"}).putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    intent.clipData=android.content.ClipData.newRawUri("SecureReel report",uri)
    context.startActivity(Intent.createChooser(intent,"Share report").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));return true
  }
}
