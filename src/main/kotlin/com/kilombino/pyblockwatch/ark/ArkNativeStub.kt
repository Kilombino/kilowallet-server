package com.kilombino.pyblockwatch.ark

/**
 * Kilojoin has no Ark engine library: the shared crypto code (NativeSecp) asks this stub and
 * falls back to its Kotlin implementation, which gives the same bytes.
 */
internal object ArkNative {
    val available: Boolean = false
    fun secpPubkey(secret: ByteArray): ByteArray? = null
    fun secpEcdsaSign(secret: ByteArray, hash: ByteArray, lowR: Boolean): ByteArray? = null
    fun secpSchnorrSign(secret: ByteArray, msg: ByteArray, aux: ByteArray): ByteArray? = null
}
