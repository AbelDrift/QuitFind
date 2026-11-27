package de.nulide.findmydevice.quitfind

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import de.nulide.findmydevice.crypto.CryptoV2
import de.nulide.findmydevice.crypto.LongTermKeys
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * QuitFind: a small, non-singleton client for FMD server protocol v2, so the app can talk to
 * several accounts at once (owner account + one account per device). Blocking: call from IO.
 */
class QfApi(baseUrl: String, private val http: OkHttpClient = defaultHttp) {
    private val base = baseUrl.trim().trimEnd('/') + "/api/v2"

    class HttpError(val status: Int, message: String) : IOException(message)

    private fun call(method: String, path: String, body: Any? = null, token: String? = null): JsonObject {
        val json = body?.let { gson.toJson(it).toRequestBody(JSON) }
        val req = Request.Builder().url(base + path)
            .method(method, json ?: if (method == "POST") "{}".toRequestBody(JSON) else null)
        if (token != null) req.header("Authorization", "Bearer $token")
        http.newCall(req.build()).execute().use { r ->
            val text = r.body.string()
            if (!r.isSuccessful) throw HttpError(r.code, "$method $path: HTTP ${r.code} ${text.trim().take(200)}")
            return if (text.isBlank()) JsonObject() else JsonParser.parseString(text).asJsonObject
        }
    }

    fun salt(username: String): Pair<ByteArray, Int> {
        val r = call("GET", "/account/${username}/salt")
        return b64d(r["salt64"].asString) to r["protoVersion"].asInt
    }

    /** Returns (accessToken, encMasterKey). Always asks for a one-week session. */
    fun login(username: String, authKey: ByteArray): Pair<String, ByteArray> {
        val r = call(
            "POST", "/account/login",
            mapOf("username" to username, "passwordHash64" to b64(authKey), "sessionDurationSeconds" to 604800)
        )
        return r["accessToken"].asString to b64d(r["encMasterKey64"].asString)
    }

    fun register(username: String, password: String, registrationToken: String): Pair<QfSession, ByteArray> {
        val h = CryptoV2.hashPassword(username, password) // Argon2 (128 MiB)
        val keys = LongTermKeys.generate(username)
        val r = call(
            "POST", "/account/register", mapOf(
                "username" to username, "salt64" to b64(h.salt), "passwordHash64" to b64(h.authKey),
                "protoVersion" to 2, "encMasterKey64" to b64(keys.encryptMasterKey(h.preMasterKey)),
                "registrationToken" to registrationToken,
            )
        )
        return QfSession(this, username, r["accessToken"].asString, keys) to h.passwordKey
    }

    fun getData(token: String, type: String): List<QfCrypto.Item> =
        call("GET", "/data/$type", token = token)["items"]?.takeIf { it.isJsonArray }?.asJsonArray?.mapNotNull {
            val o = it.asJsonObject
            runCatching {
                QfCrypto.Item(o["clientItemIdHex"].asString.hexToByteArray(), o["unixMillis"].asLong, b64d(o["ciphertext64"].asString))
            }.getOrNull()
        } ?: emptyList()

    fun postData(token: String, type: String, items: List<QfCrypto.Item>) {
        call("POST", "/data/$type", mapOf("items" to items.map {
            mapOf("clientItemIdHex" to it.id.toHexString(), "unixMillis" to it.unixMillis, "ciphertext64" to b64(it.ciphertext))
        }), token)
    }

    fun deleteData(token: String, type: String, idHex: String) {
        call("DELETE", "/data/$type/$idHex", token = token)
    }

    fun deleteAccount(token: String) {
        call("DELETE", "/account", token = token)
    }

    companion object {
        private val JSON = "application/json".toMediaType()
        val gson = Gson()
        private val defaultHttp = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()

        fun b64(b: ByteArray): String = Base64.getEncoder().encodeToString(b)
        fun b64d(s: String): ByteArray = Base64.getDecoder().decode(s)
    }
}

/** A logged-in account (owner or device) with its decrypted long-term keys. */
class QfSession(val api: QfApi, val username: String, val token: String, val keys: LongTermKeys)

object QfAuth {
    /** One Argon2 run; returns the session and K_pwk (to store, so later logins skip Argon2). */
    fun loginWithPassword(api: QfApi, username: String, password: String): Pair<QfSession, ByteArray> { // geheimen-check: ok
        val (salt, proto) = api.salt(username)
        if (proto != 2) throw IOException("account $username uses protocol v$proto; migrate it with the FMD app first")
        val h = CryptoV2.hashPassword(username, password, salt)
        return loginWithPwk(api, username, h.passwordKey) to h.passwordKey
    }

    fun loginWithPwk(api: QfApi, username: String, pwk: ByteArray): QfSession {
        val (token, enc) = api.login(username, QfCrypto.authKey(username, pwk))
        val keys = LongTermKeys.decryptMasterKey(username, QfCrypto.preMasterKey(username, pwk), enc)
            ?: throw IOException("could not decrypt the master key of $username")
        return QfSession(api, username, token, keys)
    }
}
