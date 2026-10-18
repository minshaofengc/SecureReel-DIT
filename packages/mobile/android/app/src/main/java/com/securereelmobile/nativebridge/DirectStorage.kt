// SPDX-License-Identifier: GPL-3.0-only
package com.securereelmobile.nativebridge
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.os.storage.StorageManager
import android.provider.DocumentsContract
import java.io.File
internal class DirectStorage(private val context: Context) {
  private external fun probe(root: String): Boolean
  fun resolve(raw: String): File? {
    if(!Environment.isExternalStorageManager())return null
    val uri=Uri.parse(raw)
    if(uri.authority!="com.android.externalstorage.documents" || !DocumentsContract.isTreeUri(uri))return null
    if(!context.contentResolver.persistedUriPermissions.any { it.uri==uri&&it.isReadPermission })return null
    return try {
      val document=DocumentsContract.getTreeDocumentId(uri)
      val separator=document.indexOf(':');require(separator>0)
      val volumeId=document.substring(0,separator)
      val relative=document.substring(separator+1)
      if(relative.isNotEmpty())SafetyPolicy.relative(relative)
      val volumes=context.getSystemService(StorageManager::class.java).storageVolumes
      val volume=volumes.singleOrNull { if(volumeId=="primary")it.isPrimary else it.uuid?.equals(volumeId,true)==true } ?: return null
      val directory=volume.directory?.canonicalFile ?: return null
      val candidate=if(relative.isEmpty())directory else File(directory,relative).canonicalFile
      require(candidate==directory || candidate.path.startsWith(directory.path+File.separator))
      require(candidate.isDirectory)
      candidate
    }catch(e: Exception){null}
  }
  fun supports(raw: String): Boolean {
    if(!context.contentResolver.persistedUriPermissions.any { it.uri.toString()==raw && it.isWritePermission })return false
    val root=resolve(raw) ?: return false
    return try { probe(root.path) }catch(e: Exception){false}
  }
}
