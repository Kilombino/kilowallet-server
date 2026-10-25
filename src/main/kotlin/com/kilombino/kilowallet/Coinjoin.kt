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

    private fun sats(v: Long) = "%,d".format(java.util.Locale.ROOT, v).replace(',', ' ')

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
            // A payment's outputs are the recipients' coins, not ours.
            .filter { !isPay(it.poolId) }
            .flatMap { st -> st.mixScripts.map { it.toHex() } }
        return (saved + live).toSet()
    }

    @Synchronized
    private fun rememberMixed(scriptHex: Collection<String>) {
        val all = mixedScripts()
        if (all.containsAll(scriptHex)) return
        setSetting("mixed_scripts", JSONArray((all + scriptHex).toList()))
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

    private class Pick(val coins: List<CoinjoinTx.Coin>, val keys: List<BigInteger>, val paths: List<String>, val mixes: List<ByteArray>, val change: ByteArray)

    /**
     * The coins with their keys (each checked against the watch-only key), and fresh scripts: one
     * per mixed output the pool gives each person (several in Kilojoin v4), and the change.
     */
    private fun pick(secret: Vault.Secret, w: NodeWallet, us: List<NodeWallet.Utxo>, outputs: Int, mixes: List<ByteArray>? = null): Pick {
        val master = Spend.master(secret)
        val paths = us.map { coinPath(w, it) }
        return pickNodes(w, us, paths.map { Bip32Priv.derivePath(master, it) }, paths, outputs, mixes)
    }

    /**
     * [mixesTo]: the mixed outputs' scripts when they go to another wallet (a destination); null
     * for fresh addresses of this one. The change always stays here.
     */
    private fun pickNodes(w: NodeWallet, us: List<NodeWallet.Utxo>, nodes: List<Bip32Priv.ExtendedPrivKey>, paths: List<String>, outputs: Int,
                          mixesTo: List<ByteArray>? = null): Pick {
        require(w.type == ScriptType.P2WPKH || w.type == ScriptType.P2TR) { "Coinjoin needs a native SegWit (bc1q) or Taproot (bc1p) wallet." }
        require(us.isNotEmpty()) { "Pick a coin." }
        us.indices.forEach { require(nodes[it].publicKey().contentEquals(w.pubkey(us[it].branch, us[it].index))) { "These words do not match this wallet's key." } }
        val coins = us.indices.map { CoinjoinTx.Coin(us[it].txid, us[it].vout, us[it].value, nodes[it].publicKey(), w.type) }
        val mixes = mixesTo?.also { m ->
            require(m.size == outputs) { "This pool gives $outputs mixed outputs each." }
            require(m.all { CoinjoinTx.isType(it, w.type) }) { "That destination's addresses are not of this pool's type." }
        } ?: (0 until outputs).map { w.reserveReceive().second }
        val change = w.freshChange().second
        return Pick(coins, nodes.map { it.key }, paths, mixes, change)
    }

    /**
     * [payments]: a payment pool (Kilojoin v5, as the app since 1.2.7): the amounts [mixes] (the
     * recipients' scripts, one each) are paid, summing to [outputs] × [amount], what each of the
     * others gets back in equal outputs. Empty for a pool of equal outputs.
     */
    fun create(secret: Vault.Secret, w: NodeWallet, us: List<NodeWallet.Utxo>, amount: Long, feeRate: Double, minPeers: Int, maxPeers: Int,
               hours: Int, password: String?, maxInputs: Int = 1, outputs: Int = 1, mixes: List<ByteArray>? = null,
               payments: List<Long> = emptyList()): PoolSession.State {
        // Kilojoin v3 (blind outputs), like the app since 1.1.5; v4 with several outputs each (1.2.0); v5 payments (1.2.7).
        val np = PoolSession.newPool(amount, feeRate, maxPeers, hours, minPeers, !password.isNullOrEmpty(), w.type, maxInputs, v3 = true,
            outputs = outputs, payments = payments)
        // The creator of a payment pool has one output per payment, whatever the others get.
        require(payments.isEmpty() || mixes?.size == payments.size) { "One recipient per payment." }
        return createWith(pick(secret, w, us, if (payments.isEmpty()) outputs else payments.size, mixes), np, password)
    }

    private fun createWith(p: Pick, np: PoolSession.Companion.NewPool, password: String?): PoolSession.State =
        add(PoolSession.newState(np.terms, true, np.secret, p.coins, p.keys, p.paths, p.mixes, p.change, password?.ifEmpty { null },
            np.creatorSecret, np.blindPriv), p.keys).state

    fun join(secret: Vault.Secret, w: NodeWallet, us: List<NodeWallet.Utxo>, terms: Protocol.Terms, password: String?,
             mixes: List<ByteArray>? = null): PoolSession.State {
        require(terms.id !in sessions.keys || sessions[terms.id]!!.done) { "You are already in this pool." }
        require(terms.script == w.type) { "This pool takes ${if (terms.script == ScriptType.P2TR) "Taproot (bc1p)" else "native SegWit (bc1q)"} coins only, and this wallet's are not." }
        require(us.size <= terms.maxInputs) { "This pool takes at most ${terms.maxInputs} coin(s) per person." }
        return joinWith(pick(secret, w, us, terms.outputs, mixes), w, terms, password)
    }

    private fun joinWith(p: Pick, w: NodeWallet, terms: Protocol.Terms, password: String?): PoolSession.State {
        require(terms.id !in sessions.keys || sessions[terms.id]!!.done) { "You are already in this pool." }
        require(terms.script == w.type) { "This pool takes another kind of coin." }
        require(p.mixes.size == terms.outputs) { "This pool gives ${terms.outputs} mixed outputs each." }
        return add(PoolSession.newState(terms, false, null, p.coins, p.keys, p.paths, p.mixes, p.change, password?.ifEmpty { null }), p.keys).state
    }

    // ------------------------------------------------------------------ the perfect coin, then the pool

    /**
     * A pool waiting for its perfect coin. Once the payment to ourselves has one confirmation the
     * pool is joined (or opened) by itself, with the key of that coin derived when the payment was
     * signed: the password given for the payment is the only one. In memory only; after a restart
     * the coin waits among the others for a join by hand.
     */
    class AfterExact(val type: ScriptType, val index: Int, val value: Long, val poolId: String?, val poolPassword: String?,
                     val create: JSONObject?, val since: Long = System.currentTimeMillis() / 1000,
                     /** A destination's id when the mixed outputs go to another wallet. */
                     val dest: String? = null) {
        @Volatile var node: Bip32Priv.ExtendedPrivKey? = null
        @Volatile var path: String? = null
    }
    private val afterExact = ConcurrentHashMap<String, AfterExact>()  // by address

    fun expectExact(address: String, a: AfterExact) { afterExact[address] = a }

    /** Unused scripts of a destination (id, pool type, how many): set by the server. */
    @Volatile var destScripts: ((String, ScriptType, Int) -> List<ByteArray>)? = null
    /** A destination's name and key start, for a round's card: set by the server. */
    @Volatile var destWhich: ((String) -> String?)? = null

    /** Mixed-output scripts seats still count on: rounds not over, or over after we posted ours. */
    fun heldScripts(): Set<String> = sessions.values.map { it.state }.filter { st ->
        val ended = st.phase == PoolSession.Phase.ABORTED || st.phase == PoolSession.Phase.REJECTED
        !(ended && !st.postedOutput) && !isPay(st.poolId)
    }.flatMap { it.mixScripts.map { m -> m.toHex() } }.toSet()

    private val destFile = File(dir, "coinjoin-dest.json")
    companion object {
        /** The "destination" of a payment through a pool: the recipients' own addresses, typed in SEND. */
        const val PAY = "pay"
    }
    /** Which destination a pool's mixed outputs go to (only when not this wallet), for its card. */
    /** [which]: that wallet's name and key start when the round began, for the card (see [Destinations.Dest.which]). */
    @Synchronized fun rememberDest(poolId: String, destId: String, which: String? = null) {
        val o = if (destFile.exists()) runCatching { JSONObject(destFile.readText()) }.getOrDefault(JSONObject()) else JSONObject()
        o.put(poolId, destId + (which?.let { "|$it" } ?: "")); destFile.writeText(o.toString())
    }
    /** A payment through the pool (from SEND): its outputs for us went to the recipients' own addresses. */
    fun isPay(poolId: String): Boolean = destOf(poolId) == PAY
    @Synchronized private fun destNote(poolId: String): String? =
        if (destFile.exists()) runCatching { JSONObject(destFile.readText()).optString(poolId).ifEmpty { null } }.getOrNull() else null
    fun destOf(poolId: String): String? = destNote(poolId)?.substringBefore('|')
    /** The wallet noted when the round began (rounds before 0.8.0 have none). */
    fun destWhichOf(poolId: String): String? = destNote(poolId)?.substringAfter('|', "")?.ifEmpty { null }
    fun waitingExact(): List<AfterExact> = afterExact.values.filter { it.node != null }

    /** The address type of the perfect coin awaited at [address], if it is one: its payment's change goes to that type too. */
    fun exactType(address: String): ScriptType? = afterExact[address]?.type

    /**
     * A payment that made perfect coins was cancelled (RBF back to this wallet): those coins will
     * never exist, and their pools are not waited for. [addresses]: the cancelled payment's outputs.
     */
    fun dropExact(addresses: Collection<String>) {
        for (a in addresses) afterExact.remove(a)?.let { x ->
            emit("Coinjoin: perfect coin cancelled", "The payment of ${sats(x.value)} sats to yourself was cancelled: " +
                (if (x.create != null) "the pool is not opened." else "the pool is not joined."), x.poolId)
        }
    }

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
                val c = a.create
                val outputs = c?.optInt("outputs", 1) ?: (fetchPools().firstOrNull { it.id == a.poolId }?.outputs ?: 1)
                val p = pickNodes(w, listOf(u), listOf(node), listOf(a.path!!), outputs,
                    a.dest?.let { d -> (destScripts ?: error("no destinations here"))(d, w.type, outputs) })
                val st = if (c != null) {
                    val np = PoolSession.newPool(c.getLong("amount"), c.getDouble("feeRate"), c.getInt("maxPeers"), c.getInt("hours"),
                        c.getInt("minPeers"), c.optString("poolPassword").isNotEmpty(), w.type, c.optInt("maxInputs", 1), v3 = true,
                        outputs = outputs)
                    createWith(p, np, c.optString("poolPassword"))
                } else {
                    val t = fetchPools().firstOrNull { it.id == a.poolId } ?: error("that pool is no longer open")
                    joinWith(p, w, t, a.poolPassword)
                }
                a.dest?.let { rememberDest(st.poolId, it, destWhich?.invoke(it)) }
                st
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
            // Below the minimum per person in all (amount × outputs) a pool is only a test, as in the app.
            it.state == "open" && it.expiresAt > now && it.peers < it.maxPeers && !Protocol.isTest(it) &&
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
                pools.asSequence().filter { firstNotice(it.id) }.take(3).forEach { t -> emit("New coinjoin pool",
                    "${if (t.outputs > 1) "${t.outputs} × " else ""}${sats(t.amount)} sats${if (t.script == ScriptType.P2TR) " · Taproot" else ""}" +
                        (if (t.v5) " · a payment pool" else "") + " · ${t.peers}/${t.maxPeers} people · ${t.feeRate} sat/vB", t.id) }
            }
        }, 20, 300, TimeUnit.SECONDS)
        Executors.newSingleThreadScheduledExecutor().scheduleWithFixedDelay({ runCatching { checkExact() } }, 30, 30, TimeUnit.SECONDS)
    }

    /**
     * True the first time a pool is to be notified, and remembered (as the app since 1.2.5): its
     * creator publishes it again on every change (someone joins, a vote) with a newer time, and
     * each of those read as a new pool. Kept three days, longer than any pool stays open.
     */
    @Synchronized internal fun firstNotice(poolId: String, now: Long = System.currentTimeMillis() / 1000): Boolean {
        val a = settings().optJSONObject("pools_notified") ?: JSONObject()
        val kept = JSONObject()
        for (k in a.keys()) if (a.optLong(k) > now - 3 * 86400) kept.put(k, a.optLong(k))
        if (kept.has(poolId)) return false
        kept.put(poolId, now); setSetting("pools_notified", kept)
        return true
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
            val pay = isPay(st.poolId)
            val pool = if (st.terms.v5 && st.creator) "payment pool, ${sats(st.terms.mixTotal)} sats to ${st.terms.payments.size} recipient(s)"
                else (if (st.terms.outputs > 1) "${st.terms.outputs} × " else "") + "${sats(st.terms.amount)} sats pool" + (if (pay) " (a payment)" else "")
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
                is PoolSession.Event.Broadcast -> { roundKeys.remove(st.poolId); if (!pay) rememberMixed(st.mixScripts.map { it.toHex() }); rescanSoon(e.txid)
                    emit(if (pay) "Coinjoin sent: the payment left" else "Coinjoin sent", "$pool · ${e.txid}", st.poolId) }
                is PoolSession.Event.Confirmed -> { if (!pay) rememberMixed(st.mixScripts.map { it.toHex() }); rescanSoon(e.txid)
                    emit(if (pay) "Coinjoin confirmed: paid" else "Coinjoin confirmed", "$pool · ${e.txid}", st.poolId) }
                is PoolSession.Event.Aborted -> { roundKeys.remove(st.poolId)
                    emit("Coinjoin cancelled", "$pool · ${e.reason}. " + (if (pay) "Nothing was paid: send it normally if you like." else "Your coin did not move."), st.poolId) }
                is PoolSession.Event.ExpiringSoon -> emit("Coinjoin: under an hour left",
                    "$pool · ${e.peers}/${st.terms.maxPeers} people, enough to mix. It expires in ${e.minutes} min: ask to close now.", st.poolId)
            }
        }
        override fun log(msg: String) { System.err.println("[coinjoin ${st.poolId.take(8)}] $msg") }
    }
}
