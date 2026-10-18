package com.securereelmobile.nativebridge
import org.json.JSONObject
import org.json.JSONArray
fun main() {
 val old=JSONObject().put("id","prj_"+"a".repeat(32)).put("name","电影").put("camera","ALEXA").put("notes","旧备注")
 val longOld=JSONObject(old.toString()).put("notes","旧".repeat(5000))
 check(ProjectData.migrate(longOld).getJSONObject("details").getString("notes").length==5000)
 val migrated=ProjectData.migrate(old)
 check(migrated.getJSONObject("details").getString("projectName")=="电影")
 check(migrated.getJSONObject("details").getString("camera")=="ALEXA") { "legacy project must retain camera inside full details" }
 val full=ProjectData.save(JSONObject().put("id",old.getString("id")).put("name","电影").put("details",JSONObject().put("crew",JSONArray().put(JSONObject().put("role","摄影师").put("name","张三"))).put("lenses",JSONArray().put(JSONObject().put("model","35mm").put("detail","T2")))),migrated)
 val edited=ProjectData.save(JSONObject().put("id",old.getString("id")).put("name","新名字"),full)
 check(edited.getJSONObject("details").getJSONArray("crew").getJSONObject(0).getString("name")=="张三")
 check(edited.getString("createdAt")==migrated.getString("createdAt"))
 val snapshot=ProjectData.taskProject(JSONObject().put("cardLabel","A001"),full)
 full.getJSONObject("details").getJSONArray("crew").getJSONObject(0).put("name","改名")
 check(snapshot.getJSONArray("crew").getJSONObject(0).getString("name")=="张三")
 check(snapshot.getString("cardLabel")=="A001")
 check(runCatching { ProjectData.save(JSONObject().put("name","bad").put("details",JSONObject().put("crew",JSONArray().also { a->repeat(51){a.put(JSONObject().put("role","").put("name",""))} })),null) }.isFailure)
 ProjectData.validateMutationKey("client:"+"a".repeat(320)+":/jobs/"+"b".repeat(64))
 check(runCatching { ProjectData.validateMutationKey("a".repeat(513)) }.isFailure)
 check(ProjectData.notificationJob(JSONArray().put(JSONObject().put("state","queued").put("id","queued")).put(JSONObject().put("state","paused").put("id","paused")).put(JSONObject().put("state","running").put("id","running")))?.getString("id")=="running")
 val defaults=ProjectData.settings(JSONObject(),null)
 check(defaults.getString("themeMode")=="system"&&!defaults.getBoolean("keepScreenOn"))
 check(runCatching { ProjectData.settings(JSONObject().put("hashAlgorithm","sha256").put("manifestFormat","asc-mhl-2.0"),defaults) }.isFailure)
 println("PASS project migration, omitted details preservation, immutable task snapshot, limits and settings validation")
}
