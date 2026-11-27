package de.nulide.findmydevice.quitfind

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** The linked owner account, in Android's encrypted storage (excluded from backups). */
class QfOwnerStore(context: Context) {
    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        FILENAME,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    data class Owner(val server: String, val username: String, val pwk64: String)

    fun get(): Owner? {
        val server = prefs.getString("server", null) ?: return null
        val user = prefs.getString("username", null) ?: return null
        val pwk = prefs.getString("pwk64", null) ?: return null
        return Owner(server, user, pwk)
    }

    fun set(o: Owner?) = prefs.edit {
        if (o == null) clear() else putString("server", o.server).putString("username", o.username).putString("pwk64", o.pwk64)
    }

    companion object {
        const val FILENAME = "quitfind_owner"
    }
}

data class QfDeviceView(val device: QfDevice, val locations: List<QfLocation>, val error: String?)

sealed interface QfUi {
    data object NotLinked : QfUi
    data class Busy(val linking: Boolean) : QfUi
    data class Ready(val devices: List<QfDeviceView>, val error: String?, val refreshing: Boolean) : QfUi
    data class LinkFailed(val message: String) : QfUi
}

class QfMapViewModel(app: Application) : AndroidViewModel(app) {
    private val store = QfOwnerStore(app)
    private val _ui = MutableStateFlow<QfUi>(if (store.get() == null) QfUi.NotLinked else QfUi.Busy(false))
    val ui: StateFlow<QfUi> = _ui

    // Sessions live in memory only; logins strictly one after another (server lockout after 7 misses)
    private val mutex = Mutex()
    private var owner: QfSession? = null
    private val sessions = HashMap<String, QfSession>()
    private val refused = HashSet<String>() // device logins the server refused: no retry until relinked

    init {
        if (store.get() != null) refresh()
    }

    fun link(server: String, username: String, password: String) {
        _ui.value = QfUi.Busy(true)
        viewModelScope.launch {
            try {
                val (session, pwk) = withContext(Dispatchers.IO) {
                    QfAuth.loginWithPassword(QfApi(server), username.trim(), password)
                }
                store.set(QfOwnerStore.Owner(server.trim(), session.username, QfApi.b64(pwk)))
                mutex.withLock { owner = session; sessions.clear(); refused.clear() }
                refresh()
            } catch (e: Exception) {
                _ui.value = QfUi.LinkFailed(e.message ?: e.toString())
            }
        }
    }

    fun unlink() {
        store.set(null)
        owner = null
        sessions.clear()
        refused.clear()
        _ui.value = QfUi.NotLinked
    }

    fun refresh() {
        val o = store.get() ?: return run { _ui.value = QfUi.NotLinked }
        (_ui.value as? QfUi.Ready)?.let { _ui.value = it.copy(refreshing = true) }
        viewModelScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { load(o) } }
            val previous = (_ui.value as? QfUi.Ready)?.devices.orEmpty()
            _ui.value = result.fold(
                onSuccess = { QfUi.Ready(it, null, false) },
                onFailure = { QfUi.Ready(previous, it.message ?: it.toString(), false) },
            )
        }
    }

    private suspend fun load(o: QfOwnerStore.Owner): List<QfDeviceView> = mutex.withLock {
        val api = QfApi(o.server)
        val ownerSession = withRelogin(owner) { QfAuth.loginWithPwk(api, o.username, QfApi.b64d(o.pwk64)) }
            .also { owner = it }
        val devices = try {
            QfRegister.devices(ownerSession)
        } catch (e: QfApi.HttpError) {
            if (e.status != 401) throw e
            owner = QfAuth.loginWithPwk(api, o.username, QfApi.b64d(o.pwk64))
            QfRegister.devices(owner!!)
        }
        devices.map { d ->
            if (d.username in refused) return@map QfDeviceView(d, emptyList(), REFUSED)
            try {
                var s = sessions[d.username] ?: QfAuth.loginWithPwk(api, d.username, QfApi.b64d(d.pwk64))
                sessions[d.username] = s
                val locs = try {
                    QfRegister.locations(s)
                } catch (e: QfApi.HttpError) {
                    if (e.status != 401) throw e // token gone (server restart or expired): log in once more
                    s = QfAuth.loginWithPwk(api, d.username, QfApi.b64d(d.pwk64)); sessions[d.username] = s
                    QfRegister.locations(s)
                }
                QfDeviceView(d, locs, null)
            } catch (e: QfApi.HttpError) {
                if (e.status == 403 || e.status == 404 || e.status == 423) {
                    refused += d.username
                    QfDeviceView(d, emptyList(), REFUSED)
                } else QfDeviceView(d, emptyList(), e.message)
            } catch (e: Exception) {
                QfDeviceView(d, emptyList(), e.message ?: e.toString())
            }
        }
    }

    private inline fun withRelogin(cached: QfSession?, login: () -> QfSession): QfSession = cached ?: login()

    companion object {
        const val REFUSED = "refused"
    }
}
