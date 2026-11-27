package de.nulide.findmydevice.quitfind

import org.junit.Assert
import org.junit.Test

class QfTagMatcherTest {
    private fun tag(kind: String, id: String) = QfDevice("i", "t-$kind", "", "Tag $kind", "tag", kind, id, 0)

    @Test
    fun ibeaconAdvertisement() {
        val uuid = "f7826da6-4fa2-4e98-8024-bc5b71e0893e"
        val data = byteArrayOf(0x02, 0x15) + uuid.replace("-", "").hexToByteArray() + byteArrayOf(0x00, 0x01, 0x30, 0x39, 0xC5.toByte())
        val ids = QfTagMatcher.identitiesOf(null, data, null)
        Assert.assertEquals(setOf("ibeacon:$uuid:1:12345"), ids)
        Assert.assertEquals(listOf("Tag ibeacon"), QfTagMatcher.match(listOf(tag("ibeacon", "F7826DA6-4FA2-4E98-8024-BC5B71E0893E:1:12345")), ids).map { it.name })
    }

    @Test
    fun eddystoneUidAdvertisement() {
        val ns = "edd1ebeac04e5defa017"; val inst = "0123456789ab"
        val data = byteArrayOf(0x00, 0xEE.toByte()) + (ns + inst).hexToByteArray() + byteArrayOf(0, 0)
        val ids = QfTagMatcher.identitiesOf(null, null, data)
        Assert.assertEquals(setOf("eddystone:$ns$inst"), ids)
        Assert.assertEquals(1, QfTagMatcher.match(listOf(tag("eddystone", "$ns:$inst")), ids).size)
        // other Eddystone frames (URL 0x10, TLM 0x20) are not UIDs; Find Hub (0x40) gives an fmdn identity
        Assert.assertTrue(QfTagMatcher.identitiesOf(null, null, byteArrayOf(0x10) + ByteArray(20)).isEmpty())
        Assert.assertTrue(QfTagMatcher.identitiesOf(null, null, byteArrayOf(0x40) + ByteArray(20)).none { it.startsWith("eddystone:") })
    }

    @Test
    fun macAndInvalidIds() {
        val ids = QfTagMatcher.identitiesOf("aa:bb:cc:dd:ee:ff", null, null)
        Assert.assertEquals(setOf("mac:AA:BB:CC:DD:EE:FF"), ids)
        Assert.assertEquals(1, QfTagMatcher.match(listOf(tag("mac", "AA-BB-CC-DD-EE-FF")), ids).size)
        Assert.assertNull(QfTagMatcher.identityOf("mac", "not a mac"))
        Assert.assertNull(QfTagMatcher.identityOf("fmdn", "whatever")) // needs the EIK: not supported here
        Assert.assertNull(QfTagMatcher.identityOf("ibeacon", "f7826da6:1:2"))
        // a short or foreign Apple payload is ignored
        Assert.assertTrue(QfTagMatcher.identitiesOf(null, byteArrayOf(0x10, 0x05, 1, 2), null).isEmpty())
    }
}
