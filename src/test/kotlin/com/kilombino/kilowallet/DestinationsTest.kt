package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.crypto.Hashes.toHex
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/** Which unused addresses of another wallet a seat's mixed outputs take. */
class DestinationsTest {
    private fun s(i: Int) = byteArrayOf(0, 20, i.toByte())

    @Test fun firstAfterTheLastUsed() {
        assertEquals(listOf(4, 5), Destinations.pickUnused(2, 3, emptySet(), ::s).map { it[2].toInt() })
        assertEquals(listOf(0), Destinations.pickUnused(1, -1, emptySet(), ::s).map { it[2].toInt() })
    }

    @Test fun skipsWhatOtherSeatsHold() {
        val held = setOf(s(1).toHex(), s(2).toHex())
        assertEquals(listOf(3, 4, 5), Destinations.pickUnused(3, 0, held, ::s).map { it[2].toInt() })
    }

    @Test fun neverPastTheGap() {
        val held = (0 until 18).map { s(it).toHex() }.toSet()
        assertEquals(2, Destinations.pickUnused(2, -1, held, ::s).size)
        assertFailsWith<IllegalArgumentException> { Destinations.pickUnused(3, -1, held, ::s) }
    }
}
