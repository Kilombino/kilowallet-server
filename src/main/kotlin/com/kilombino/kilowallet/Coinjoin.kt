package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.coinjoin.CoinjoinTx
import com.kilombino.pyblockwatch.coinjoin.PoolSession
import com.kilombino.pyblockwatch.coinjoin.Protocol
import com.kilombino.pyblockwatch.coinjoin.RelayClient
import com.kilombino.pyblockwatch.crypto.Bip32Priv
import com.kilombino.pyblockwatch.crypto.Hashes.toHex
import com.kilombino.pyblockwatch.crypto.ScriptType
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.math.BigInteger
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Coinjoin, as in the app's COINJOIN tab and in Kilojoin: the same pools, protocol and relay
 * ([Protocol.RELAY]), so this server, phones and Kilojoin nodes meet in the same rounds. Keeps
 * this wallet's rounds (persisted), lists the open pools, and records what happened as events,
 * for the web page, Telegram (the user's own bot) and StartOS notifications.
 *
 * Coins come from the node's watch-only wallet ([NodeWallet]); keys are derived from the
 * unlocked words only to join (the ownership proof) and to sign, and are never kept.
 */
class Coinjoin(private val dir: File, private val rpc: Rpc, private val walletProvider: () -> List<NodeWallet>) {
    private val sessionsFile = File(dir, "coinjoin-sessions.json")
    private val settingsFile = File(dir, "coinjoin.json")
    private val sessions = ConcurrentHashMap<String, PoolSession>()

    data class Event(val at: Long, val title: String, val text: String, val pool: String?)
    val events = CopyOnWriteArrayList<Event>()
    /** Called for every event. */
    @Volatile var onEvent: (Event) -> Unit = {}
    /** The unlocked wallet's words, for signing on its own (null while locked). */
    @Volatile var secretProvider: () -> Vault.Secret? = { null }

    private fun sats(v: Long) = "%,d".format(v).replace(',', ' ')

    // ------------------------------------------------------------------ settings

    @Synchronized fun settings(): JSONObject = if (settingsFile.exists()) runCatching { JSONObject(settingsFile.readText()) }.getOrDefault(JSONObject()) else JSONObject()
    @Synchronized fun setSetting(k: String, v: Any) {
        val o = settings(); o.put(k, v)
        val tmp = File(dir, "coinjoin.json.tmp"); tmp.writeText(o.toString()); tmp.renameTo(settingsFile)
    }
    /** Opt-in, as in the app: until the user turns it on, nothing is asked of the relay. */
    val enabled: Boolean get() = settings().optBoolean("enabled", false)
    val notifyNewPools: Boolean get() = settings().optBoolean("notify_new_pools", true)
    /**
     * Accept close requests and sign by itself when the transaction checks out (on by default,
     * as in the app): the password given when opening or joining a pool is the only one.
     */
    val autoSign: Boolean get() = settings().optBoolean("auto_sign", true)

    /**
     * Keys of the coins of each live round on its own, from the password given when opening or
     * joining it, so it signs even after the wallet is locked. Only in memory: a restart of the
     * service forgets them (the round then signs once the wallet is unlocked again).
     */
    private val roundKeys = ConcurrentHashMap<String, List<BigInteger>>()

    /** Telegram, through the user's own bot: every event also arrives there, with sound. */
    fun telegram(text: String): Result<Unit> = runCatching {
        val token = settings().optString("telegram_token").trim(); val chat = settings().optString("telegram_chat").trim()
        if (token.isEmpty() || chat.isEmpty()) return@runCatching
        val c = java.net.URL("https://api.telegram.org/bot$token/sendMessage").openConnection() as java.net.HttpURLConnection
        c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 15_000; c.readTimeout = 15_000
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write(JSONObject().put("chat_id", chat).put("text", text).toString().toByteArray()) }
        val code = c.responseCode
        if (code != 200) error("Telegram answered $code: " + (c.errorStream?.bufferedReader()?.readText()?.take(200) ?: ""))
    }

    /**
     * Scripts of this wallet's mixed outputs (hex), kept so a coin stays marked "mixed" after
     * its round is removed from the list. Spending one together with other coins would tie
     * them back together, so the send review warns about it.
     */
    @Synchronized
    fun mixedScripts(): Set<String> {
        val a = settings().optJSONArray("mixed_scripts") ?: JSONArray()
        val saved = (0 until a.length()).map { a.getString(it) }
        val live = sessions.values.map { it.state }
            .filter { it.phase == PoolSession.Phase.BROADCAST || it.phase == PoolSession.Phase.CONFIRMED }
            .map { it.mixScript.toHex() }
        return (saved + live).toSet()
    }

    @Synchronized
    private fun rememberMixed(scriptHex: String) {
        if (scriptHex in mixedScripts()) return
        setSetting("mixed_scripts", JSONArray((mixedScripts() + scriptHex).toList()))
    }

    /**
     * After a round: the node's watch-only wallet already follows every address of the account,
     * so this only reads the coins again (which marks the new mix and change addresses used,
     * moving the counters past them), off the caller's thread.
     */
    private fun rescanSoon(txid: String?) {
        Thread {
            runCatching {
                Thread.sleep(3000)
                val ws = walletProvider()
                txid?.let { t -> ws.firstOrNull()?.noteSent(t) }
                ws.forEach { it.utxos() }
            }
        }.start()
    }

    // ------------------------------------------------------------------ persistence

    @Synchronized
    private fun persist() {
        val a = JSONArray(); sessions.values.forEach { a.put(it.state.toJson()) }
        val tmp = File(dir, "coinjoin-sessions.json.tmp"); tmp.writeText(a.toString()); tmp.renameTo(sessionsFile)
    }

    fun load() {
        if (!sessionsFile.exists()) return
        val weekAgo = System.currentTimeMillis() / 1000 - 7 * 86400
        val a = runCatching { JSONArray(sessionsFile.readText()) }.getOrNull() ?: return
        for (i in 0 until a.length()) {
            val st = runCatching { PoolSession.State.parse(a.getJSONObject(i)) }.getOrNull() ?: continue
            val over = st.phase in setOf(PoolSession.Phase.CONFIRMED, PoolSession.Phase.ABORTED, PoolSession.Phase.REJECTED)
            if (over && st.created < weekAgo) continue
            sessions[st.poolId] = PoolSession(env(st), st)
        }
    }

    fun startAll() = sessions.values.filter { !it.done }.forEach { s -> Thread { runCatching { s.start() } }.start() }

    fun states(): List<PoolSession.State> = sessions.values.map { it.state }.sortedByDescending { it.created }
    fun session(id: String): PoolSession = sessions[id] ?: error("That pool is not in your list any more.")
    fun remove(id: String) { sessions.remove(id)?.stop(); roundKeys.remove(id); persist() }

    /** Rounds still running (a coin of ours is promised to them). */
    fun live(): List<PoolSession.State> = sessions.values.filter { !it.done && it.state.phase != PoolSession.Phase.BROADCAST }.map { it.state }

    /** Coins promised to a round that has not gone out: a normal send must not touch them. */
    fun lockedOutpoints(): Set<String> = live().flatMap { st -> st.seat.coins.map { it.outpoint } }.toSet()

    /** The wallet is being forgotten: its rounds go with it. */
    fun clear() {
        sessions.values.forEach { runCatching { it.stop() } }
        sessions.clear(); roundKeys.clear(); afterExact.clear(); persist()
        setSetting("mixed_scripts", JSONArray())
    }

    // ------------------------------------------------------------------ joining

    private fun add(st: PoolSession.State, keys: List<BigInteger>): PoolSession {
        if (autoSign) roundKeys[st.poolId] = keys
        val s = PoolSession(env(st), st)
        sessions[st.poolId] = s; persist()
        Thread { runCatching { s.start() } }.start()
        return s
    }

    /** BIP-84 for a native SegWit wallet, BIP-86 for a Taproot one: the pool's type is the wallet's. */
    private fun coinPath(w: NodeWallet, u: NodeWallet.Utxo) =
        "m/${if (w.type == ScriptType.P2TR) 86 else 84}'/0'/0'/${u.branch}/${u.index}"

    private class Pick(val coins: List<CoinjoinTx.Coin>, val keys: List<BigInteger>, val paths: List<String>, val mix: ByteArray, val change: ByteArray)

    /** The coins with their keys (each checked against the watch-only key), and fresh mix and change scripts. */
    private fun pick(secret: Vault.Secret, w: NodeWallet, us: List<NodeWallet.Utxo>): Pick {
        val master = Spend.master(secret)
        val paths = us.map { coinPath(w, it) }
        return pickNodes(w, us, paths.map { Bip32Priv.derivePath(master, it) }, paths)
    }

    private fun pickNodes(w: NodeWallet, us: List<NodeWallet.Utxo>, nodes: List<Bip32Priv.ExtendedPrivKey>, paths: List<String>): Pick {
        require(w.type == ScriptType.P2WPKH || w.type == ScriptType.P2TR) { "Coinjoin needs a native SegWit (bc1q) or Taproot (bc1p) wallet." }
        require(us.isNotEmpty()) { "Pick a coin." }
        us.indices.forEach { require(nodes[it].publicKey().contentEquals(w.pubkey(us[it].branch, us[it].index))) { "These words do not match this wallet's key." } }
        val coins = us.indices.map { CoinjoinTx.Coin(us[it].txid, us[it].vout, us[it].value, nodes[it].publicKey(), w.type) }
        val mix = w.reserveReceive().second
        val change = w.freshChange().second
        return Pick(coins, nodes.map { it.key }, paths, mix, change)
    }

    fun create(secret: Vault.Secret, w: NodeWallet, us: List<NodeWallet.Utxo>, amount: Long, feeRate: Double, minPeers: Int, maxPeers: Int,
               hours: Int, password: String?, maxInputs: Int = 1): PoolSession.State {
        // Kilojoin v3 (blind outputs), like the app since 1.1.5.
        val np = PoolSession.newPool(amount, feeRate, maxPeers, hours, minPeers, !password.isNullOrEmpty(), w.type, maxInputs, v3 = true)
        return createWith(pick(secret, w, us), np, password)
    }

    private fun createWith(p: Pick, np: PoolSession.Companion.NewPool, password: String?): PoolSession.State =
        add(PoolSession.newState(np.terms, true, np.secret, p.coins, p.keys, p.paths, p.mix, p.change, password?.ifEmpty { null },
            np.creatorSecret, np.blindPriv), p.keys).state

    fun join(secret: Vault.Secret, w: NodeWallet, us: List<NodeWallet.Utxo>, terms: Protocol.Terms, password: String?): PoolSession.State {
        require(terms.id !in sessions.keys || sessions[terms.id]!!.done) { "You are already in this pool." }
        require(terms.script == w.type) { "This pool takes ${if (terms.script == ScriptType.P2TR) "Taproot (bc1p)" else "native SegWit (bc1q)"} coins only, and this wallet's are not." }
        require(us.size <= terms.maxInputs) { "This pool takes at most ${terms.maxInputs} coin(s) per person." }
        return joinWith(pick(secret, w, us), w, terms, password)
    }

    private fun joinWith(p: Pick, w: NodeWallet, terms: Protocol.Terms, password: String?): PoolSession.State {
        require(terms.id !in sessions.keys || sessions[terms.id]!!.done) { "You are already in this pool." }
        require(terms.script == w.type) { "This pool takes another kind of coin." }
        return add(PoolSession.newState(terms, false, null, p.coins, p.keys, p.paths, p.mix, p.change, password?.ifEmpty { null }), p.keys).state
    }

    // ------------------------------------------------------------------ the perfect coin, then the pool

    /**
     * A pool waiting for its perfect coin. Once the payment to ourselves has one confirmation the
     * pool is joined (or opened) by itself, with the key of that coin derived when the payment was
     * signed: the password given for the payment is the only one. In memory only; after a restart
     * the coin waits among the others for a join by hand.
     */
    class AfterExact(val type: ScriptType, val index: Int, val value: Long, val poolId: String?, val poolPassword: String?,
                     val create: JSONObject?, val since: Long = System.currentTimeMillis() / 1000) {
        @Volatile var node: Bip32Priv.ExtendedPrivKey? = null
        @Volatile var path: String? = null
    }
    private val afterExact = ConcurrentHashMap<String, AfterExact>()  // by address

    fun expectExact(address: String, a: AfterExact) { afterExact[address] = a }
    fun waitingExact(): List<AfterExact> = afterExact.values.filter { it.node != null }

    /** The payment of [amount] to [address] was signed with [secret]: keep that coin's key for its pool. */
    fun exactSigned(address: String, amount: Long, secret: Vault.Secret) {
        val a = afterExact[address] ?: return
        if (amount != a.value) { afterExact.remove(address); return }
        val path = "m/${if (a.type == ScriptType.P2TR) 86 else 84}'/0'/0'/0/${a.index}"
        a.node = Bip32Priv.derivePath(Spend.master(secret), path); a.path = path
    }

    private fun checkExact() {
        val now = System.currentTimeMillis() / 1000
        for ((addr, a) in afterExact) {
            if (now - a.since > 3 * 86400) { afterExact.remove(addr); continue }
            val node = a.node ?: continue
            val w = walletProvider().firstOrNull { it.type == a.type } ?: continue
            val u = runCatching { w.utxos() }.getOrNull()
                ?.firstOrNull { it.branch == 0 && it.index == a.index && it.value == a.value && it.confirmations >= 1 } ?: continue
            afterExact.remove(addr)
            runCatching {
                val p = pickNodes(w, listOf(u), listOf(node), listOf(a.path!!))
                val c = a.create
                if (c != null) {
                    val np = PoolSession.newPool(c.getLong("amount"), c.getDouble("feeRate"), c.getInt("maxPeers"), c.getInt("hours"),
                        c.getInt("minPeers"), c.optString("poolPassword").isNotEmpty(), w.type, c.optInt("maxInputs", 1), v3 = true)
                    createWith(p, np, c.optString("poolPassword"))
                } else {
                    val t = fetchPools().firstOrNull { it.id == a.poolId } ?: error("that pool is no longer open")
                    joinWith(p, w, t, a.poolPassword)
                }
            }.onSuccess { emit("Coinjoin: perfect coin in", "${sats(a.value)} sats confirmed: " + (if (a.create != null) "pool opened" else "asked to join") + " on its own", it.poolId) }
             .onFailure { emit("Coinjoin: perfect coin ready", "${sats(a.value)} sats confirmed, but ${it.message}. Join a pool with it.", null) }
        }
    }

    fun sign(secret: Vault.Secret, poolId: String) {
        val s = session(poolId)
        val master = Spend.master(secret)
        s.sign(s.state.coinPaths.map { Bip32Priv.derivePath(master, it).key })
    }

    // ------------------------------------------------------------------ open pools

    fun fetchPools(sinceSeconds: Long = 3 * 86400): List<Protocol.Terms> {
        val found = ConcurrentHashMap<String, Protocol.Terms>()
        val r = RelayClient(Protocol.RELAY, { _, ev ->
            Protocol.Terms.parse(ev)?.let { t -> if ((found[t.id]?.createdAt ?: 0) < t.createdAt) found[t.id] = t }
        })
        try {
            r.connect()
            r.subscribe("pools", listOf(JSONObject().put("kinds", JSONArray().put(Protocol.KIND_POOL))
                .put("#t", JSONArray().put(Protocol.TAG)).put("since", System.currentTimeMillis() / 1000 - sinceSeconds)))
        } finally { r.close() }
        val now = System.currentTimeMillis() / 1000
        // A pool not re-announced for a while has lost its creator: nobody would let us in.
        return found.values.filter {
            it.state == "open" && it.expiresAt > now && it.peers < it.maxPeers && it.amount >= Protocol.MIN_AMOUNT &&
                now - it.createdAt < Protocol.STALE_AFTER
        }.sortedByDescending { it.createdAt }
    }

    /** Every few minutes, once coinjoin is on: tell about public pools opened since the last look. */
    fun startPoolWatcher() {
        Executors.newSingleThreadScheduledExecutor().scheduleWithFixedDelay({
            runCatching {
                if (!enabled || !notifyNewPools) return@runCatching
                val last = settings().optLong("last_pool_seen", System.currentTimeMillis() / 1000 - 3600)
                val pools = fetchPools(86400).filter { it.createdAt > last && it.id !in sessions.keys && !it.private }
                pools.maxOfOrNull { it.createdAt }?.let { setSetting("last_pool_seen", it) }
                pools.take(3).forEach { t -> emit("New coinjoin pool",
                    "${sats(t.amount)} sats${if (t.script == ScriptType.P2TR) " · Taproot" else ""} · ${t.peers}/${t.maxPeers} people · ${t.feeRate} sat/vB", t.id) }
            }
        }, 20, 300, TimeUnit.SECONDS)
        Executors.newSingleThreadScheduledExecutor().scheduleWithFixedDelay({ runCatching { checkExact() } }, 30, 30, TimeUnit.SECONDS)
    }

    // ------------------------------------------------------------------ events

    /** Records an event (coinjoin, Ark): the web page, Telegram and StartOS notifications get it. */
    fun emit(title: String, text: String, pool: String?) {
        val e = Event(System.currentTimeMillis(), title, text, pool)
        Thread { telegram("$title\n$text") }.start()
        events.add(0, e); while (events.size > 200) events.removeAt(events.size - 1)
        runCatching { onEvent(e) }
    }

    private fun env(st: PoolSession.State): PoolSession.Env = object : PoolSession.Env {
        override fun coinUnspent(coin: CoinjoinTx.Coin): Boolean {
            val o = rpc.txOut(coin.txid, coin.vout) ?: return false
            // The coin's own script too: a coin claimed under another address type does not match.
            return Math.round(o.getDouble("value") * 1e8) == coin.value &&
                o.optJSONObject("scriptPubKey")?.optString("hex") == coin.script.toHex()
        }
        override fun broadcast(rawHex: String): String = rpc.call("sendrawtransaction", rawHex) as String
        override fun confirmations(txid: String): Int? {
            // The round pays this wallet, so its node wallet knows it (pruned node, no txindex).
            for (w in walletProvider()) {
                runCatching { rpc.call("gettransaction", txid, true, wallet = w.name) as JSONObject }.getOrNull()
                    ?.optInt("confirmations", -1)?.takeIf { it >= 0 }?.let { return it }
            }
            for (i in 0 until 60) { rpc.txOut(txid, i)?.let { return it.optInt("confirmations") } }
            return runCatching { (rpc.call("getrawtransaction", txid, true) as JSONObject).optInt("confirmations") }.getOrNull()
        }
        override fun save(state: PoolSession.State) {
            if (state.phase == PoolSession.Phase.ABORTED && state.reason == PoolSession.LEFT_BY_CHOICE) {
                sessions.remove(state.poolId)?.let { gone -> Thread { runCatching { gone.stop() } }.start() }
            }
            persist()
        }
        override fun event(e: PoolSession.Event) {
            val pool = "${sats(st.terms.amount)} sats pool"
            when (e) {
                is PoolSession.Event.Changed -> {}
                is PoolSession.Event.DidAlone -> {}   // the app's way of running on its own; here the events below do it
                is PoolSession.Event.Welcomed -> emit("Coinjoin: you are in", "$pool · waiting for more people", st.poolId)
                is PoolSession.Event.Rejected -> emit("Coinjoin: join refused", e.reason, st.poolId)
                is PoolSession.Event.Joined -> emit("Coinjoin: someone joined", "$pool · ${e.peers}/${st.terms.maxPeers} people", st.poolId)
                is PoolSession.Event.CloseRequested -> if (!e.byMe) {
                    if (autoSign) {
                        Thread { runCatching { Thread.sleep(2000); sessions[st.poolId]?.vote(true) } }.start()
                        emit("Coinjoin: closing accepted", "$pool · ${e.peers} people (accepted on its own)", st.poolId)
                    } else emit("Coinjoin: close now?", "$pool · ${e.peers} people. Accept or refuse.", st.poolId)
                }
                is PoolSession.Event.CloseRefused -> emit("Coinjoin: stays open", "$pool · someone said not yet", st.poolId)
                is PoolSession.Event.Closing -> emit("Coinjoin: closing", "$pool · ${e.peers} people", st.poolId)
                is PoolSession.Event.SignNeeded -> {
                    val secret = secretProvider()
                    val keys = roundKeys[st.poolId]
                    if (autoSign && (keys != null || secret != null)) Thread {
                        Thread.sleep(2000)
                        // sign() checks our mixed output, change and fee first, and refuses otherwise.
                        runCatching { if (keys != null) session(st.poolId).sign(keys) else sign(secret!!, st.poolId) }
                            .onSuccess { emit("Coinjoin: signed", "$pool · checked and signed on its own", st.poolId) }
                            .onFailure { emit("Coinjoin: NOT signed", "$pool · ${it.message}. Check it in Kilowallet.", st.poolId) }
                    }.start()
                    else emit("Coinjoin: sign now", "$pool · the transaction is ready to sign" +
                        (if (autoSign) " (the service restarted: unlock Kilowallet to sign)" else ""), st.poolId)
                }
                is PoolSession.Event.Broadcast -> { roundKeys.remove(st.poolId); rememberMixed(st.mixScript.toHex()); rescanSoon(e.txid); emit("Coinjoin sent", "$pool · ${e.txid}", st.poolId) }
                is PoolSession.Event.Confirmed -> { rememberMixed(st.mixScript.toHex()); rescanSoon(e.txid); emit("Coinjoin confirmed", "$pool · ${e.txid}", st.poolId) }
                is PoolSession.Event.Aborted -> { roundKeys.remove(st.poolId); emit("Coinjoin cancelled", "$pool · ${e.reason}. Your coin did not move.", st.poolId) }
                is PoolSession.Event.ExpiringSoon -> emit("Coinjoin: under an hour left",
                    "$pool · ${e.peers}/${st.terms.maxPeers} people, enough to mix. It expires in ${e.minutes} min: ask to close now.", st.poolId)
            }
        }
        override fun log(msg: String) { System.err.println("[coinjoin ${st.poolId.take(8)}] $msg") }
    }
}
