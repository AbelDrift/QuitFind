package de.nulide.findmydevice.quitfind

import de.nulide.findmydevice.crypto.CryptoV2
import de.nulide.findmydevice.crypto.toBigEndianByteArray
import de.nulide.findmydevice.crypto.toHash
import de.nulide.findmydevice.utils.CypherUtils

/**
 * QuitFind: crypto for the device register (docs/apparatenregister.md) and for logging in to a
 * device account with a stored password key (K_pwk), so no Argon2 run is needed per device.
 * Uses the FMD v2 primitives unchanged; only the data-type labels are open (FMD's DataBlobType
 * is closed to command/location/picture).
 */
object QfCrypto {
    private val CTX_KEK_DEVICE = "quitfind_v1_kek_device".toByteArray()
    private val CTX_PREMASTER = "fmd_v2_premaster".toByteArray()
    private const val DEK_PART =
        CypherUtils.AES_GCM_IV_SIZE_BYTES + CypherUtils.AES_GCM_KEY_SIZE_BYTES + CypherUtils.AES_GCM_TAG_SIZE_BYTES
    private const val MIN_SIZE = DEK_PART + CypherUtils.AES_GCM_IV_SIZE_BYTES + CypherUtils.AES_GCM_TAG_SIZE_BYTES

    class Item(val id: ByteArray, val unixMillis: Long, val ciphertext: ByteArray)

    fun deviceKek(ownerUsername: String, masterKey: ByteArray): ByteArray =
        CryptoV2.hkdfDerive(masterKey, CTX_KEK_DEVICE + ownerUsername.toHash())

    fun authKey(username: String, pwk: ByteArray): ByteArray = CryptoV2.deriveAuthKey(username, pwk)

    fun preMasterKey(username: String, pwk: ByteArray): ByteArray =
        CryptoV2.hkdfDerive(pwk, CTX_PREMASTER + username.toHash())

    private fun adSuffix(type: String, username: String, id: ByteArray, ms: Long): ByteArray =
        type.toByteArray() + username.toHash() + id + ms.toBigEndianByteArray()

    fun encrypt(
        kek: ByteArray,
        type: String,
        username: String,
        plaintext: ByteArray,
        id: ByteArray = CypherUtils.generateSecureRandom(16),
        unixMillis: Long = System.currentTimeMillis(),
    ): Item {
        val s = adSuffix(type, username, id, unixMillis)
        val dek = CypherUtils.generateSecureRandom(32)
        val encDek = CypherUtils.encryptWithAes(dek, CryptoV2.CTX_DEK + s, kek)
        val encData = CypherUtils.encryptWithAes(plaintext, CryptoV2.CTX_DATA + s, dek)
        return Item(id, unixMillis, encDek + encData)
    }

    /** Returns null when the item does not belong to this key/type/account or was tampered with. */
    fun decrypt(kek: ByteArray, type: String, username: String, item: Item): ByteArray? {
        if (item.ciphertext.size < MIN_SIZE) return null
        val s = adSuffix(type, username, item.id, item.unixMillis)
        val dek = CypherUtils.decryptWithAes(item.ciphertext.copyOfRange(0, DEK_PART), CryptoV2.CTX_DEK + s, kek)
            ?: return null
        return CypherUtils.decryptWithAes(
            item.ciphertext.copyOfRange(DEK_PART, item.ciphertext.size), CryptoV2.CTX_DATA + s, dek
        )
    }
}
