package de.nulide.findmydevice.quitfind

import org.junit.Assert
import org.junit.Assume
import org.junit.Test

/**
 * Integration test against the QuitFind TEST server (never the real FMD server).
 * Runs only with QF_TEST_SERVER (default http://127.0.0.1:8096) and QF_TEST_REGTOKEN set.
 */
class QfServerIT {
    @Test
    fun registerDevicesAndLocationsRoundTrip() {
        val token = System.getenv("QF_TEST_REGTOKEN")
        Assume.assumeTrue("QF_TEST_REGTOKEN not set", !token.isNullOrBlank())
        val server = System.getenv("QF_TEST_SERVER") ?: "http://127.0.0.1:8096"
        Assert.assertFalse("refusing to run against the real server", Regex(":8090|:8443|debian\\.").containsMatchIn(server))
        val api = QfApi(server)
        val rnd = { java.util.UUID.randomUUID().toString().replace("-", "").take(16) }
        val created = mutableListOf<QfSession>()
        try {
            val (owner, _) = api.register("qf-owner-${rnd()}", "eigenaar-${rnd()}", token!!).also { created += it.first }
            val (phone, phonePwk) = api.register("qf-phone-${rnd()}", "telefoon-${rnd()}", token).also { created += it.first }

            // the phone uploads a location; the owner registers the phone
            val loc = """{"provider":"gps","lat":52.37,"lon":4.89,"accuracy":8,"bat":81,"date":1700000000000}"""
            api.postData(phone.token, "location", listOf(QfCrypto.encrypt(phone.keys.locationKey, "location", phone.username, loc.toByteArray(), unixMillis = 1700000000000L)))
            // a malformed location must be skipped, not break anything
            api.postData(phone.token, "location", listOf(QfCrypto.encrypt(phone.keys.locationKey, "location", phone.username, """{"lat":"x"}""".toByteArray())))
            val entry = """{"v":1,"kind":"device","username":"${phone.username}","server":"","pwk64":"${QfApi.b64(phonePwk)}","name":"Fairphone","type":"phone","addedAt":1}"""
            val kek = QfCrypto.deviceKek(owner.username, owner.keys.masterKey)
            api.postData(owner.token, "device", listOf(QfCrypto.encrypt(kek, "device", owner.username, entry.toByteArray())))

            // a fresh view: register → device login with the stored pwk (no Argon2) → locations
            val devices = QfRegister.devices(owner)
            Assert.assertEquals(listOf("Fairphone"), devices.map { it.name })
            val s = QfAuth.loginWithPwk(api, devices[0].username, QfApi.b64d(devices[0].pwk64))
            val locs = QfRegister.locations(s)
            Assert.assertEquals(1, locs.size)
            Assert.assertEquals(52.37, locs[0].lat, 1e-9)
            Assert.assertEquals(81, locs[0].bat)
        } finally {
            created.reversed().forEach { runCatching { api.deleteAccount(it.token) } }
        }
    }
}
