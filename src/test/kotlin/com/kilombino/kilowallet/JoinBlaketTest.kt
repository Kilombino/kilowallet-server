package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.joinblaket.JbNetwork
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** PAY THROUGH JOINBLAKET's server side that needs no directory: the checks before the password, addresses, Tor off. */
class JoinBlaketTest {
    private val dir: File = Files.createTempDirectory("kw-jb").toFile().apply { deleteOnExit() }
    private val rpc = Rpc("http://127.0.0.1:1/", "x", "y", null)
    private fun coin(value: Long, conf: Int, i: Int = 0) = NodeWallet.Utxo("%064x".format(i + 1), 0, value, conf, 0, i)

    @Test fun beforeThePassword() {
        val jb = JoinBlaket(dir, rpc, "127.0.0.1:9050")
        // A coin with 5 confirmations and 20 % of the amount: it can go on.
        assertNull(jb.precheck(listOf(coin(200_000, 5)), emptyList(), 1_000_000))
        // Big enough but 2 confirmations: wait 3 blocks (~30 min), as the app says it.
        assertEquals("None of these coins has 5 confirmations yet: makers only accept one that has. The first will in about 3 blocks (~30 min).",
            jb.precheck(listOf(coin(500_000, 2)), emptyList(), 1_000_000))
        // Old enough but all below 20 %: say how much one needs (grouped as the app shows sats).
        assertEquals("None of these coins can open this CoinJoin: one needs at least 200 000 sats (20% of the amount).",
            jb.precheck(listOf(coin(100_000, 9), coin(150_000, 9, 1)), emptyList(), 1_000_000))
        // Nothing confirmed, a big coin on its way: wait for it.
        assertEquals("Your coin is still unconfirmed: it needs 5 confirmations before it can open a CoinJoin (~50 min).",
            jb.precheck(emptyList(), listOf(coin(900_000, 0)), 1_000_000))
        assertEquals(JoinBlaket.NO_COINS, jb.precheck(emptyList(), emptyList(), 1_000_000))
    }

    @Test fun onlyPlainBc1q() {
        val jb = JoinBlaket(dir, rpc, "127.0.0.1:9050")
        assertNotNull(jb.p2wpkhScript("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"))
        assertNull(jb.p2wpkhScript("bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297")) // Taproot
        assertNull(jb.p2wpkhScript("bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3")) // P2WSH
        assertNull(jb.p2wpkhScript("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"))
        val spk = jb.p2wpkhScript("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")!!
        assertNull(jb.p2wpkhScript(JbNetwork.REGTEST.p2wpkhAddress(spk)), "bcrt1 only in a regtest test")
        assertEquals(JbNetwork.MAINNET, jb.network)
    }

    @Test fun regtestLabTakesBcrt() {
        val jb = JoinBlaket(dir, rpc, "127.0.0.1:9050", Triple("127.0.0.1", 15322, "127.0.0.1:15322"))
        assertEquals(JbNetwork.REGTEST, jb.network)
        val spk = jb.p2wpkhScript("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")!!
        val bcrt = jb.network.p2wpkhAddress(spk)
        assertTrue(bcrt.startsWith("bcrt1q"))
        assertEquals(spk.toList(), jb.p2wpkhScript(bcrt)!!.toList())
    }

    @Test fun withoutTorNothingStarts() {
        val jb = JoinBlaket(dir, rpc, null)
        assertFalse(jb.torUp())
        assertFalse(jb.running)
        assertTrue(jb.lockedOutpoints().isEmpty())
        assertNull(jb.viewJson())
    }
}
