package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.crypto.Bip32
import com.kilombino.pyblockwatch.crypto.Hashes
import com.kilombino.pyblockwatch.crypto.Hashes.toHex
import com.kilombino.pyblockwatch.crypto.ScriptType
import com.kilombino.pyblockwatch.data.JoinMarket
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Other wallets a coinjoin's mixed outputs can go to, as in the Android app's choice: a watch-only
 * wallet (its account key) or a Jam wallet's first jar, Apricot (from Jam's export line). Each one
 * gets a watch-only wallet in the node, looked back from a date, so the outputs take addresses that
 * never received anything. Only output scripts ever leave this server.
 */
class Destinations(private val dir: File, private val rpc: Rpc) {
    enum class Kind { WATCH, JAM }
    class Dest(val id: String, val kind: Kind, val label: String, val key: String, val type: ScriptType, val since: Long?) {
        fun json(): JSONObject = JSONObject().put("id", id).put("kind", kind.name).put("label", label).put("key", key)
            .put("type", if (type == ScriptType.P2TR) "p2tr" else "p2wpkh").put("since", since ?: JSONObject.NULL)
        /** What the page shows: never the key itself. */
        fun public(): JSONObject = JSONObject().put("id", id).put("kind", kind.name.lowercase()).put("label", label)
            .put("type", if (type == ScriptType.P2TR) "p2tr" else "p2wpkh")
    }

    private val file = File(dir, "destinations.json")
    private val wallets = java.util.concurrent.ConcurrentHashMap<String, NodeWallet>()

    @Synchronized fun list(): List<Dest> = if (!file.exists()) emptyList() else runCatching {
        val a = JSONArray(file.readText())
        (0 until a.length()).map { a.getJSONObject(it) }.map { o ->
            Dest(o.getString("id"), Kind.valueOf(o.getString("kind")), o.getString("label"), o.getString("key"),
                if (o.getString("type") == "p2tr") ScriptType.P2TR else ScriptType.P2WPKH, if (o.isNull("since")) null else o.getLong("since"))
        }
    }.getOrDefault(emptyList())

    @Synchronized private fun save(l: List<Dest>) {
        val tmp = File(dir, "destinations.json.tmp"); tmp.writeText(JSONArray(l.map { it.json() }).toString(2)); tmp.renameTo(file)
    }

    fun get(id: String): Dest = list().firstOrNull { it.id == id } ?: error("That destination is not set up any more.")

    /** The ones a pool of [type] can use. */
    fun forType(type: ScriptType): List<Dest> = list().filter { it.type == type }

    /**
     * Adds a watch-only account key (zpub/xpub of a native SegWit wallet, or a Taproot one with
     * [taproot]) or a Jam export line (Apricot, native SegWit). [since]: unix time to look back
     * from (required: an address used and emptied before it would look unused). The node's rescan
     * can take a while.
     */
    fun add(text: String, label: String, taproot: Boolean, since: Long?): Dest {
        requireNotNull(since) { "Say from when to look back (around the day that wallet was made): its used addresses must be known, so none is used again." }
        val t = text.trim()
        val (kind, key, type) = if (t.startsWith(JoinMarket.PREFIX)) {
            val e = JoinMarket.parse(t)
            Triple(Kind.JAM, e.xpubs[0], ScriptType.P2WPKH)
        } else {
            runCatching { Bip32.parseExtendedPubKey(t) }.getOrElse { error("That is neither an account key (xpub/zpub) nor a Jam export line.") }
            require(!t.startsWith("ypub")) { "A ypub is nested SegWit (3…): coinjoin pools take bc1q or bc1p addresses only." }
            Triple(Kind.WATCH, t, if (taproot) ScriptType.P2TR else ScriptType.P2WPKH)
        }
        val id = Hashes.sha256((key + type.name).toByteArray()).toHex().take(12)
        require(list().none { it.id == id }) { "That wallet is already a destination." }
        val name = label.trim().ifEmpty { if (kind == Kind.JAM) "JoinMarket · Apricot" else "Watch-only wallet" }.take(40)
        val d = Dest(id, kind, name, key, type, since)
        save(list() + d)
        // The node looks back through the chain for it (minutes to hours): not on the page's request.
        Thread {
            runCatching { wallet(d).ensure(since) }
                .onFailure { System.err.println("[destination ${d.id}] ${it.message}") }
        }.apply { isDaemon = true }.start()
        return d
    }

    /** Whether the node is still looking back through the chain for [d]. */
    fun scanning(d: Dest): Boolean = runCatching {
        val info = rpc.call("getwalletinfo", wallet = wallet(d).name) as JSONObject
        info.opt("scanning").let { it != null && it != false && it.toString() != "false" }
    }.getOrDefault(true)

    fun remove(id: String) {
        val d = list().firstOrNull { it.id == id } ?: return
        runCatching { rpc.call("unloadwallet", wallet(d).name) }
        wallets.remove(id)
        save(list().filter { it.id != id })
    }

    private fun wallet(d: Dest): NodeWallet = wallets.getOrPut(d.id) {
        NodeWallet(File(dir, "dest-${d.id}").apply { mkdirs() }, rpc, d.key, d.type)
    }

    /**
     * [n] scripts of [d] that never received anything and no seat holds ([held], hex): the first
     * ones past its last used address, never more than the gap limit past it (the other wallet's
     * own scan would not see them).
     */
    fun scripts(d: Dest, n: Int, held: Set<String>): List<ByteArray> {
        val w = wallet(d)
        require(!scanning(d)) { "The node is still looking through the chain for ${d.label}: try again in a while." }
        val used = w.usedReceive()
        return pickUnused(n, used.maxOrNull() ?: -1, held) { i -> w.script(0, i) }
    }

    companion object {
        const val GAP = 20

        /** The first [n] scripts after [lastUsed] not in [held], within [GAP] of it. */
        fun pickUnused(n: Int, lastUsed: Int, held: Set<String>, derive: (Int) -> ByteArray): List<ByteArray> {
            val out = mutableListOf<ByteArray>()
            var j = lastUsed + 1
            while (out.size < n) {
                require(j - lastUsed <= GAP) {
                    "That wallet has too many addresses waiting for rounds: finish or cancel some first, or its own scan would not see the next ones."
                }
                val sp = derive(j)
                if (sp.toHex() !in held) out += sp
                j++
            }
            return out
        }
    }
}
