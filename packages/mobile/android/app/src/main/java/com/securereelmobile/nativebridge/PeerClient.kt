// SPDX-License-Identifier: GPL-3.0-only
package com.securereelmobile.nativebridge

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.*

internal class PeerClient(private val context: Context) {
  private val preferences = context.getSharedPreferences("peer", Context.MODE_PRIVATE)
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey("securereel-peer", null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder("securereel-peer", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }
  private fun credentials(): JSONObject? {
    val encrypted = preferences.getString("encrypted", null) ?: return null
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(preferences.getString("iv", ""), Base64.NO_WRAP)))
    return JSONObject(String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), Charsets.UTF_8))
  }
  private fun store(value: JSONObject) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
    check(preferences.edit().putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
      .putString("encrypted", Base64.encodeToString(cipher.doFinal(value.toString().toByteArray()), Base64.NO_WRAP)).commit())
  }
  @Synchronized fun forget() { check(preferences.edit().clear().commit()) }
  @Synchronized fun info(): JSONObject = credentials()?.let {
    JSONObject().put("version", 1).put("url", it.getString("url")).put("fingerprint", it.getString("fingerprint")).put("clientId", it.getString("clientId")).put("desktopName", it.optString("desktopName", "已配对电脑"))
  } ?: JSONObject.NULL.let { JSONObject() }
  @Synchronized fun pair(raw: String, deviceName: String): JSONObject {
    val setup = JSONObject(raw)
    val fields=setup.keys().asSequence().toSet();require(fields.containsAll(setOf("version","url","fingerprint","pairingCode","expiresAt")) && fields.all {it in setOf("version","url","fingerprint","pairingCode","expiresAt","desktopName")});require(!setup.has("desktopName") || (setup.get("desktopName") is String && setup.getString("desktopName").length in 1..120))
    require(setup.get("version") is Number && setup.getDouble("version") == 1.0)
    require(setup.get("expiresAt") is Number)
    val endpoint = SafetyPolicy.endpoint(setup.getString("url"))
    val fingerprint = setup.getString("fingerprint").also { require(it.matches(Regex("[0-9a-f]{64}"))) }
    val expiry = setup.getLong("expiresAt"); require(expiry > System.currentTimeMillis()) { "Pairing expired" }
    require(deviceName.length in 1..80 && deviceName.trim().isNotEmpty())
    val code = setup.getString("pairingCode").also { require(it.length in 1..128) }
    val response = JSONObject(String(exchange(endpoint, fingerprint, null, "POST", "/api/v1/pair", JSONObject().put("pairingCode", code).put("deviceName", deviceName).toString()), Charsets.UTF_8))
    if(response.optInt("version")!=1)throw PeerFailure("PEER_VERSION","电脑端版本不兼容，请更新电脑端");require(response.getBoolean("ok"))
    val data = response.getJSONObject("data")
    require(data.getString("token").matches(Regex("[A-Za-z0-9_-]{16,512}")))
    require(data.getString("clientId").matches(Regex("[A-Za-z0-9_-]{1,128}")))
    store(JSONObject().put("url", endpoint).put("fingerprint", fingerprint).put("clientId", data.getString("clientId")).put("token", data.getString("token")).put("desktopName",data.optString("desktopName",setup.optString("desktopName","已配对电脑"))))
    return info()
  }
  @Synchronized fun request(method: String, path: String, body: String): ByteArray {
    val peer = credentials() ?: error("No paired desktop")
    return exchange(peer.getString("url"), peer.getString("fingerprint"), peer.getString("token"), method, path, body)
  }
  private fun readBoundedError(input: java.io.InputStream): ByteArray {
    val bytes=ByteArray(4096);var length=0
    while(length<bytes.size){val n=input.read(bytes,length,bytes.size-length);if(n<=0)break;length+=n}
    return bytes.copyOf(length)
  }
  private fun exchange(endpoint: String, fingerprint: String, token: String?, method: String, path: String, body: String): ByteArray {
    SafetyPolicy.route(path)
    val allowed = when(method) {
      "GET" -> path in listOf("/api/v1/snapshot", "/api/v1/roots", "/api/v1/jobs", "/api/v1/projects") || path.matches(Regex("/api/v1/reports/[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+/(html|json|pdf))?")) || path.matches(Regex("/api/v1/jobs/[A-Za-z0-9_-]+(/project)?"))
      "POST" -> path in listOf("/api/v1/pair", "/api/v1/jobs", "/api/v1/projects", "/api/v1/preflight") || path.matches(Regex("/api/v1/jobs/[A-Za-z0-9_-]+/(start|pause|resume|cancel|project)"))
      else -> false
    }
    require(allowed) { "Unsupported desktop operation" }; require(body.toByteArray().size <= 1024 * 1024)
    // Pairing fingerprint is the trust anchor. The TLS handshake checks it before HTTP headers or body are sent.
    val trust = object : X509TrustManager {
      override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
      override fun checkClientTrusted(chain: Array<X509Certificate>, auth: String) { throw java.security.cert.CertificateException("Unsupported") }
      override fun checkServerTrusted(chain: Array<X509Certificate>, auth: String) {
        if(chain.isEmpty()) throw java.security.cert.CertificateException("Missing certificate")
        val digest = MessageDigest.getInstance("SHA-256").digest(chain[0].encoded).joinToString("") { "%02x".format(it.toInt() and 255) }
        if(!MessageDigest.isEqual(digest.toByteArray(), fingerprint.toByteArray())) throw java.security.cert.CertificateException("Certificate changed")
        chain[0].checkValidity()
      }
    }
    val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), SecureRandom()) }
    val connection = URL(SafetyPolicy.endpoint(endpoint) + path).openConnection() as HttpsURLConnection
    connection.sslSocketFactory = ssl.socketFactory
    // Exact leaf pin replaces hostname PKI trust for the explicitly approved literal LAN IP.
    connection.hostnameVerifier = HostnameVerifier { host, session -> host == URL(endpoint).host && session.peerCertificates.isNotEmpty() &&
      MessageDigest.getInstance("SHA-256").digest(session.peerCertificates[0].encoded).joinToString("") { "%02x".format(it.toInt() and 255) } == fingerprint }
    connection.requestMethod = method; connection.instanceFollowRedirects = false
    connection.connectTimeout = 10000; connection.readTimeout = 30000
    token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
    try {
      if(method == "POST") {
        connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      }
      val status=connection.responseCode
      if(status !in 200..299){
        val errorCode=try { connection.errorStream?.use { JSONObject(String(readBoundedError(it),Charsets.UTF_8)).optJSONObject("error")?.optString("code") } }catch(_: Exception){null}
        // A reserved mutation may have reached the engine before its response was lost.
        val permissionChanged=errorCode in listOf("root_forbidden","job_forbidden")
        val uncertain=errorCode in listOf("request_uncertain","operation_failed") || (errorCode==null&&status !in listOf(401,403,404,413))
        val code=when { uncertain->"PEER_UNCERTAIN";permissionChanged->"PEER_VALIDATION";status in listOf(401,403)->"PEER_AUTH";status==404->"PEER_VERSION";status in 400..499->"PEER_VALIDATION";else->"PEER_UNCERTAIN" }
        throw PeerFailure(code,when(code){"PEER_AUTH"->"配对已过期或被撤销，请重新扫码";"PEER_VERSION"->"电脑端版本不兼容，请更新电脑端";"PEER_VALIDATION"->if(permissionChanged)"电脑目录或任务授权已变更，请刷新并重新选择授权位置" else "电脑拒绝了本次填写，请修正目录或资料后重试";else->"电脑操作结果尚未确认，请查看电脑端任务或恢复原内容重试"})
      }
      return connection.inputStream.use { input ->
        val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(65536)
        while(true) { val n=input.read(buffer); if(n<0)break; require(output.size()+n <= 16*1024*1024) { "Response too large" }; output.write(buffer,0,n) }
        output.toByteArray()
      }
    } catch(e: PeerFailure){throw e}
      catch(e: SSLException){throw PeerFailure("PEER_CERTIFICATE","电脑证书已改变或无法验证，请重新扫码")}
      catch(e: java.net.ConnectException){throw PeerFailure("PEER_REFUSED","电脑协作服务未开启，请在电脑设置中开启")}
      catch(e: java.net.SocketTimeoutException){throw PeerFailure("PEER_NETWORK","连接超时，请确认手机与电脑在同一局域网")}
      catch(e: java.io.IOException){throw PeerFailure("PEER_NETWORK","网络不可达，请检查手机与电脑网络")}
      finally { connection.disconnect() }
  }
}

internal class PeerFailure(val code: String,message: String): Exception(message)
