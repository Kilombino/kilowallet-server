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
    // The node's descriptors want an xpub on mainnet and a tpub on regtest/testnet (tests only).
    private val descKey = toVersion(accountKey, if (testnet) 0x043587CF else 0x0488B21E)
    /** The name before 0.8.0: one node wallet per account key only. */
    private val legacyName = "kilowallet-" + Hashes.sha256(descKey.toByteArray()).toHex().take(10)
    private val namesFile = File(dir, "node-wallets.json")
    /**
     * One node wallet per account key AND address type (as the app since 1.2.4): the descriptors
     * are imported only when the node wallet is made, so the same key read as bc1q and then as
     * Taproot would keep the bc1q descriptors and every bc1p address would look unused. Native
     * SegWit keeps its old name; another type keeps the old name too when the node wallet of
     * that name already holds this type's descriptors (made by an earlier version), see [ensure].
     */
    @Volatile var name: String = if (type == ScriptType.P2WPKH) legacyName else (chosenName() ?: typedName())
        private set
    private fun typedName() = "kilowallet-" + Hashes.sha256((descKey + ":" + type.name).toByteArray()).toHex().take(10)
    private fun chosenName(): String? = runCatching { JSONObject(namesFile.readText()).optString(typedName()).ifEmpty { null } }.getOrNull()
    @Synchronized private fun choose(n: String) {
        val o = runCatching { JSONObject(namesFile.readText()) }.getOrDefault(JSONObject())
        o.put(typedName(), n); namesFile.writeText(o.toString()); name = n
    }
    private val stateFile = File(dir, "addresses.json")

    data class Tx(val txid: String, val net: Long, val confirmations: Int, val time: Long, val fee: Long?)
    data class Utxo(val txid: String, val vout: Int, val value: Long, val confirmations: Int, val branch: Int, val index: Int,
                    /** The account it belongs to: the wallet's own type, or Taproot for a hot wallet's second account. */
                    val type: ScriptType = ScriptType.P2WPKH) {
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

    /** The receive and change branch keys, derived once; each address is then one step from them, and kept. */
    private val branches = arrayOf(Bip32.deriveChild(account, 0), Bip32.deriveChild(account, 1))
    private val pubkeys = java.util.concurrent.ConcurrentHashMap<Long, ByteArray>()
    fun pubkey(branch: Int, index: Int): ByteArray =
        pubkeys.getOrPut((branch.toLong() shl 32) or index.toLong()) { Bip32.deriveChild(branches[branch], index).pubkey() }
    fun address(branch: Int, index: Int): String =
        if (type == ScriptType.P2TR) Spend.addressOf(script(branch, index)) else Address.encode(pubkey(branch, index), type)
    private val scriptsMemo = java.util.concurrent.ConcurrentHashMap<Long, ByteArray>()
    /** Kept too: a Taproot script costs another point multiplication (the tweak). */
    fun script(branch: Int, index: Int): ByteArray =
        scriptsMemo.getOrPut((branch.toLong() shl 32) or index.toLong()) { Address.scriptPubKey(pubkey(branch, index), type) }

    /** The next unused receive address (the same one until something arrives on it, or [next]). */
    fun receive(): Pair<Int, String> { val i = top(0); return i to address(0, i) }
    fun next(): Pair<Int, String> { bump(0, top(0) + 1); return receive() }
    /** A fresh change script, reserved so the next send does not reuse it. */
    @Synchronized fun freshChange(): Pair<Int, ByteArray> { val i = top(1); bump(1, i + 1); return i to script(1, i) }
    fun peekChange(): Pair<Int, ByteArray> { val i = top(1); return i to script(1, i) }
    /**
     * A fresh receive script nobody has been shown (a coinjoin's mixed output, an exact coin):
     * the address on screen may already be with someone, so it is skipped, and the page moves
     * on to the next one.
     */
    @Synchronized fun reserveReceive(): Pair<Int, ByteArray> { val i = top(0) + 1; bump(0, i + 1); return i to script(0, i) }

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

    /**
     * Not native SegWit, first time here: an earlier version may have made this wallet under the
     * key-only name. Kept if that node wallet watches this very type; otherwise the typed name.
     */
    val nameResolved: Boolean get() = type == ScriptType.P2WPKH || chosenName() != null

    fun resolveName() {
        if (nameResolved) return
        val loaded = (rpc.call("listwallets") as JSONArray).toList().map { it.toString() }
        val wasLoaded = legacyName in loaded
        val there = wasLoaded || runCatching { rpc.call("loadwallet", legacyName) }.isSuccess
        val mine = there && runCatching {
            val d = (rpc.call("listdescriptors", wallet = legacyName) as JSONObject).getJSONArray("descriptors")
            val want = desc(0).substringBefore('(') + "("
            (0 until d.length()).any { d.getJSONObject(it).getString("desc").startsWith(want) }
        }.getOrDefault(false)
        if (there && !mine && !wasLoaded) runCatching { rpc.call("unloadwallet", legacyName) }
        choose(if (mine) legacyName else typedName())
    }

    fun ensure(rescanFrom: Long? = null) {
        resolveName()
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
            Utxo(o.getString("txid"), o.getInt("vout"), sats(o.getDouble("amount")), o.getInt("confirmations"), b, i, type)
        }.sortedByDescending { it.value }
    }

    private val txCache = java.util.concurrent.ConcurrentHashMap<String, Tx>()
    private val sentFile = File(dir, "sent.json")

    /** Transactions this server broadcast: a payment to ourselves only (a CPFP, a consolidation)
     *  never shows in listtransactions, which leaves change out. */
    @Synchronized fun noteSent(txid: String) {
        val a = if (sentFile.exists()) JSONArray(sentFile.readText()) else JSONArray()
        a.put(txid); sentFile.writeText(a.toString())
    }
    private fun sent(): List<String> = if (sentFile.exists()) JSONArray(sentFile.readText()).let { a -> (0 until a.length()).map { a.getString(it) } } else emptyList()

    /** Movements, newest first: what each transaction did to the wallet (a send includes its fee). */
    fun transactions(count: Int = 500): List<Tx> {
        val r = rpc.call("listtransactions", "*", count, 0, true, wallet = name) as JSONArray
        val by = scripts().entries.associate { (_, bi) -> address(bi.first, bi.second) to bi }
        val ids = LinkedHashSet<String>()
        for (k in 0 until r.length()) r.getJSONObject(k).let { e ->
            ids += e.getString("txid")
            by[e.optString("address")]?.let { (b, i) -> bump(b, i + 1) } // anything that touched an address marks it used
        }
        ids += sent()
        (rpc.call("listunspent", 0, 9_999_999, JSONArray(), true, wallet = name) as JSONArray).let { u -> for (k in 0 until u.length()) ids += u.getJSONObject(k).getString("txid") }
        return ids.mapNotNull { txid ->
            txCache[txid]?.let { return@mapNotNull it }
            val t = runCatching { rpc.call("gettransaction", txid, true, wallet = name) as JSONObject }.getOrNull() ?: return@mapNotNull null
            // amount leaves change out; with the fee it is exactly what the wallet gained or lost.
            val fee = if (t.has("fee")) sats(-t.getDouble("fee")) else null
            val tx = Tx(txid, sats(t.getDouble("amount")) - (fee ?: 0), t.optInt("confirmations"), t.optLong("time"), fee)
            if (tx.confirmations >= 6) txCache[txid] = tx
            tx
        }.filter { t ->
            // A pending one that is no longer in the mempool was replaced (RBF) or dropped: not a movement.
            t.confirmations > 0 || (t.confirmations == 0 && runCatching { rpc.call("getmempoolentry", t.txid) }.isSuccess)
        }.sortedWith(compareBy({ it.confirmations > 0 }, { if (it.confirmations > 0) it.confirmations.toLong() else -it.time }))
    }

    /** Receive index by scriptPubKey (hex): addresses come back with the node's network prefix. */
    private val receiveIndex: Map<String, Int> by lazy { (0..RANGE).associateBy { script(0, it).toHex() } }

    /**
     * Receive indexes that ever got anything (spent since or not), as the node's wallet saw them
     * from its rescan start: what must never be handed out again.
     */
    fun usedReceive(): Set<Int> {
        // listreceivedbyaddress only knows the address book; an imported descriptor's addresses
        // are not in it. Every payment that ever reached one shows in listtransactions.
        val r = rpc.call("listtransactions", "*", 1_000_000, 0, true, timeoutMs = 600_000, wallet = name) as JSONArray
        return (0 until r.length()).mapNotNull { k ->
            val e = r.getJSONObject(k)
            if (e.optString("category") !in setOf("receive", "generate", "immature")) return@mapNotNull null
            val a = e.optString("address")
            val sw = com.kilombino.pyblockwatch.crypto.Bech32.decodeSegwit(a.substring(0, a.lastIndexOf('1').coerceAtLeast(0)), a) ?: return@mapNotNull null
            val op = if (sw.witnessVersion == 0) 0x00 else 0x50 + sw.witnessVersion
            receiveIndex[(byteArrayOf(op.toByte(), sw.program.size.toByte()) + sw.program).toHex()]
        }.toSet()
    }

    fun rawTx(txid: String): String = rpc.call("getrawtransaction", txid) as String
    fun broadcast(hex: String): String = rpc.call("sendrawtransaction", hex) as String

    companion object {
        /** Set for a regtest/testnet node (KILOWALLET_NETWORK not "blake2b"): tests only. */
        @Volatile var testnet = false
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
