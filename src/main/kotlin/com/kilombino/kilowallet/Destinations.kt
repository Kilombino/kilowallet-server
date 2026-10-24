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
        /** What the page shows: never the whole key. */
        fun public(): JSONObject = JSONObject().put("id", id).put("kind", kind.name.lowercase()).put("label", label)
            .put("type", if (type == ScriptType.P2TR) "p2tr" else "p2wpkh").put("which", which())
        /**
         * Which wallet it is, as a round's card shows it: its name and the start of its key, so a
         * round left on a destination removed or replaced since still says where it goes.
         */
        fun which(): String = "$label (${key.take(12)}…)"
        /** An address's place in that wallet, as it shows it: Jam's Apricot is jar 0 (m/84'/0'/0'). */
        fun path(branch: Int, i: Int): String = if (kind == Kind.JAM) "m/84'/0'/0'/$branch/$i" else "…/$branch/$i"
    }

    /** An address a round's mixed output goes to, with its path in that wallet, to compare with it. */
    data class Shown(val address: String, val path: String) {
        fun json(): JSONObject = JSONObject().put("address", address).put("path", path)
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
    fun add(text: String, label: String, chosen: ScriptType?, since: Long?): Dest {
        requireNotNull(since) { "Say from when to look back (around the day that wallet was made): its used addresses must be known, so none is used again." }
        val t = text.trim().replace(Regex("\\s"), "")
        val (kind, key, type) = if (t.startsWith(JoinMarket.PREFIX)) {
            val e = JoinMarket.parse(text.trim())
            Triple(Kind.JAM, e.xpubs[0], ScriptType.P2WPKH)
        } else {
            val k = runCatching { Bip32.parseExtendedPubKey(t) }.getOrElse { error("That is neither an account key (xpub/zpub) nor a Jam export line.") }
            Triple(Kind.WATCH, t, typeOf(k.scriptType, chosen))
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
    }.also { w -> if (!w.nameResolved) runCatching { w.resolveName() } }

    /**
     * [n] scripts of [d] that never received anything and no seat holds ([held], hex): the first
     * ones past its last used address, never more than the gap limit past it (the other wallet's
     * own scan would not see them).
     */
    fun scripts(d: Dest, n: Int, held: Set<String>): List<ByteArray> {
        val w = wallet(d)
        return indexes(d, n, held).map { w.script(0, it) }
    }

    /**
     * The addresses [scripts] would pick now (the same ones, unless something reaches them first),
     * with their paths, to compare with that wallet before joining.
     */
    fun preview(d: Dest, n: Int, held: Set<String>): List<Shown> {
        val w = wallet(d)
        return indexes(d, n, held).map { Shown(w.address(0, it), d.path(0, it)) }
    }

    private fun indexes(d: Dest, n: Int, held: Set<String>): List<Int> {
        val w = wallet(d)
        require(!scanning(d)) { "The node is still looking through the chain for ${d.label}: try again in a while." }
        val used = w.usedReceive()
        return pickUnusedIndexes(n, used.maxOrNull() ?: -1, held) { i -> w.script(0, i) }
    }

    /**
     * Where a round's [scripts] are in [d] (receive or change, no node needed). One not found
     * (that wallet was replaced since) shows as its script with "?" for the path.
     */
    fun describe(d: Dest, scripts: List<ByteArray>): List<Shown> {
        val w = wallet(d)
        val want = scripts.map { it.toHex() }.toMutableSet()
        val found = HashMap<String, Shown>()
        for (b in 0..1) for (i in 0 until SEARCH) {
            if (want.isEmpty()) break
            val sp = w.script(b, i).toHex()
            if (want.remove(sp)) found[sp] = Shown(w.address(b, i), d.path(b, i))
        }
        return scripts.map { found[it.toHex()] ?: Shown(it.toHex(), "?") }
    }

    companion object {
        const val GAP = 20
        /** How far [describe] looks on each branch. */
        const val SEARCH = 1000

        /**
         * The address type of a watched key: a zpub says it (native SegWit); a plain xpub doesn't,
         * so it must be [chosen] (as the app asks since 1.2.4), bc1q or bc1p for a coinjoin.
         */
        fun typeOf(keyType: ScriptType, chosen: ScriptType?): ScriptType = when (keyType) {
            ScriptType.P2WPKH -> ScriptType.P2WPKH
            ScriptType.P2SH_P2WPKH -> error("A ypub is nested SegWit (3…): coinjoin pools take bc1q or bc1p addresses only.")
            else -> when (chosen) {
                null -> error("A plain xpub doesn't say which addresses it makes: pick the type your wallet uses.")
                ScriptType.P2WPKH, ScriptType.P2TR -> chosen
                else -> error("Coinjoin pools take native SegWit (bc1q) or Taproot (bc1p) addresses only.")
            }
        }

        /** The first [n] scripts after [lastUsed] not in [held], within [GAP] of it. */
        fun pickUnused(n: Int, lastUsed: Int, held: Set<String>, derive: (Int) -> ByteArray): List<ByteArray> =
            pickUnusedIndexes(n, lastUsed, held, derive).map(derive)

        /** As [pickUnused], the indexes of the addresses picked. */
        fun pickUnusedIndexes(n: Int, lastUsed: Int, held: Set<String>, derive: (Int) -> ByteArray): List<Int> {
            val out = mutableListOf<Int>()
            var j = lastUsed + 1
            while (out.size < n) {
                require(j - lastUsed <= GAP) {
                    "That wallet has too many addresses waiting for rounds: finish or cancel some first, or its own scan would not see the next ones."
                }
                if (derive(j).toHex() !in held) out += j
                j++
            }
            return out
        }
    }
}
