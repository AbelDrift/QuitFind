package de.nulide.findmydevice.quitfind

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.CancellationSignal
import android.os.ParcelUuid
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import de.nulide.findmydevice.data.Settings
import de.nulide.findmydevice.data.SettingsRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

/**
 * QuitFind: every 15 minutes scan briefly for the owner's own tags and report "tag X seen here"
 * to each tag's account (an encrypted location with provider "ble", seenBy and rssi).
 */
class QfTagScanWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val ctx = applicationContext
        val owner = QfOwnerStore(ctx).get() ?: return@withContext Result.success()
        if (!hasPermissions(ctx)) return@withContext Result.success()
        val api = QfApi(owner.server)
        val tags = runCatching {
            val o = QfAuth.loginWithPwk(api, owner.username, QfApi.b64d(owner.pwk64))
            QfRegister.devices(o).filter { it.type == "tag" && QfTagMatcher.canMatch(it) }
        }.getOrElse { return@withContext Result.retry() }
        val refused = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val candidates = tags.filter { !refused.getBoolean(key(it), false) }
        if (candidates.isEmpty()) return@withContext Result.success()

        val seen = scan(ctx, candidates, SCAN_MS)
        val hits = QfTagMatcher.match(candidates, seen.keys)
        if (hits.isEmpty()) return@withContext Result.success()
        val loc = currentLocation(ctx) ?: return@withContext Result.success()
        val seenBy = (SettingsRepository.getInstance(ctx).get(Settings.SET_FMDSERVER_ID) as? String)?.takeIf { it.isNotBlank() }
        val now = System.currentTimeMillis()
        for (tag in hits) {
            val rssi = QfTagMatcher.matchedIdentity(tag, seen.keys)?.let { seen[it] }
            try {
                val s = QfAuth.loginWithPwk(api, tag.username, QfApi.b64d(tag.pwk64))
                val json = QfApi.gson.toJson(buildMap {
                    put("provider", "ble"); put("lat", loc.latitude); put("lon", loc.longitude)
                    if (loc.hasAccuracy()) put("accuracy", loc.accuracy.toDouble())
                    put("bat", -1); put("date", now); put("time", java.util.Date(now).toString())
                    seenBy?.let { put("seenBy", it) }; rssi?.let { put("rssi", it) }
                })
                api.postData(s.token, "location", listOf(QfCrypto.encrypt(s.keys.locationKey, "location", s.username, json.toByteArray(), unixMillis = now)))
            } catch (e: QfApi.HttpError) {
                // never keep retrying a refused key: 7 misses lock the tag account for 10 minutes
                if (e.status == 403 || e.status == 404) refused.edit().putBoolean(key(tag), true).apply()
            } catch (_: Exception) {
                // network trouble: try again on the next run
            }
        }
        Result.success()
    }

    @SuppressLint("MissingPermission")
    private suspend fun scan(ctx: Context, tags: List<QfDevice>, ms: Long): Map<String, Int> {
        val adapter = ctx.getSystemService(BluetoothManager::class.java)?.adapter ?: return emptyMap()
        if (!adapter.isEnabled) return emptyMap()
        val scanner = adapter.bluetoothLeScanner ?: return emptyMap()
        val found = ConcurrentHashMap<String, Int>()
        val cb = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, r: ScanResult) = record(r)
            override fun onBatchScanResults(results: MutableList<ScanResult>) = results.forEach(::record)
            private fun record(r: ScanResult) {
                val rec = r.scanRecord
                QfTagMatcher.identitiesOf(
                    r.device?.address,
                    rec?.getManufacturerSpecificData(QfTagMatcher.APPLE_ID),
                    rec?.getServiceData(ParcelUuid.fromString(QfTagMatcher.EDDYSTONE_UUID)),
                ).forEach { id -> found.merge(id, r.rssi) { a, b -> maxOf(a, b) } }
            }
        }
        // Filters are required: Android stops unfiltered scans while the screen is off
        scanner.startScan(filters(tags), ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), cb)
        try {
            delay(ms)
        } finally {
            runCatching { scanner.stopScan(cb) }
        }
        return found
    }

    private fun filters(tags: List<QfDevice>): List<ScanFilter> = tags.mapNotNull { t ->
        if (t.tagKind == "fmdn") return@mapNotNull ScanFilter.Builder() // Find Hub frames 0x40/0x41
            .setServiceData(ParcelUuid.fromString(QfTagMatcher.EDDYSTONE_UUID), byteArrayOf(0x40), byteArrayOf(0xFE.toByte())).build()
        val id = QfTagMatcher.identityOf(t.tagKind, t.tagId) ?: return@mapNotNull null
        when {
            id.startsWith("mac:") -> ScanFilter.Builder().setDeviceAddress(id.removePrefix("mac:")).build()
            id.startsWith("ibeacon:") -> ScanFilter.Builder().setManufacturerData(
                QfTagMatcher.APPLE_ID, byteArrayOf(0x02, 0x15), byteArrayOf(-1, -1)
            ).build()
            else -> ScanFilter.Builder().setServiceData(ParcelUuid.fromString(QfTagMatcher.EDDYSTONE_UUID), byteArrayOf(0), byteArrayOf(-1)).build()
        }
    }.distinct()

    @SuppressLint("MissingPermission")
    private suspend fun currentLocation(ctx: Context): Location? {
        val lm = ctx.getSystemService(LocationManager::class.java) ?: return null
        val providers = listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER).filter { lm.isProviderEnabled(it) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            for (p in providers) {
                val l = withTimeoutOrNull(20_000) {
                    suspendCancellableCoroutine<Location?> { cont ->
                        val signal = CancellationSignal()
                        cont.invokeOnCancellation { signal.cancel() }
                        lm.getCurrentLocation(p, signal, ctx.mainExecutor) { cont.resume(it) }
                    }
                }
                if (l != null) return l
            }
        }
        // fallback: the newest known location if it is recent enough
        return providers.mapNotNull { lm.getLastKnownLocation(it) }.maxByOrNull { it.time }
            ?.takeIf { System.currentTimeMillis() - it.time < 10 * 60_000 }
    }

    companion object {
        private const val WORK = "quitfind-tag-scan"
        private const val PREFS = "quitfind_tags"
        private const val SCAN_MS = 10_000L

        private fun key(t: QfDevice) = "refused:${t.itemId}"

        fun permissions(): Array<String> = buildList {
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(Manifest.permission.BLUETOOTH_SCAN)
        }.toTypedArray()

        fun hasPermissions(ctx: Context) = permissions().all {
            ContextCompat.checkSelfPermission(ctx, it) == PackageManager.PERMISSION_GRANTED
        }

        fun isEnabled(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false)

        fun setEnabled(ctx: Context, on: Boolean) {
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", on).apply()
            val wm = WorkManager.getInstance(ctx)
            if (on) wm.enqueueUniquePeriodicWork(
                WORK, ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<QfTagScanWorker>(15, TimeUnit.MINUTES).build()
            ) else wm.cancelUniqueWork(WORK)
        }
    }
}
