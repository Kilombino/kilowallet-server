package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.crypto.Bip39
import com.kilombino.pyblockwatch.crypto.Hashes
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** The web page's wallet creation with dice (setup/dice) and the fingerprint it shows (setup/fingerprint). */
class SetupWordsTest {
    @Test
    fun fiftyRollsMakeTwelveWordsBySha256() {
        val rolls = "16345216523416523452134526341256341256342153426153"
        val words = Web.diceWords(rolls, 12)
        assertEquals(12, words.size)
        assertTrue(Bip39.isValid(words))
        // SeedSigner's rule: the first 16 bytes of SHA-256 of the rolls as typed.
        assertEquals(Bip39.fromEntropy(Hashes.sha256(rolls.toByteArray()).copyOf(16)), words)
        // The same rolls always give the same words.
        assertEquals(words, Web.diceWords(rolls, 12))
    }

    @Test
    fun ninetyNineRollsMakeTwentyFourWords() {
        val rolls = "1234565432".repeat(9) + "123456123"
        val words = Web.diceWords(rolls, 24)
        assertEquals(24, words.size)
        assertEquals(Bip39.fromEntropy(Hashes.sha256(rolls.toByteArray()).copyOf(32)), words)
    }

    @Test
    fun wrongRollsAreRefused() {
        assertFailsWith<IllegalArgumentException> { Web.diceWords("123456", 12) }
        assertFailsWith<IllegalArgumentException> { Web.diceWords("7".repeat(50), 12) }
        assertFailsWith<IllegalArgumentException> { Web.diceWords("1".repeat(50), 24) }
    }

    @Test
    fun fingerprintMatchesTheKnownVector() {
        // BIP-84's test words: master fingerprint 73c5da0a, as Sparrow and SeedSigner show it.
        val words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about".split(" ")
        assertEquals("73c5da0a", Web.fingerprintOf(words, ""))
        // A passphrase opens another wallet: another fingerprint.
        assertTrue(Web.fingerprintOf(words, "TREZOR") != "73c5da0a")
    }
}
