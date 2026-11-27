package de.nulide.findmydevice.quitfind

import org.bouncycastle.asn1.sec.SECNamedCurves
import java.math.BigInteger
import java.nio.ByteBuffer
import javax.crypto.Cipher
import javax.crypto.spec.SecretKeySpec

/**
 * QuitFind: recognise the owner's own Google Find Hub tags (e.g. Fresh 'n Rebel) locally, without Google,
 * once the tag's ephemeral identity key (EIK) is known (it comes from the Google account, see bridge A).
 * Algorithm as in GoogleFindMyTools FMDNCrypto/eid_generator.py (GPL-3.0), checked against an independent
 * OpenSSL implementation (tests/fmd_v2_vectors.mjs section 7):
 *   r' = AES-ECB-256(EIK, FF*11 || K || ts || 00*11 || K || ts), ts = counter with the lowest K=10 bits cleared
 *   r = r' mod n (secp160r1), EID = x(r·G), 20 bytes; it rotates every 1024 s.
 * Tag id in the register: "<EIK as 64 hex>:<pairing time in unix seconds>" (counter = now - pairing time).
 */
object QfFmdn {
    private const val K = 10
    private val CURVE = SECNamedCurves.getByName("secp160r1")
    private val ID = Regex("^([0-9a-fA-F]{64}):(\\d{1,11})$")

    fun eid(eik: ByteArray, counter: Long): ByteArray {
        val ts = ByteBuffer.allocate(4).putInt((counter and ((1L shl K) - 1).inv()).toInt()).array()
        val block = ByteArray(11) { 0xFF.toByte() } + byteArrayOf(K.toByte()) + ts + ByteArray(11) + byteArrayOf(K.toByte()) + ts
        val aes = Cipher.getInstance("AES/ECB/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(eik, "AES")) }
        val r = BigInteger(1, aes.doFinal(block)).mod(CURVE.n)
        return CURVE.g.multiply(r).normalize().affineXCoord.encoded
    }

    fun isValidId(id: String?): Boolean = id != null && ID.matches(id.trim())

    /** The identities ("fmdn:<eid hex>") this tag can broadcast now, ± [window] rotations for clock drift. */
    fun identitiesNow(id: String?, nowSec: Long, window: Int = 2): Set<String> {
        val m = id?.trim()?.let { ID.matchEntire(it) } ?: return emptySet()
        val eik = m.groupValues[1].hexToByteArray()
        val counter = nowSec - m.groupValues[2].toLong()
        if (counter < 0) return emptySet()
        return (-window..window).map { counter + it * (1L shl K) }.filter { it >= 0 }
            .map { "fmdn:" + eid(eik, it).toHexString() }.toSet()
    }
}
