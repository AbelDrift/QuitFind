package de.nulide.findmydevice.quitfind

import com.google.gson.JsonParser

/** One device in the owner's register (docs/apparatenregister.md). */
data class QfDevice(
    val itemId: String,
    val username: String,
    val pwk64: String,
    val name: String,
    val type: String,      // phone | tablet | laptop | pc | tag
    val tagKind: String?,  // tags only: ibeacon | eddystone | mac | fmdn
    val tagId: String?,
    val addedAt: Long,
)

/** One decrypted, validated location. */
data class QfLocation(
    val lat: Double,
    val lon: Double,
    val accuracy: Double?,
    val bat: Int?,
    val provider: String?,
    val date: Long,
    val seenBy: String?,
)

object QfRegister {
    fun devices(owner: QfSession): List<QfDevice> {
        val kek = QfCrypto.deviceKek(owner.username, owner.keys.masterKey)
        return owner.api.getData(owner.token, "device").mapNotNull { item ->
            val json = QfCrypto.decrypt(kek, "device", owner.username, item)?.decodeToString() ?: return@mapNotNull null
            parseDevice(item.id.toHexString(), json)
        }
    }

    fun parseDevice(itemId: String, json: String): QfDevice? = runCatching {
        val o = JsonParser.parseString(json).asJsonObject
        if (o["kind"]?.asString != "device") return null
        val tag = o["tag"]?.takeIf { it.isJsonObject }?.asJsonObject
        QfDevice(
            itemId = itemId,
            username = o["username"].asString,
            pwk64 = o["pwk64"].asString,
            name = o["name"]?.asString ?: o["username"].asString,
            type = o["type"]?.asString ?: "phone",
            tagKind = tag?.get("kind")?.asString,
            tagId = tag?.get("id")?.asString,
            addedAt = o["addedAt"]?.asLong ?: 0L,
        )
    }.getOrNull()

    fun locations(device: QfSession): List<QfLocation> =
        device.api.getData(device.token, "location").mapNotNull { item ->
            QfCrypto.decrypt(device.keys.locationKey, "location", device.username, item)?.decodeToString()
                ?.let { parseLocation(it) }
        }.sortedBy { it.date }

    /** Device-controlled data: anything malformed is skipped instead of breaking the map. */
    fun parseLocation(json: String): QfLocation? = runCatching {
        val o = JsonParser.parseString(json).asJsonObject
        val lat = o["lat"].asDouble
        val lon = o["lon"].asDouble
        val date = o["date"].asLong
        if (!lat.isFinite() || !lon.isFinite() || kotlin.math.abs(lat) > 90 || kotlin.math.abs(lon) > 180) return null
        QfLocation(
            lat, lon,
            o["accuracy"]?.takeIf { it.isJsonPrimitive }?.asDouble,
            o["bat"]?.takeIf { it.isJsonPrimitive }?.asInt?.takeIf { it in 0..100 },
            o["provider"]?.takeIf { it.isJsonPrimitive }?.asString,
            date,
            o["seenBy"]?.takeIf { it.isJsonPrimitive }?.asString,
        )
    }.getOrNull()
}
