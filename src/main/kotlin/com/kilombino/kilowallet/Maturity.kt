package com.kilombino.kilowallet

import org.json.JSONArray
import org.json.JSONObject

/**
 * Mined rewards (coinbase outputs) still maturing: the node's wallet already keeps them out of the
 * balance and of every spend (getbalances "immature", listtransactions/listsinceblock category
 * "immature"); this only says how much there is and from which block each can be spent: the
 * app's maturity rule (Scanner.maturityFor), counted as the node's wallet counts it.
 */
object Maturity {
    /**
     * Coinbase maturity on the BLAKE2b chain, as Knots 29.4.3 relays a spend of it (knots#468):
     * rewards mined in blocks 973 440–979 918 keep their 6 480 confirmations; from 979 919, while
     * the median time past of the block before is under 2027-09-01 00:00 UTC, each waits 25 920
     * (about 180 days, counted from its own block); any other, 100. Which block is past that date
     * is only known from the chain's times: until then every reward from [LONG_START] counts as
     * covered, as the app counts it.
     */
    const val HISTORICAL_START = 973_440
    const val HISTORICAL_MATURITY = 6480
    const val LONG_START = 979_919
    const val LONG_MATURITY = 25920
    /** Ten minutes a block, when the chain's own pace can't be read. */
    const val DEFAULT_BLOCK_SECONDS = 600.0

    fun maturityFor(height: Int): Int = when {
        height >= LONG_START -> LONG_MATURITY
        height >= HISTORICAL_START -> HISTORICAL_MATURITY
        else -> 100
    }

    /**
     * The tip at which the node's wallet frees a reward mined at [height] (one block later than
     * the app's Scanner.maturesAt, the first tip whose mempool would take a spend of it): the
     * coin leaves "maturing" and enters the balance there.
     */
    fun maturesAt(height: Int): Int = height + maturityFor(height)

    /** A maturing mined reward of the wallet, as the node lists it. */
    data class Coin(val txid: String, val vout: Int, val value: Long, val height: Int) {
        val maturesAt get() = maturesAt(height)
    }

    /** Roughly when block [height] comes (epoch seconds), at [secondsPerBlock] from [tip]. */
    fun eta(height: Int, tip: Int, secondsPerBlock: Double, now: Long): Long =
        now + ((height - tip).coerceAtLeast(0) * secondsPerBlock).toLong()

    /**
     * What the page shows under the balance: the node's immature total and each coin with the
     * block it unlocks at and an estimated time (an estimate: blocks don't come on a timetable).
     */
    fun json(total: Long, coins: List<Coin>, tip: Int, secondsPerBlock: Double, now: Long = System.currentTimeMillis() / 1000): JSONObject =
        JSONObject().put("total", total).put("tip", tip).put("secondsPerBlock", secondsPerBlock).put("estimate", true)
            .put("coins", JSONArray(coins.sortedWith(compareBy({ it.maturesAt }, { it.txid }, { it.vout })).map { c ->
                JSONObject().put("txid", c.txid).put("vout", c.vout).put("value", c.value).put("height", c.height)
                    .put("confirmations", if (tip >= c.height) tip - c.height + 1 else 0)
                    .put("unlockHeight", c.maturesAt).put("unlockTime", eta(c.maturesAt, tip, secondsPerBlock, now))
            }))

    // ------------------------------------------------------------------ the chain's pace

    @Volatile private var paceCache: Pair<String, Double>? = null

    /**
     * Seconds a block over the last day's blocks (144), as the app reads it for its dates; ten
     * minutes when that can't be read or makes no sense (a regtest that mines in bursts). Looked up
     * once per tip.
     */
    fun pace(rpc: Rpc, tipHash: String, tip: Int): Double {
        paceCache?.let { (h, s) -> if (h == tipHash) return s }
        val s = runCatching {
            val span = minOf(144, tip - 1)
            if (span < 1) return@runCatching null
            val t1 = (rpc.call("getblockheader", tipHash) as JSONObject).getLong("time")
            val t0 = (rpc.call("getblockheader", rpc.call("getblockhash", tip - span) as String) as JSONObject).getLong("time")
            ((t1 - t0).toDouble() / span).takeIf { it in 30.0..86_400.0 }
        }.getOrNull() ?: DEFAULT_BLOCK_SECONDS
        paceCache = tipHash to s
        return s
    }
}
