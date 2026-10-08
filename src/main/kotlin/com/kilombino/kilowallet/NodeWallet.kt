package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.crypto.Address
import com.kilombino.pyblockwatch.crypto.Base58
import com.kilombino.pyblockwatch.crypto.Bip32
import com.kilombino.pyblockwatch.crypto.Hashes
import com.kilombino.pyblockwatch.crypto.Hashes.toHex
import com.kilombino.pyblockwatch.crypto.ScriptType
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * The wallet as the node sees it: a watch-only descriptor wallet in the node (no private keys,
 * only the account key), which tracks history, the mempool and balances for us, pruned node
 * included. The keys never enter the node; signing happens in [Spend].
 *
 * Addresses are derived here from the account key (the same code as the app) and handed out
 * from a persisted counter, never reused.
 */
class NodeWallet(private val dir: File, private val rpc: Rpc, accountKey: String, val type: ScriptType) {
    private val account = Bip32.parseExtendedPubKey(accountKey)
    /** The key as the node's descriptors want it: "xpub" version bytes on mainnet. */
    private val descKey = toVersion(accountKey, 0x0488B21E)
    /** One node wallet per account key, so switching wallets never mixes their history. */
    val name = "kilowallet-" + Hashes.sha256(descKey.toByteArray()).toHex().take(10)
    private val stateFile = File(dir, "addresses.json")

    data class Tx(val txid: String, val net: Long, val confirmations: Int, val time: Long, val fee: Long?)
    data class Utxo(val txid: String, val vout: Int, val value: Long, val confirmations: Int, val branch: Int, val index: Int) {
        val outpoint get() = "$txid:$vout"
    }

    // ------------------------------------------------------------------ addresses

    private fun state(): JSONObject = if (stateFile.exists()) JSONObject(stateFile.readText()) else JSONObject()
    private fun saveState(o: JSONObject) { stateFile.writeText(o.toString()) }
    private fun top(branch: Int): Int = state().optJSONObject(name)?.optInt("top$branch", 0) ?: 0
    @Synchronized private fun bump(branch: Int, to: Int) {
        val o = state(); val w = o.optJSONObject(name) ?: JSONObject().also { o.put(name, it) }
        if (to > w.optInt("top$branch", 0)) { w.put("top$branch", to); saveState(o) }
    }

    fun pubkey(branch: Int, index: Int): ByteArray = Bip32.derivePath(account, branch, index).pubkey()
    fun address(branch: Int, index: Int): String = Address.encode(pubkey(branch, index), type)
    fun script(branch: Int, index: Int): ByteArray = Address.scriptPubKey(pubkey(branch, index), type)

    /** The next unused receive address (the same one until something arrives on it, or [next]). */
    fun receive(): Pair<Int, String> { val i = top(0); return i to address(0, i) }
    fun next(): Pair<Int, String> { bump(0, top(0) + 1); return receive() }
    /** A fresh change script, reserved so the next send does not reuse it. */
    @Synchronized fun freshChange(): Pair<Int, ByteArray> { val i = top(1); bump(1, i + 1); return i to script(1, i) }
    fun peekChange(): Pair<Int, ByteArray> { val i = top(1); return i to script(1, i) }

    /** branch/index of each script we hand out or watch, for matching node results back. */
    private fun scripts(): Map<String, Pair<Int, Int>> {
        val m = HashMap<String, Pair<Int, Int>>()
        for (b in 0..1) for (i in 0 until top(b) + GAP) m[script(b, i).toHex()] = b to i
        return m
    }

    // ------------------------------------------------------------------ the node's wallet

    private fun desc(branch: Int): String = when (type) {
        ScriptType.P2WPKH -> "wpkh($descKey/$branch/*)"
        ScriptType.P2SH_P2WPKH -> "sh(wpkh($descKey/$branch/*))"
        ScriptType.P2PKH -> "pkh($descKey/$branch/*)"
        ScriptType.P2TR -> "tr($descKey/$branch/*)"
    }

    private fun withChecksum(d: String): String = (rpc.call("getdescriptorinfo", d) as JSONObject).getString("descriptor")

    /**
     * Make sure the node has this wallet loaded, creating and importing it the first time.
     * [rescanFrom]: a unix time to look back from (a restored wallet), or null for "now".
     */
    /**
     * Where a restored wallet's history starts, found without a full rescan: the oldest coin it
     * still holds (scantxoutset), less a margin, but never before what a pruned node keeps.
     * Null when it holds nothing (then there is nothing to look back for).
     */
    fun autoSince(): Long? {
        val desc = JSONArray()
        for (b in 0..1) desc.put(JSONObject().put("desc", desc(b)).put("range", RANGE))
        val r = rpc.call("scantxoutset", "start", desc, timeoutMs = 1_800_000) as JSONObject
        val u = r.getJSONArray("unspents")
        val minH = (0 until u.length()).map { u.getJSONObject(it).getInt("height") }.filter { it > 0 }.minOrNull() ?: return null
        val info = rpc.call("getblockchaininfo") as JSONObject
        val from = maxOf(minH - 6, if (info.optBoolean("pruned")) info.optInt("pruneheight") else 0)
        val hash = rpc.call("getblockhash", from) as String
        return (rpc.call("getblockheader", hash) as JSONObject).getLong("time") - 7200
    }

    fun ensure(rescanFrom: Long? = null) {
        val loaded = (rpc.call("listwallets") as JSONArray).toList().map { it.toString() }
        if (name in loaded) return
        val exists = runCatching { rpc.call("loadwallet", name) }.isSuccess
        if (exists) return
        rpc.call("createwallet", name, true, true, "", false, true, true) // no keys, blank, descriptors, load on startup
        val req = JSONArray()
        for (b in 0..1) req.put(JSONObject().put("desc", withChecksum(desc(b))).put("range", JSONArray().put(0).put(RANGE))
            .put("timestamp", rescanFrom ?: "now").put("internal", b == 1).put("active", false))
        rpc.call("importdescriptors", req, timeoutMs = 3_600_000, wallet = name)
    }

    /** Look back again for older history (a restored wallet on an unpruned node). Slow. */
    fun rescan(fromHeight: Int) { rpc.call("rescanblockchain", fromHeight, timeoutMs = 6 * 3_600_000, wallet = name) }

    fun balance(): Pair<Long, Long> {
        val m = (rpc.call("getbalances", wallet = name) as JSONObject).let { it.optJSONObject("mine") ?: it.getJSONObject("watchonly") }
        return sats(m.getDouble("trusted")) to sats(m.getDouble("untrusted_pending"))
    }

    fun utxos(): List<Utxo> {
        val by = scripts()
        val r = rpc.call("listunspent", 0, 9_999_999, JSONArray(), true, wallet = name) as JSONArray
        return (0 until r.length()).mapNotNull { k ->
            val o = r.getJSONObject(k)
            val (b, i) = by[o.getString("scriptPubKey")] ?: return@mapNotNull null
            bump(b, i + 1)
            Utxo(o.getString("txid"), o.getInt("vout"), sats(o.getDouble("amount")), o.getInt("confirmations"), b, i)
        }.sortedByDescending { it.value }
    }

    /** Movements, newest first: what each transaction did to the wallet (a send includes its fee). */
    fun transactions(count: Int = 500): List<Tx> {
        val r = rpc.call("listtransactions", "*", count, 0, true, wallet = name) as JSONArray
        val byTx = LinkedHashMap<String, MutableList<JSONObject>>()
        for (k in 0 until r.length()) r.getJSONObject(k).let { byTx.getOrPut(it.getString("txid")) { mutableListOf() } += it }
        // Anything that touched an address marks it used, so receive() moves on.
        val by = scripts().entries.associate { (s, bi) -> address(bi.first, bi.second) to bi }
        return byTx.map { (txid, es) ->
            es.forEach { e -> by[e.optString("address")]?.let { (b, i) -> bump(b, i + 1) } }
            val fee = es.firstOrNull { it.has("fee") }?.let { sats(-it.getDouble("fee")) }
            val net = es.sumOf { sats(it.getDouble("amount")) } - (fee ?: 0)
            val first = es.first()
            Tx(txid, net, first.optInt("confirmations"), first.optLong("time"), fee)
        }.filter { it.confirmations >= 0 }.sortedWith(compareBy({ it.confirmations > 0 }, { -it.time }))
    }

    fun rawTx(txid: String): String = rpc.call("getrawtransaction", txid) as String
    fun broadcast(hex: String): String = rpc.call("sendrawtransaction", hex) as String

    companion object {
        const val GAP = 20
        const val RANGE = 999

        fun sats(btc: Double): Long = Math.round(btc * 1e8)

        fun toVersion(key: String, v: Int): String {
            val raw = Base58.decodeChecked(key)
            raw[0] = (v ushr 24).toByte(); raw[1] = (v ushr 16).toByte(); raw[2] = (v ushr 8).toByte(); raw[3] = v.toByte()
            return Base58.encodeChecked(raw)
        }

        private fun JSONArray.toList(): List<Any> = (0 until length()).map { get(it) }
    }
}
