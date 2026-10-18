// SPDX-License-Identifier: GPL-3.0-only
package com.securereelmobile.nativebridge
import org.json.JSONObject
import org.json.JSONArray
import java.time.Instant
import java.util.UUID

/** Validation shared by persistence and task capture; returned JSON never aliases mutable input. */
internal object ProjectData {
 private val limits=mapOf("projectName" to 160,"shootDay" to 40,"camera" to 120,"notes" to 4000,"cardLabel" to 120,"copyNotes" to 4000)
 private fun text(value: JSONObject,key: String,max: Int,default: String=""): String {
  if(!value.has(key))return default
  require(value.get(key) is String);val result=value.getString(key);require(result.length<=max&&!result.contains('\u0000'));return result
 }
 fun details(input: JSONObject,base: JSONObject?=null,task: Boolean=false): JSONObject {
  val allowed=if(task)limits.keys+setOf("lenses","crew") else limits.keys-setOf("cardLabel","copyNotes")+setOf("lenses","crew")
  require(input.keys().asSequence().all { it in allowed })
  val out=JSONObject()
  for(key in allowed-setOf("crew","lenses"))out.put(key,text(input,key,limits.getValue(key),base?.optString(key) ?: ""))
  for(key in listOf("crew","lenses")){
   val rows=if(input.has(key)){require(input.get(key) is JSONArray);input.getJSONArray(key)}else base?.optJSONArray(key) ?: JSONArray()
   require(rows.length()<=if(key=="crew")50 else 40)
   val keys=if(key=="crew")setOf("role","name") else setOf("model","detail");val size=if(key=="crew")80 else 120
   val normalized=JSONArray();for(i in 0 until rows.length()){val row=rows.getJSONObject(i);require(row.keys().asSequence().all { it in keys });normalized.put(JSONObject().also { v->keys.forEach { v.put(it,text(row,it,size)) } })};out.put(key,normalized)
  }
  return out
 }
 fun migrate(old: JSONObject): JSONObject {
  if(old.has("details"))return JSONObject(old.toString())
  val flat=details(JSONObject());for(key in limits.keys-setOf("cardLabel","copyNotes")){if(old.opt(key) is String)flat.put(key,old.get(key))};for(key in listOf("crew","lenses"))if(old.opt(key) is JSONArray)flat.put(key,JSONArray(old.getJSONArray(key).toString()))
  if(!old.has("projectName"))flat.put("projectName",old.getString("name"))
  val now=Instant.now().toString()
  return JSONObject().put("id",old.getString("id")).put("name",old.getString("name")).put("details",flat).put("createdAt",old.optString("createdAt",now)).put("updatedAt",old.optString("updatedAt",now))
 }
 fun save(input: JSONObject,previous: JSONObject?): JSONObject {
  require(input.keys().asSequence().all { it in setOf("id","name","details","createdAt","updatedAt","notes","camera","shootDay","crew","lenses","projectName") })
  val prior=previous?.let { migrate(it) }
  val id=text(input,"id",64,prior?.getString("id") ?: "prj_"+UUID.randomUUID().toString().replace("-",""));require(id.matches(Regex("prj_[a-f0-9]{32}")))
  require(prior==null||prior.getString("id")==id)
  val name=text(input,"name",120,prior?.getString("name") ?: "").trim();require(name.isNotEmpty())
  val data=if(input.has("details"))input.getJSONObject("details") else JSONObject().also { value->for(key in limits.keys-setOf("cardLabel","copyNotes")+setOf("crew","lenses"))if(input.has(key))value.put(key,input.get(key)) }
  val now=Instant.now().toString()
  return JSONObject().put("id",id).put("name",name).put("details",details(data,prior?.getJSONObject("details"))).put("createdAt",prior?.getString("createdAt") ?: now).put("updatedAt",now)
 }
 fun taskProject(input: JSONObject,parent: JSONObject?): JSONObject=details(input,parent?.let { migrate(it).getJSONObject("details") },true)
 fun notificationJob(jobs: JSONArray): JSONObject? { val list=(0 until jobs.length()).map { jobs.getJSONObject(it) };return listOf("running","paused","queued").firstNotNullOfOrNull { state -> list.firstOrNull { it.optString("state")==state } } }
 fun validateMutationKey(key: String) { require(key.length in 1..512&&!key.contains('\u0000')) }
 fun settings(input: JSONObject,previous: JSONObject?): JSONObject {
  val allowed=setOf("themeMode","hashAlgorithm","manifestFormat","keepScreenOn","onboardingDone");require(input.keys().asSequence().all { it in allowed })
  val out=JSONObject(previous?.toString() ?: "{\"themeMode\":\"system\",\"hashAlgorithm\":\"xxhash64\",\"manifestFormat\":\"asc-mhl-2.0\",\"keepScreenOn\":false,\"onboardingDone\":false}")
  for(key in allowed)if(input.has(key)){require(if(key in setOf("keepScreenOn","onboardingDone"))input.get(key) is Boolean else input.get(key) is String);out.put(key,input.get(key))}
  require(out.getString("themeMode") in listOf("system","light","dark"));val algorithm=out.getString("hashAlgorithm");val format=out.getString("manifestFormat")
  require(algorithm in listOf("xxhash64","xxh3","xxh128","md5","sha1","sha256","asc-c4"));require(format in listOf("asc-mhl-2.0","mhl-v1","csv","json"));require(!(format=="asc-mhl-2.0"&&algorithm=="sha256"));require(format!="mhl-v1"||algorithm in listOf("xxhash64","md5","asc-c4"))
  return out
 }
}
