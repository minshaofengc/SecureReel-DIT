// SPDX-License-Identifier: GPL-3.0-only
package com.securereelmobile.nativebridge
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.content.ContentValues
import org.json.JSONObject
import org.json.JSONArray

internal class CheckpointStore(context: Context,name: String="mobile-checkpoints.sqlite"): SQLiteOpenHelper(context,name,null,2) {
  private fun filesSchema(db: SQLiteDatabase) { db.execSQL("CREATE TABLE file_checkpoints(job_id TEXT NOT NULL,position INTEGER NOT NULL,captured TEXT NOT NULL,result TEXT,PRIMARY KEY(job_id,position))") }
  override fun onCreate(db: SQLiteDatabase) { db.execSQL("CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id))");filesSchema(db) }
  override fun onUpgrade(db: SQLiteDatabase,old: Int,version: Int) {
    check(old==1&&version==2);filesSchema(db)
    val ids=mutableListOf<String>();db.rawQuery("SELECT id FROM records WHERE kind='job'",null).use { cursor -> while(cursor.moveToNext())ids.add(cursor.getString(0)) }
    for(id in ids){
      val job=read(db,"job",id)!!;val captured=job.optJSONArray("captured") ?: JSONArray();val results=job.optJSONArray("files") ?: JSONArray()
      for(i in 0 until captured.length()){
        val values=ContentValues().apply { put("job_id",id);put("position",i);put("captured",captured.getJSONObject(i).toString());if(i<results.length())put("result",results.getJSONObject(i).toString()) }
        check(db.insertOrThrow("file_checkpoints",null,values)!=-1L)
      }
      job.remove("captured");job.remove("files");write(db,"job",id,job);recount(db,id)
    }
  }
  private fun write(db: SQLiteDatabase,kind: String,id: String,value: JSONObject) { check(db.insertWithOnConflict("records",null,ContentValues().apply { put("kind",kind);put("id",id);put("json",value.toString()) },SQLiteDatabase.CONFLICT_REPLACE)!=-1L) }
  private fun read(db: SQLiteDatabase,kind: String,id: String): JSONObject? = db.rawQuery("SELECT json FROM records WHERE kind=? AND id=?",arrayOf(kind,id)).use { if(it.moveToFirst())JSONObject(it.getString(0))else null }
  @Synchronized fun put(kind: String,id: String,value: JSONObject) { write(writableDatabase,kind,id,value) }
  @Synchronized fun all(kind: String): JSONArray=JSONArray().also { result -> readableDatabase.rawQuery("SELECT json FROM records WHERE kind=? ORDER BY rowid",arrayOf(kind)).use { while(it.moveToNext())result.put(JSONObject(it.getString(0))) } }
  @Synchronized fun get(kind: String,id: String): JSONObject?=read(readableDatabase,kind,id)
  @Synchronized fun remove(kind: String,id: String) { writableDatabase.delete("records","kind=? AND id=?",arrayOf(kind,id)) }
  @Synchronized fun createJob(job: JSONObject,captured: JSONArray) {
    val db=writableDatabase;db.beginTransaction();try {
      val id=job.getString("id");check(read(db,"job",id)==null);write(db,"job",id,job)
      for(i in 0 until captured.length())check(db.insertOrThrow("file_checkpoints",null,ContentValues().apply {put("job_id",id);put("position",i);put("captured",captured.getJSONObject(i).toString())})!=-1L)
      db.setTransactionSuccessful()
    }finally{db.endTransaction()}
  }
  @Synchronized fun capturedAt(id: String,index: Int): JSONObject=readableDatabase.rawQuery("SELECT captured FROM file_checkpoints WHERE job_id=? AND position=?",arrayOf(id,index.toString())).use { check(it.moveToFirst());JSONObject(it.getString(0)) }
  @Synchronized fun resultCount(id: String): Int=read(readableDatabase,"job",id)!!.let { it.getInt("filesDone")+it.getInt("filesFailed") }
  @Synchronized fun results(id: String): JSONArray=JSONArray().also { array -> readableDatabase.rawQuery("SELECT result FROM file_checkpoints WHERE job_id=? AND result IS NOT NULL ORDER BY position",arrayOf(id)).use { while(it.moveToNext())array.put(JSONObject(it.getString(0))) } }
  @Synchronized fun lastResult(id: String): JSONObject?=readableDatabase.rawQuery("SELECT result FROM file_checkpoints WHERE job_id=? AND result IS NOT NULL ORDER BY position DESC LIMIT 1",arrayOf(id)).use { if(it.moveToFirst())JSONObject(it.getString(0))else null }
  @Synchronized fun isolatedTargets(id: String): Set<Int> {
    val isolated=mutableSetOf<Int>();readableDatabase.rawQuery("SELECT result FROM file_checkpoints WHERE job_id=? AND result IS NOT NULL",arrayOf(id)).use { while(it.moveToNext()){val file=JSONObject(it.getString(0));if(!file.optBoolean("sourceFailed")){val targets=file.getJSONArray("targets");for(t in 0 until targets.length())if(targets.getJSONObject(t).getString("status")=="failed")isolated.add(t)}} };return isolated
  }
  private fun success(file: JSONObject): Boolean {val targets=file.getJSONArray("targets");return SafetyPolicy.fileSuccessful(file.optBoolean("sourceFailed"),(0 until targets.length()).map { targets.getJSONObject(it).getString("status") }.toTypedArray())}
  @Synchronized fun appendResult(id: String,index: Int,file: JSONObject): JSONObject {
    val db=writableDatabase;db.beginTransaction();try {
      check(index==resultCount(id))
      check(db.update("file_checkpoints",ContentValues().apply {put("result",file.toString())},"job_id=? AND position=? AND result IS NULL",arrayOf(id,index.toString()))==1)
      val job=read(db,"job",id)!!;val okay=success(file)
      job.put("filesDone",job.getInt("filesDone")+if(okay)1 else 0).put("filesFailed",job.getInt("filesFailed")+if(okay)0 else 1).put("bytesDone",job.getLong("bytesDone")+file.getLong("bytes"))
      val targets=file.getJSONArray("targets");job.put("_anyVerified",job.optBoolean("_anyVerified")||(0 until targets.length()).any { targets.getJSONObject(it).getString("status")=="verified" })
      job.put("totalBytes",maxOf(job.getLong("totalBytes"),job.getLong("bytesDone")));write(db,"job",id,job);db.setTransactionSuccessful();return job
    }finally{db.endTransaction()}
  }
  private fun recount(db: SQLiteDatabase,id: String) {
    val job=read(db,"job",id)!!;var done=0;var failed=0;var bytes=0L;var any=false
    db.rawQuery("SELECT result FROM file_checkpoints WHERE job_id=? AND result IS NOT NULL ORDER BY position",arrayOf(id)).use { while(it.moveToNext()){val file=JSONObject(it.getString(0));if(success(file))done++ else failed++;bytes+=file.getLong("bytes");val targets=file.getJSONArray("targets");if((0 until targets.length()).any { targets.getJSONObject(it).getString("status")=="verified" })any=true} }
    job.put("filesDone",done).put("filesFailed",failed).put("bytesDone",bytes).put("_anyVerified",any);write(db,"job",id,job)
  }
  @Synchronized fun retryIncomplete(id: String): JSONObject {
    val db=writableDatabase;db.beginTransaction();try {
      while(true){
        val last=db.rawQuery("SELECT position,result FROM file_checkpoints WHERE job_id=? AND result IS NOT NULL ORDER BY position DESC LIMIT 1",arrayOf(id)).use { if(it.moveToFirst())Pair(it.getInt(0),JSONObject(it.getString(1)))else null } ?: break
        if(!last.second.optBoolean("cancelled")&&!last.second.optBoolean("sourceFailed"))break
        check(db.update("file_checkpoints",ContentValues().apply {putNull("result")},"job_id=? AND position=?",arrayOf(id,last.first.toString()))==1)
      }
      recount(db,id);db.setTransactionSuccessful();return read(db,"job",id)!!
    }finally{db.endTransaction()}
  }
  @Synchronized fun projects(): JSONArray=all("project").also { projects -> for(i in 0 until projects.length()){val old=projects.getJSONObject(i);val migrated=ProjectData.migrate(old);if(!old.has("details"))put("project",old.getString("id"),migrated);projects.put(i,migrated)} }
  @Synchronized fun saveProject(input: JSONObject): JSONObject {
    val id=input.optString("id");val saved=ProjectData.save(input,if(id.isEmpty())null else get("project",id));put("project",saved.getString("id"),saved);return saved
  }
  @Synchronized fun getSettings(): JSONObject=ProjectData.settings(JSONObject(),get("settings","preferences"))
  @Synchronized fun saveSettings(input: JSONObject): JSONObject=ProjectData.settings(input,get("settings","preferences")).also { put("settings","preferences",it) }
  @Synchronized fun pendingMutation(key: String,body: String): JSONObject {
    ProjectData.validateMutationKey(key);require(body.toByteArray(Charsets.UTF_8).size<=65536);JSONObject(body)
    return get("pending-mutation",key) ?: JSONObject().put("requestId",java.util.UUID.randomUUID().toString()).put("body",body).also { put("pending-mutation",key,it) }
  }
  @Synchronized fun getPendingMutation(key: String): JSONObject? { ProjectData.validateMutationKey(key);return get("pending-mutation",key) }
  @Synchronized fun completeMutation(key: String) { ProjectData.validateMutationKey(key);remove("pending-mutation",key) }
  @Synchronized fun recover() { val jobs=all("job");for(i in 0 until jobs.length()){val job=jobs.getJSONObject(i);if(job.getString("state") in listOf("queued","running","paused")){job.put("state","interrupted");put("job",job.getString("id"),job)}} }
}
