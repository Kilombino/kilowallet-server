package com.kilombino.pyblockwatch.data

/** The one piece of the app's JamWatch the JoinBlaket taker's Electrum lookup names (unused here: the node by RPC). */
object JamWatch {
    /** A block header's time (bytes 68–71, little-endian), 80- or 164-byte headers alike. */
    fun blockTime(headerHex: String): Long {
        val b = com.kilombino.pyblockwatch.crypto.Hashes.hexToBytes(headerHex)
        return (0 until 4).fold(0L) { a, i -> a or ((b[68 + i].toLong() and 0xff) shl (8 * i)) }
    }
}
