package de.nulide.findmydevice.quitfind

import org.junit.Assert
import org.junit.Test

// Vectors from tests/fmd_v2_vectors.mjs section 7 (OpenSSL), so two independent EC libraries agree.
class QfFmdnTest {
    private val eik = ByteArray(32) { it.toByte() } // 00..1f

    @Test
    fun eidMatchesNode() {
        Assert.assertEquals("e6cec9ca5505f86e82781bcbe75984acb3ce5e03", QfFmdn.eid(eik, 0).toHexString())
        Assert.assertEquals("3a19ac7db9a3a9140c0faceae210ec57a127fb31", QfFmdn.eid(eik, 1024).toHexString())
        Assert.assertEquals("3a19ac7db9a3a9140c0faceae210ec57a127fb31", QfFmdn.eid(eik, 1025).toHexString())
        Assert.assertEquals("6b380abea58dde268e591878fcdc26fd52b975e1", QfFmdn.eid(eik, 123456789).toHexString())
    }

    @Test
    fun recognisesBroadcastWithClockDrift() {
        val paired = 1_700_000_000L
        val id = "${eik.toHexString()}:$paired"
        // the tag's own clock says 1024 s since pairing; the phone thinks it is 2 rotations later
        val eidNow = QfFmdn.eid(eik, 1024)
        val frame = byteArrayOf(0x40) + eidNow + byteArrayOf(0x12) // Eddystone FMDN: frame 0x40, EID(20), flags
        val seen = QfTagMatcher.identitiesOf(null, null, frame)
        Assert.assertEquals(setOf("fmdn:" + eidNow.toHexString()), seen)
        val tag = QfDevice("i", "t-fh", "", "Fresh 'n Rebel", "tag", "fmdn", id, 0)
        Assert.assertEquals(1, QfTagMatcher.match(listOf(tag), seen, paired + 1024 + 2 * 1024).size)
        Assert.assertTrue(QfTagMatcher.match(listOf(tag), seen, paired + 1024 + 4 * 1024).isEmpty()) // too far off
        // the unwanted-tracking frame 0x41 carries the same EID
        Assert.assertEquals(seen, QfTagMatcher.identitiesOf(null, null, byteArrayOf(0x41) + eidNow + byteArrayOf(0)))
    }

    @Test
    fun invalidIds() {
        Assert.assertFalse(QfFmdn.isValidId("abc:123"))
        Assert.assertTrue(QfFmdn.identitiesNow("zz", 1000).isEmpty())
        Assert.assertTrue(QfFmdn.identitiesNow("${eik.toHexString()}:2000", 1000).isEmpty()) // pairing in the future
    }
}
