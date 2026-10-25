package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.coinjoin.CoinjoinTx
import com.kilombino.pyblockwatch.coinjoin.NostrEvent
import com.kilombino.pyblockwatch.coinjoin.PoolSession
import com.kilombino.pyblockwatch.coinjoin.Protocol
import com.kilombino.pyblockwatch.crypto.Address
import com.kilombino.pyblockwatch.crypto.ScriptType
import com.kilombino.pyblockwatch.crypto.Secp256k1
import com.kilombino.pyblockwatch.crypto.TxBuilder
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Kilojoin v5 (payment pools) and the rest of Kilowallet 1.3.0's coinjoin, as this server uses
 * them: the app's own protocol code, and this server's port of its SEND check ([CoinjoinPay]).
 */
class CoinjoinV5Test {
    private fun key(n: Long) = BigInteger.valueOf(n)
    private fun pub(k: BigInteger) = Secp256k1.compress(Secp256k1.multiply(k, Secp256k1.G))
    private fun coin(n: Long, value: Long, type: ScriptType = ScriptType.P2WPKH) = CoinjoinTx.Coin("%064x".format(n), 0, value, pub(key(n)), type)
    private fun script(n: Long, type: ScriptType = ScriptType.P2WPKH) = Address.scriptPubKey(pub(key(n)), type)
    private fun addr(n: Long, type: ScriptType) = Address.encode(pub(key(n)), type)

    private fun announce(np: PoolSession.Companion.NewPool, edit: (JSONObject) -> Unit = {}): Protocol.Terms? {
        val o = np.terms.toJson().also(edit)
        return Protocol.Terms.parse(NostrEvent.sign(BigInteger(np.secret, 16), Protocol.KIND_POOL,
            listOf(listOf("d", np.terms.id), listOf("t", Protocol.TAG)), o.toString()))
    }

    private val pays = listOf(30_000L, 45_000L, 125_000L)    // S = 200 000

    @Test fun paymentPoolTermsRoundTrip() {
        val np = PoolSession.newPool(100_000, 2.0, 5, 1, v3 = true, outputs = 2, payments = pays)
        assertEquals(Protocol.V5, np.terms.version)
        val back = announce(np)!!
        assertEquals(pays, back.payments); assertEquals(2, back.outputs); assertEquals(200_000, back.mixTotal)
        assertTrue(back.v5)
        // Sums that don't match, dust, none: not listed.
        assertNull(announce(np) { it.put("payments", JSONArray(listOf(30_000L, 45_000L, 125_001L))) })
        assertNull(announce(np) { it.put("payments", JSONArray(listOf(200L, 199_800L))) })
        assertNull(announce(np) { it.remove("payments") })
        assertFailsWith<IllegalArgumentException> { PoolSession.newPool(100_000, 2.0, 5, 1, v3 = true, outputs = 2, payments = listOf(100_000L)) }
        // Equal outputs stay v3 (one each) or v4 (several), for older wallets.
        assertEquals(Protocol.V3, PoolSession.newPool(100_000, 2.0, 5, 1, v3 = true).terms.version)
        assertEquals(Protocol.V4, PoolSession.newPool(5_000, 2.0, 5, 1, v3 = true, outputs = 2).terms.version)
    }

    @Test fun theMinimumIsPerPersonInAll() {
        fun t(amount: Long, outputs: Int) = PoolSession.newPool(amount, 1.0, 5, 1, outputs = outputs, v3 = true).terms
        assertFalse(Protocol.isTest(t(5_000, 2)))       // 2 × 5 000: a real pool
        assertTrue(Protocol.isTest(t(3_000, 3)))        // 9 000 each: a test
        assertTrue(Protocol.isTest(t(9_000, 1)))
        assertFalse(Protocol.isTest(t(10_000, 1)))
    }

    @Test fun v5SplitForTheOthers() {
        assertEquals(200_000L to 1, Protocol.v5Split(200_000))
        assertEquals(100_000L to 2, Protocol.v5Split(200_000, 2))
        assertEquals(200_001L to 1, Protocol.v5Split(200_001, 2))
        assertEquals(1_500L to 1, Protocol.v5Split(1_500, 2))
    }

    @Test fun fromCoinsLeavesNoChange() {
        for (type in listOf(ScriptType.P2WPKH, ScriptType.P2TR)) for (rate in listOf(1.0, 2.5, 33.3)) for (n in 1..Protocol.MAX_INPUTS)
            for (outputs in 1..Protocol.MAX_OUTPUTS) for (total in listOf(123_457L, 5_432_109L)) {
                val amount = CoinjoinTx.noChangeAmount(total, n, rate, type, outputs)!!
                assertEquals(0L, CoinjoinTx.change(total, amount, rate, n, type, outputs))
                assertNull(CoinjoinTx.change(total, amount + 1, rate, n, type, outputs))
            }
    }

    @Test fun payCheckAsInTheApp() {
        val q1 = addr(21, ScriptType.P2WPKH); val q2 = addr(22, ScriptType.P2WPKH); val q3 = addr(23, ScriptType.P2WPKH)
        val p1 = addr(31, ScriptType.P2TR); val p2 = addr(32, ScriptType.P2TR)
        CoinjoinPay.check(listOf(q1 to 50_000L, q2 to 50_000L, q3 to 50_000L), taprootOk = false).let {
            assertTrue(it.ok); assertTrue(it.paymentOk); assertEquals(ScriptType.P2WPKH, it.type); assertEquals(50_000L, it.amount)
        }
        assertEquals(ScriptType.P2TR, CoinjoinPay.check(listOf(p1 to 20_000L, p2 to 21_000L), taprootOk = true).type)
        // Different amounts: a payment pool only.
        CoinjoinPay.check(listOf(q1 to 50_000L, q2 to 50_001L, q3 to 400L), true).let { assertFalse(it.ok); assertTrue(it.paymentOk) }
        // 2 × 5 000 is a pool (10 000 each in all); 4 000 + 5 000 is not, and says how short.
        assertTrue(CoinjoinPay.check(listOf(q1 to 5_000L, q2 to 5_000L), true).ok)
        CoinjoinPay.check(listOf(q1 to 4_000L, q2 to 5_000L), true).let { assertFalse(it.any); assertTrue(it.reason!!.contains("9000")) }
        assertFalse(CoinjoinPay.check(listOf(q1 to 50_000L, q2 to 300L), true).any)
        assertEquals(CoinjoinPay.NEEDS, CoinjoinPay.check(listOf(q1 to 50_000L, p1 to 50_000L), true).reason)
        assertFalse(CoinjoinPay.check(listOf(p1 to 20_000L), taprootOk = false).ok)
        assertFalse(CoinjoinPay.check(listOf(q1 to 20_000L, q1 to 20_000L), true).any)
        assertFalse(CoinjoinPay.check(listOf("someone@example.com" to 50_000L), true).any)
        assertFalse(CoinjoinPay.check((40L..45L).map { addr(it, ScriptType.P2WPKH) to 30_000L }, true).any)
        assertFalse(CoinjoinPay.check(listOf("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2" to 50_000L), true).any)
    }

    /** A round: creator A pays [pays]; joiners B (perfect coin) and C (two coins, change) get [k] outputs each. */
    private inner class Round(val k: Int, val type: ScriptType = ScriptType.P2WPKH) {
        val rate = 3.0
        val d = pays.sum() / k
        val a = coin(1, 400_000, type)
        val b = coin(2, CoinjoinTx.minimumCoin(d, rate, type, k), type)
        val c1 = coin(3, 150_000, type); val c2 = coin(4, 120_000, type)
        val payOuts = pays.mapIndexed { i, v -> TxBuilder.Output(script(60L + i, type), v) }
        val chA = TxBuilder.Output(script(19, type), CoinjoinTx.changeOf(a.value, pays.sum(), rate, 1, type, pays.size)!!)
        val chC = TxBuilder.Output(script(39, type), CoinjoinTx.change(c1.value + c2.value, d, rate, 2, type, k)!!)
        val mixB = (20L until 20L + k).map { script(it, type) }
        val mixC = (30L until 30L + k).map { script(it, type) }
        fun plan(payments: List<TxBuilder.Output> = payOuts, changes: List<TxBuilder.Output> = listOf(chA, chC)) =
            CoinjoinTx.plan(listOf(a, b, c1, c2), mixB + mixC, changes, d, k, payments)
        fun check(plan: CoinjoinTx.Plan, mine: List<TxBuilder.Output>, change: TxBuilder.Output?) =
            CoinjoinTx.checkPayment(plan, mine, change, d, rate, listOf(1, 1, 2), listOf(pays.size, k, k), k, pays, 2)
    }

    @Test fun everyMemberChecksThePayments() {
        for (k in listOf(1, 2)) for (type in listOf(ScriptType.P2WPKH, ScriptType.P2TR)) {
            val r = Round(k, type)
            val plan = r.plan()
            assertNull(r.check(plan, r.payOuts, r.chA))
            assertNull(r.check(plan, r.mixB.map { TxBuilder.Output(it, r.d) }, null))
            assertNull(r.check(plan, r.mixC.map { TxBuilder.Output(it, r.d) }, r.chC))
        }
        val r = Round(2)
        // A creator that swaps two payments' amounts (same sum) is refused by the joiners.
        val swapped = listOf(TxBuilder.Output(r.payOuts[0].scriptPubKey, 25_000), TxBuilder.Output(r.payOuts[1].scriptPubKey, 50_000), r.payOuts[2])
        assertNotNull(r.check(r.plan(swapped), r.mixB.map { TxBuilder.Output(it, r.d) }, null))
        // One that keeps more change than its share leaves.
        val greedy = r.plan(changes = listOf(TxBuilder.Output(r.chA.scriptPubKey, r.chA.value + 600), r.chC))
        assertEquals("the fee is too low", r.check(greedy, r.mixB.map { TxBuilder.Output(it, r.d) }, null))
    }

    @Test fun creatorSeatPaysAFeeShareForItsPayments() {
        val rate = 2.0
        val np = PoolSession.newPool(100_000, rate, 5, 1, v3 = true, outputs = 2, payments = pays)
        assertFailsWith<IllegalArgumentException> {
            PoolSession.newState(np.terms, true, np.secret, listOf(coin(1, 500_000)), listOf(key(1)), listOf("a"),
                listOf(script(41), script(42)), script(31), creatorSecret = np.creatorSecret, blindPriv = np.blindPriv)
        }
        val st = PoolSession.newState(np.terms, true, np.secret, listOf(coin(1, 500_000)), listOf(key(1)), listOf("a"),
            listOf(script(41), script(42), script(43)), script(31), creatorSecret = np.creatorSecret, blindPriv = np.blindPriv)
        assertEquals(500_000 - 200_000 - CoinjoinTx.feeShare(rate, true, 1, ScriptType.P2WPKH, 3), st.seat.changeValue)
        assertEquals(pays, PoolSession.State.parse(JSONObject(st.toJson().toString())).terms.payments)
    }

    @Test fun paymentRoundsAreNotOurMixedCoins() {
        val dir = Files.createTempDirectory("kwv5").toFile()
        val cj = Coinjoin(dir, Rpc("http://localhost:1/", null, null, null)) { emptyList() }
        cj.rememberDest("p1", Coinjoin.PAY)
        cj.rememberDest("p2", "dest-1", "Sparrow (zpub…)")
        assertTrue(cj.isPay("p1")); assertFalse(cj.isPay("p2")); assertFalse(cj.isPay("p3"))
        assertEquals("Sparrow (zpub…)", cj.destWhichOf("p2"))
        dir.deleteRecursively()
    }
}
