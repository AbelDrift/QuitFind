package de.nulide.findmydevice.quitfind

/**
 * QuitFind: recognise the owner's own Bluetooth tags in BLE advertisements.
 * Supported (fixed identity, no Google needed): MAC address (simple key finders), iBeacon and
 * Eddystone-UID. Google Find Hub tags (kind "fmdn") rotate their identity and need the tag's EIK;
 * they are not matched here (see NOTES.md, phase 3b).
 */
object QfTagMatcher {
    const val APPLE_ID = 0x004C
    const val EDDYSTONE_UUID = "0000feaa-0000-1000-8000-00805f9b34fb"

    /** Normalised identity of a tag from the register, or null if this kind cannot be matched. */
    fun identityOf(kind: String?, id: String?): String? {
        val v = id?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return when (kind) {
            "mac" -> v.uppercase().replace('-', ':').takeIf { MAC.matches(it) }?.let { "mac:$it" }
            "ibeacon" -> v.lowercase().takeIf { IBEACON.matches(it) }?.let { "ibeacon:$it" }
            "eddystone" -> v.lowercase().replace(":", "").replace("-", "").takeIf { EDDY.matches(it) }?.let { "eddystone:$it" }
            else -> null
        }
    }

    /** All identities one advertisement can match. */
    fun identitiesOf(address: String?, appleData: ByteArray?, eddystoneData: ByteArray?): Set<String> {
        val ids = HashSet<String>()
        address?.uppercase()?.takeIf { MAC.matches(it) }?.let { ids += "mac:$it" }
        // iBeacon: 0x02 0x15, UUID(16), major(2), minor(2), tx power(1)
        if (appleData != null && appleData.size >= 22 && appleData[0] == 0x02.toByte() && appleData[1] == 0x15.toByte()) {
            val u = appleData.copyOfRange(2, 18).toHexString()
            val uuid = "${u.substring(0, 8)}-${u.substring(8, 12)}-${u.substring(12, 16)}-${u.substring(16, 20)}-${u.substring(20)}"
            ids += "ibeacon:$uuid:${u16(appleData, 18)}:${u16(appleData, 20)}"
        }
        // Eddystone-UID: frame 0x00, tx power(1), namespace(10), instance(6)
        if (eddystoneData != null && eddystoneData.size >= 18 && eddystoneData[0] == 0x00.toByte()) {
            ids += "eddystone:" + eddystoneData.copyOfRange(2, 18).toHexString()
        }
        return ids
    }

    fun match(tags: List<QfDevice>, seen: Set<String>): List<QfDevice> =
        tags.filter { t -> identityOf(t.tagKind, t.tagId)?.let { it in seen } == true }

    private fun u16(b: ByteArray, i: Int) = ((b[i].toInt() and 0xff) shl 8) or (b[i + 1].toInt() and 0xff)

    private val MAC = Regex("^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")
    private val IBEACON = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\\d{1,5}:\\d{1,5}$")
    private val EDDY = Regex("^[0-9a-f]{32}$")
}
