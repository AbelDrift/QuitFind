package de.nulide.findmydevice.quitfind

import org.junit.Assert
import org.junit.Test
import java.util.Base64

// Vectors from tests/fmd_v2_vectors.mjs (section 6), so web, Node and Android agree on the format.
class QfCryptoTest {
    private val user = "alice"
    private val masterKey = ByteArray(32) { it.toByte() } // 00..1f

    @Test
    fun deviceKekMatchesNode() {
        Assert.assertEquals(
            "4624e3f1ed7d5d7641673eee34b0048abce26ae5886ee1f3a93102dc56440e6a",
            QfCrypto.deviceKek(user, masterKey).toHexString()
        )
    }

    @Test
    fun decryptsNodeDeviceItem() {
        val item = QfCrypto.Item(
            "303132333435363738393a3b3c3d3e3f".hexToByteArray(),
            1700000000000L,
            Base64.getDecoder().decode(
                "0NHS09TV1tfY2drbJZ0ce3RCG0i0EICWCdYTm+EKZSq1kMXRsm4f2W7/J5HmeggSeYBPvPZDwcdrxdlC4OHi4+Tl5ufo6err1Pq/S+A+mPL+qpiD6IU1DO5AifyjF5bd423NXg7+hwnaeobRBLlt+OwggGrhnqflbxJl896ipHaoQrJxDjkDuwVML20R8+mx9Yilb0xDTQ9dLixLda6R3ZWP+5/NEUCf0JxwHplJHjaAACwnqgkM+LNfzFsJVjXaOaAvNd7nbJmu4fjz4UA9OG6gffNKKmWuxehRnyJTyEcbRMMGDPWl6UujJ/fWMfVxpSQYV7v8bXHTxvoIR0rKjcv+"
            )
        )
        val kek = QfCrypto.deviceKek(user, masterKey)
        val json = QfCrypto.decrypt(kek, "device", user, item)?.decodeToString()
        Assert.assertNotNull(json)
        Assert.assertTrue(json!!.contains("\"name\":\"Fairphone\""))
        // bound to type, account and time
        Assert.assertNull(QfCrypto.decrypt(kek, "location", user, item))
        Assert.assertNull(QfCrypto.decrypt(kek, "device", "bob", item))
        Assert.assertNull(QfCrypto.decrypt(kek, "device", user, QfCrypto.Item(item.id, item.unixMillis + 1, item.ciphertext)))
    }

    @Test
    fun roundTripAndShortCiphertext() {
        val kek = ByteArray(32) { 7 }
        val item = QfCrypto.encrypt(kek, "location", user, "{\"lat\":52.0}".toByteArray())
        Assert.assertEquals("{\"lat\":52.0}", QfCrypto.decrypt(kek, "location", user, item)?.decodeToString())
        Assert.assertNull(QfCrypto.decrypt(kek, "location", user, QfCrypto.Item(item.id, item.unixMillis, ByteArray(10))))
    }

    @Test
    fun pwkKeysMatchNode() {
        // tests/fmd_v2_vectors.mjs V2: alice/password, salt 0x29*16
        val pwk = "274d05957daaba42e5af45ad27c3a69d9de4ee51b792d1b0d28fd270a62986cd".hexToByteArray()
        Assert.assertEquals(
            "67af4c1c0c96ef97d565a6f8080729d5620f5716d076b8f57c80855d4be112c4",
            QfCrypto.authKey(user, pwk).toHexString()
        )
        Assert.assertEquals(
            "5239438bea1f3db6df2b75238f5ed7fcc356b10e0e67187d45dd3e1c5ce78da8",
            QfCrypto.preMasterKey(user, pwk).toHexString()
        )
    }
}
