package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.coinjoin.CoinjoinTx
import com.kilombino.pyblockwatch.coinjoin.PoolSession
import com.kilombino.pyblockwatch.coinjoin.Protocol
import com.kilombino.pyblockwatch.crypto.Bip32
import com.kilombino.pyblockwatch.crypto.Bip39
import com.kilombino.pyblockwatch.crypto.Hashes.toHex
import com.kilombino.pyblockwatch.crypto.Psbt
import com.kilombino.pyblockwatch.crypto.ScriptType
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * The web app and its JSON API. Everything past the static files needs a session cookie, got
 * by unlocking with the wallet password; a send is signed only after the password is given
 * again (the app's fingerprint). A hot wallet's words stay encrypted on disk ([Vault]) and in
 * memory only while unlocked.
 */
class Web(private val dir: File, private val rpc: Rpc, port: Int) {
    private val vault = Vault(dir)
    private val cfgFile = File(dir, "config.json")
    @Volatile private var secret: Vault.Secret? = null
    @Volatile private var token: String? = null
    @Volatile private var wallet: NodeWallet? = null
    @Volatile private var walletError: String? = null
    @Volatile private var importing = false
    private val drafts = ConcurrentHashMap<String, Spend.Draft>()
    private val server = HttpServer.create(InetSocketAddress(port), 0)
    private val rnd = SecureRandom()
    @Volatile private var market: JSONObject? = null
    /** Coinjoin rounds of this wallet (the app's COINJOIN tab). */
    val coinjoin = Coinjoin(dir, rpc) { wallet }
    /** Open pools as last listed, so a join is checked against what the user saw. */
    @Volatile private var pools: List<Protocol.Terms> = emptyList()
    /** Mixed-coin warnings of the open reviews, by draft id. */
    private val mixWarnings = ConcurrentHashMap<String, String>()

    init {
        coinjoin.secretProvider = { secret }
        coinjoin.load(); coinjoin.startAll(); coinjoin.startPoolWatcher()
        server.executor = Executors.newFixedThreadPool(8)
        server.createContext("/") { ex -> runCatching { route(ex) }.onFailure { e -> runCatching { reply(ex, 400, err(e.message ?: "error")) } } }
        openWallet()
    }

    fun start() {
        server.start()
        // Prices for USD/EUR, from the same feed the app and the widget use (can be turned off).
        Executors.newSingleThreadScheduledExecutor().scheduleWithFixedDelay({
            if (cfg().optBoolean("prices", true)) market = runCatching { fetchJson("https://mempool.kilombino.com/api/v1/blake2b/widget") }.getOrNull()
        }, 0, 15, java.util.concurrent.TimeUnit.MINUTES)
    }

    // ------------------------------------------------------------------ config

    @Synchronized private fun cfg(): JSONObject = if (cfgFile.exists()) JSONObject(cfgFile.readText()) else JSONObject()
    @Synchronized private fun saveCfg(f: (JSONObject) -> Unit) {
        val o = cfg(); f(o)
        val tmp = File(dir, "config.json.tmp"); tmp.writeText(o.toString(2)); tmp.renameTo(cfgFile)
    }

    private fun mode(): String = cfg().optString("mode", "")          // "", "hot", "watch"
    private fun type(): ScriptType = runCatching { ScriptType.valueOf(cfg().optString("type", "P2WPKH")) }.getOrDefault(ScriptType.P2WPKH)

    /**
     * [restored]: an existing wallet (restored words or a watched key), whose past matters;
     * [rescanFrom] its creation time when the user knows it, else found from its oldest coin.
     */
    private fun openWallet(rescanFrom: Long? = null, restored: Boolean = false) {
        val key = cfg().optString("accountKey").takeIf { it.isNotEmpty() } ?: return
        val w = NodeWallet(dir, rpc, key, type())
        walletError = null
        importing = restored
        Thread {
            runCatching { w.ensure(rescanFrom ?: if (restored) w.autoSince() else null) }.also { importing = false }.onFailure {
                walletError = "The node could not open this wallet's history: ${it.message}. The node needs its wallet " +
                    "feature enabled (not disablewallet)."
            }
        }.start()
        wallet = w
    }

    // ------------------------------------------------------------------ plumbing

    private fun err(m: String) = JSONObject().put("error", m)
    private fun ok() = JSONObject().put("ok", true)

    private fun reply(ex: HttpExchange, code: Int, body: Any, type: String = "application/json") {
        val bytes = (if (body is ByteArray) body else body.toString().toByteArray())
        ex.responseHeaders.add("Content-Type", type)
        ex.responseHeaders.add("Cache-Control", "no-store")
        ex.responseHeaders.add("X-Frame-Options", "DENY")
        ex.responseHeaders.add("Referrer-Policy", "no-referrer")
        ex.sendResponseHeaders(code, bytes.size.toLong())
        ex.responseBody.use { it.write(bytes) }
    }

    private fun body(ex: HttpExchange): JSONObject =
        ex.requestBody.bufferedReader().use { it.readText() }.let { if (it.isBlank()) JSONObject() else JSONObject(it) }

    private fun authed(ex: HttpExchange): Boolean {
        val t = token ?: return false
        val c = ex.requestHeaders["Cookie"]?.joinToString(";") ?: return false
        return c.split(';').map { it.trim() }.any { it == "kw=$t" }
    }

    private val types = mapOf("html" to "text/html; charset=utf-8", "js" to "application/javascript; charset=utf-8",
        "css" to "text/css; charset=utf-8", "png" to "image/png", "json" to "application/manifest+json", "svg" to "image/svg+xml")

    private fun static(ex: HttpExchange, name: String) {
        if (!name.matches(Regex("[a-z0-9.-]+"))) return reply(ex, 404, err("not found"))
        val r = javaClass.getResourceAsStream("/web/$name")?.readBytes() ?: return reply(ex, 404, err("not found"))
        reply(ex, 200, r, types[name.substringAfterLast('.')] ?: "application/octet-stream")
    }

    private fun newSession(ex: HttpExchange) {
        val t = ByteArray(24).also { rnd.nextBytes(it) }.toHex(); token = t
        ex.responseHeaders.add("Set-Cookie", "kw=$t; Path=/; HttpOnly; SameSite=Strict")
    }

    /** The password again, for anything that spends or shows secrets (the app asks for the fingerprint). */
    private fun recheck(b: JSONObject): Vault.Secret {
        return try { vault.open(b.optString("password")) } catch (e: Vault.WrongPassword) { Thread.sleep(1500); throw e }
    }

    private fun fetchJson(url: String): JSONObject {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000; c.readTimeout = 15_000
        return JSONObject(c.inputStream.bufferedReader().use { it.readText() })
    }

    // ------------------------------------------------------------------ routes

    private fun route(ex: HttpExchange) {
        val p = ex.requestURI.path
        // For the StartOS side only (same container): coinjoin events after a timestamp, to notify.
        if (p == "/internal/events") {
            if (!ex.remoteAddress.address.isLoopbackAddress) return reply(ex, 404, err("not found"))
            val since = ex.requestURI.query?.substringAfter("since=")?.substringBefore('&')?.toLongOrNull() ?: 0L
            return reply(ex, 200, JSONArray(coinjoin.events.filter { it.at > since }.map { eventJson(it) }))
        }
        if (!p.startsWith("/api/")) return static(ex, if (p == "/") "index.html" else p.removePrefix("/"))
        if (p == "/api/state") return reply(ex, 200, JSONObject().put("mode", mode()).put("unlocked", authed(ex))
            .put("version", javaClass.`package`?.implementationVersion ?: VERSION))
        val b = if (ex.requestMethod == "POST") body(ex) else JSONObject()
        when (p) {
            "/api/setup/new" -> return setupNew(ex, b)
            "/api/setup/restore" -> return setupRestore(ex, b)
            "/api/setup/watch" -> return setupWatch(ex, b)
            "/api/unlock" -> return unlock(ex, b)
        }
        if (!authed(ex)) return reply(ex, 401, err("locked"))
        val w = wallet ?: return reply(ex, 409, err("No wallet yet."))
        when (p) {
            "/api/lock" -> { secret = null; token = null; reply(ex, 200, ok()) }
            "/api/wallet" -> reply(ex, 200, walletJson(w))
            "/api/receive/next" -> { val (i, a) = w.next(); reply(ex, 200, JSONObject().put("index", i).put("address", a)) }
            "/api/fee" -> reply(ex, 200, JSONObject().put("suggested", rpc.feeEstimate() ?: JSONObject.NULL))
            "/api/send/prepare" -> {
                val chosen = b.optJSONArray("coins")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } ?: emptySet()
                val amount = b.optLong("amount", 0).takeIf { it > 0 && !b.optBoolean("max") }
                review(ex, w, planSend(w, chosen, resolve(b.getString("to")), amount, b.getDouble("rate")))
            }
            "/api/bump" -> review(ex, w, Spend.bump(w, b.getString("txid"), b.getDouble("rate"), ours(w)).also { requireUnlocked(it) })
            "/api/cpfp" -> review(ex, w, Spend.cpfp(w, b.getString("txid"), b.getDouble("rate"), spendable(w)))
            "/api/send/confirm" -> {
                val d = drafts[b.getString("draft")] ?: error("This review is no longer open: prepare it again.")
                require(mode() == "hot") { "A watch-only wallet signs elsewhere: export the PSBT." }
                require(Spend.concern(d) == null || b.optBoolean("acceptFee")) { Spend.concern(d)!! }
                mixWarnings[d.id]?.let { m -> require(b.optBoolean("acceptMix")) { m } }
                requireUnlocked(d)
                val signed = Spend.sign(recheck(b), d)
                val txid = w.broadcast(signed.rawHex).also { w.noteSent(it) }
                d.changeIndex?.let { w.freshChange() }
                drafts.remove(d.id); mixWarnings.remove(d.id)
                reply(ex, 200, JSONObject().put("txid", txid))
            }
            "/api/psbt/export" -> {
                val d = drafts[b.getString("draft")] ?: error("This review is no longer open: prepare it again.")
                require(Spend.concern(d) == null || b.optBoolean("acceptFee")) { Spend.concern(d)!! }
                mixWarnings[d.id]?.let { m -> require(b.optBoolean("acceptMix")) { m } }
                requireUnlocked(d)
                saveCfg { it.put("keyOrigin", b.optString("origin")) }
                val psbt = Spend.psbt(w, d, b.optString("origin"))
                reply(ex, 200, JSONObject().put("psbt", Psbt.base64(psbt)))
            }
            "/api/psbt/import" -> {
                val d = drafts[b.getString("draft")] ?: error("This review is no longer open: prepare it again.")
                val returned = runCatching { Psbt.decodeText(b.getString("psbt")) }.getOrElse { error("That is not a PSBT (base64 or hex).") }
                requireUnlocked(d)
                val signed = Spend.finishPsbt(w, d, returned, cfg().optString("keyOrigin"))
                val txid = w.broadcast(signed.rawHex).also { w.noteSent(it) }
                d.changeIndex?.let { w.freshChange() }
                drafts.remove(d.id); mixWarnings.remove(d.id)
                reply(ex, 200, JSONObject().put("txid", txid))
            }
            "/api/contacts" -> {
                if (ex.requestMethod == "POST") saveCfg { c ->
                    val list = c.optJSONArray("contacts") ?: JSONArray()
                    val keep = JSONArray((0 until list.length()).map { list.getJSONObject(it) }.filter { it.getString("address") != b.getString("address") })
                    if (!b.optBoolean("delete")) keep.put(JSONObject().put("name", b.getString("name").take(40)).put("address", b.getString("address").trim()))
                    c.put("contacts", keep)
                }
                reply(ex, 200, cfg().optJSONArray("contacts") ?: JSONArray())
            }
            "/api/settings" -> {
                if (ex.requestMethod == "POST") saveCfg { c ->
                    for (k in listOf("streetDefault", "prices")) if (b.has(k)) c.put(k, b.getBoolean(k))
                    if (b.has("explorer")) c.put("explorer", b.getString("explorer").trimEnd('/'))
                }
                reply(ex, 200, settingsJson())
            }
            "/api/secret/words" -> {
                require(mode() == "hot") { "A watch-only wallet has no words." }
                val s = recheck(b)
                reply(ex, 200, JSONObject().put("words", s.words.joinToString(" ")).put("passphrase", s.passphrase.isNotEmpty()))
            }
            "/api/password" -> {
                val s = recheck(b)
                if (mode() == "hot") vault.store(s.words, s.passphrase, b.getString("newPassword"))
                else vault.store(listOf("watch-only"), "", b.getString("newPassword"))
                reply(ex, 200, ok())
            }
            "/api/rescan" -> { Thread { runCatching { w.rescan(b.optInt("from", 0)) } }.start(); reply(ex, 200, ok()) }
            "/api/forget" -> {
                recheck(b)
                require(coinjoin.live().isEmpty()) { "A coin of this wallet is in a coinjoin round: leave the pool first." }
                coinjoin.clear()
                saveCfg { it.remove("accountKey"); it.remove("mode"); it.remove("type") }
                File(dir, "vault.json").delete()
                wallet = null; secret = null; token = null
                reply(ex, 200, ok())
            }
            else -> if (p.startsWith("/api/coinjoin")) coinjoinRoute(ex, p, b, w) else reply(ex, 404, err("not found"))
        }
    }

    // ------------------------------------------------------------------ coinjoin

    /** Coins a normal send may use: not promised to a coinjoin round. */
    private fun spendable(w: NodeWallet): List<NodeWallet.Utxo> {
        val locked = coinjoin.lockedOutpoints()
        return w.utxos().filter { it.outpoint !in locked }
    }

    private fun requireUnlocked(d: Spend.Draft) {
        val locked = coinjoin.lockedOutpoints()
        require(d.inputs.none { it.outpoint in locked }) { "A coin of this send is in a coinjoin round right now: leave the pool first, or pick other coins." }
    }

    private fun isMixed(w: NodeWallet, u: NodeWallet.Utxo, mixed: Set<String>) = w.script(u.branch, u.index).toHex() in mixed

    /**
     * A send, with coins in a live round left out. Without coin control, unmixed coins are
     * tried first, so a mixed coin is never pulled in with others unless nothing else covers it.
     */
    private fun planSend(w: NodeWallet, chosen: Set<String>, to: String, amount: Long?, rate: Double): Spend.Draft {
        val locked = coinjoin.lockedOutpoints()
        require(chosen.none { it in locked }) { "A chosen coin is in a coinjoin round right now." }
        val coins = spendable(w)
        if (chosen.isEmpty() && amount != null) {
            val mixed = coinjoin.mixedScripts()
            val plain = coins.filter { !isMixed(w, it, mixed) }
            if (plain.size in 1 until coins.size) runCatching { return Spend.plan(w, plain, chosen, to, amount, rate) }
        }
        return Spend.plan(w, coins, chosen, to, amount, rate)
    }

    /** A warning when the send would undo a mix: a mixed coin spent with others ties them together again. */
    private fun mixWarning(w: NodeWallet, d: Spend.Draft): String? {
        val mixed = coinjoin.mixedScripts()
        if (mixed.isEmpty() || d.cpfpParent != null || d.replaces != null) return null
        val nMixed = d.inputs.count { isMixed(w, it, mixed) }
        return when {
            nMixed > 0 && d.inputs.size > nMixed -> "You are spending mixed and unmixed coins together: anyone can link them again, which undoes the coinjoin."
            nMixed > 1 -> "You are spending several mixed coins together: they become linked to each other."
            nMixed > 0 && d.change > 0 -> "Spending part of a mixed coin leaves change that is tied to this payment."
            else -> null
        }
    }

    /** Only a hot wallet of native SegWit coins can join (the app's rule): every input and output must look alike. */
    private fun coinjoinBlocker(): String? = when {
        mode() != "hot" -> "Coinjoin needs a wallet that can sign here: a watch-only wallet can't prove it owns a coin or sign the round."
        type() != ScriptType.P2WPKH -> "Coinjoin needs native SegWit (bc1q) addresses: every coin and output in a round must look the same, or yours would stand out."
        else -> null
    }

    private fun cjCoin(w: NodeWallet, outpoint: String): NodeWallet.Utxo {
        require(outpoint !in coinjoin.lockedOutpoints()) { "That coin is already in a round." }
        val u = w.utxos().firstOrNull { it.outpoint == outpoint } ?: error("That coin is gone: reload the page.")
        require(u.confirmations > 0) { "Pick a confirmed coin." }
        return u
    }

    private fun coinjoinRoute(ex: HttpExchange, p: String, b: JSONObject, w: NodeWallet) {
        val post = ex.requestMethod == "POST"
        when (p) {
            "/api/coinjoin" -> reply(ex, 200, coinjoinJson(w))
            "/api/coinjoin/enable" -> { coinjoin.setSetting("enabled", b.optBoolean("on", true)); reply(ex, 200, coinjoinJson(w)) }
            "/api/coinjoin/events" -> reply(ex, 200, JSONArray(coinjoin.events.map { eventJson(it) }))
            "/api/coinjoin/settings" -> {
                if (post) {
                    for (k in listOf("notify_new_pools", "auto_sign")) if (b.has(k)) coinjoin.setSetting(k, b.getBoolean(k))
                    if (b.has("telegram_token")) coinjoin.setSetting("telegram_token", b.getString("telegram_token").trim())
                    if (b.has("telegram_chat")) coinjoin.setSetting("telegram_chat", b.getString("telegram_chat").trim())
                }
                reply(ex, 200, cjSettingsJson())
            }
            "/api/coinjoin/telegram/test" -> {
                require(coinjoin.settings().optString("telegram_token").isNotEmpty() && coinjoin.settings().optString("telegram_chat").isNotEmpty()) {
                    "Save the bot token and your chat id first."
                }
                val r = coinjoin.telegram("Kilowallet: test message. Coinjoin pool events will arrive here.")
                reply(ex, if (r.isSuccess) 200 else 400, if (r.isSuccess) ok() else err(r.exceptionOrNull()?.message ?: "failed"))
            }
            else -> {
                require(coinjoin.enabled) { "Turn coinjoin on first." }
                coinjoinBlocker()?.let { error(it) }
                coinjoinAction(ex, p, b, w)
            }
        }
    }

    private fun coinjoinAction(ex: HttpExchange, p: String, b: JSONObject, w: NodeWallet) {
        when (p) {
            "/api/coinjoin/pools" -> {
                val list = runCatching { coinjoin.fetchPools() }.getOrElse { error("Could not reach the relay: ${it.message}") }
                pools = list
                reply(ex, 200, JSONArray(list.map { termsJson(it) }))
            }
            "/api/coinjoin/create" -> {
                val amount = b.optLong("amount", 0); val rate = b.optDouble("feeRate", 0.0)
                val maxPeers = b.optInt("maxPeers", 5); val minPeers = b.optInt("minPeers", 2); val hours = b.optInt("hours", 6)
                require(amount in Protocol.MIN_AMOUNT..Protocol.MAX_AMOUNT) { "Amount: ${Protocol.MIN_AMOUNT} to ${Protocol.MAX_AMOUNT} sats (1 BTC)." }
                require(rate in 1.0..500.0) { "Fee: 1 to 500 sat/vB." }
                require(maxPeers in Protocol.MIN_PEERS..Protocol.MAX_PEERS) { "Most people: ${Protocol.MIN_PEERS} to ${Protocol.MAX_PEERS}." }
                require(minPeers in Protocol.MIN_PEERS..maxPeers) { "Fewest people: ${Protocol.MIN_PEERS} to $maxPeers (the most)." }
                require(hours in 1..72) { "Open for 1 to 72 hours." }
                val u = cjCoin(w, b.getString("coin"))
                require(u.value >= CoinjoinTx.minimumCoin(amount, rate)) { "That coin is too small for this pool." }
                val s = recheck(b)
                val st = coinjoin.create(s, w, u, amount, rate, minPeers, maxPeers, hours, b.optString("poolPassword"))
                reply(ex, 200, JSONObject().put("pool", st.poolId))
            }
            "/api/coinjoin/join" -> {
                val id = b.getString("pool")
                val t = pools.firstOrNull { it.id == id }
                    ?: runCatching { coinjoin.fetchPools() }.getOrNull()?.also { pools = it }?.firstOrNull { it.id == id }
                    ?: error("That pool is no longer open.")
                require(!t.private || b.optString("poolPassword").isNotEmpty()) { "Type the pool's password first." }
                val u = cjCoin(w, b.getString("coin"))
                require(u.value >= CoinjoinTx.minimumCoin(t.amount, t.feeRate)) { "That coin is too small for this pool." }
                val s = recheck(b)
                coinjoin.join(s, w, u, t, b.optString("poolPassword"))
                reply(ex, 200, ok())
            }
            "/api/coinjoin/close" -> { coinjoin.session(b.getString("pool")).requestClose(); reply(ex, 200, ok()) }
            "/api/coinjoin/vote" -> { coinjoin.session(b.getString("pool")).vote(b.getBoolean("accept")); reply(ex, 200, ok()) }
            "/api/coinjoin/sign" -> { coinjoin.sign(recheck(b), b.getString("pool")); reply(ex, 200, ok()) }
            "/api/coinjoin/leave" -> { coinjoin.session(b.getString("pool")).leave(); reply(ex, 200, ok()) }
            "/api/coinjoin/remove" -> { coinjoin.remove(b.getString("pool")); reply(ex, 200, ok()) }
            // The perfect coin for a pool: a payment to a fresh address of this wallet nobody has seen.
            "/api/coinjoin/exact" -> {
                val (i, script) = w.reserveReceive()
                reply(ex, 200, JSONObject().put("index", i).put("address", Spend.addressOf(script)))
            }
            else -> reply(ex, 404, err("not found"))
        }
    }

    private fun cjSettingsJson() = coinjoin.settings().let { c ->
        // The bot token is never sent back, only whether it is set.
        JSONObject().put("notify_new_pools", coinjoin.notifyNewPools).put("auto_sign", coinjoin.autoSign)
            .put("telegram_set", c.optString("telegram_token").isNotEmpty()).put("telegram_chat", c.optString("telegram_chat"))
    }

    private fun eventJson(e: Coinjoin.Event) = JSONObject().put("at", e.at).put("title", e.title).put("text", e.text).put("pool", e.pool ?: "")

    private fun termsJson(t: Protocol.Terms) = JSONObject()
        .put("id", t.id).put("amount", t.amount).put("feeRate", t.feeRate).put("peers", t.peers)
        .put("minPeers", t.minPeers).put("maxPeers", t.maxPeers).put("expiresAt", t.expiresAt).put("private", t.private)
        .put("feeWithChange", CoinjoinTx.feeShare(t.feeRate, true)).put("feeNoChange", CoinjoinTx.feeShare(t.feeRate, false))

    private fun coinjoinJson(w: NodeWallet): JSONObject {
        val o = JSONObject().put("enabled", coinjoin.enabled).put("relay", Protocol.RELAY)
            .put("blocker", coinjoinBlocker() ?: JSONObject.NULL).put("settings", cjSettingsJson())
            .put("unlockedForAutoSign", secret != null)
            .put("limits", JSONObject().put("minAmount", Protocol.MIN_AMOUNT).put("maxAmount", Protocol.MAX_AMOUNT)
                .put("minPeers", Protocol.MIN_PEERS).put("maxPeers", Protocol.MAX_PEERS).put("voteMinutes", Protocol.VOTE_SECONDS / 60)
                .put("joinMinutes", PoolSession.JOIN_TIMEOUT / 60).put("dust", CoinjoinTx.DUST))
        o.put("mine", JSONArray(coinjoin.states().map { stateJson(it) }))
        if (coinjoin.enabled && coinjoinBlocker() == null) {
            val locked = coinjoin.lockedOutpoints(); val mixed = coinjoin.mixedScripts()
            val us = runCatching { w.utxos() }.getOrDefault(emptyList())
            o.put("coins", JSONArray(us.map { u ->
                JSONObject().put("outpoint", u.outpoint).put("value", u.value).put("confirmations", u.confirmations)
                    .put("mixed", isMixed(w, u, mixed)).put("change", u.branch == 1).put("inRound", u.outpoint in locked)
            }))
        }
        return o
    }

    private fun stateJson(st: PoolSession.State): JSONObject {
        val plan = runCatching { coinjoin.session(st.poolId).plan() }.getOrNull()
        val people = if (st.round.isNotEmpty()) st.round.size else st.seats.size
        return JSONObject().put("id", st.poolId).put("amount", st.terms.amount).put("feeRate", st.terms.feeRate)
            .put("creator", st.creator).put("private", st.terms.private).put("phase", st.phase.name).put("reason", st.reason)
            .put("people", people).put("minPeers", st.terms.minPeers).put("maxPeers", st.terms.maxPeers)
            .put("expiresAt", st.terms.expiresAt).put("phaseDeadline", st.phaseDeadline).put("voteDeadline", st.voteDeadline)
            .put("coinValue", st.seat.coin.value).put("change", st.seat.changeValue)
            .put("iAsked", st.voteBy != null && st.voteBy == st.token?.let { Protocol.tokenHash(it) })
            .put("voted", st.votedOn != null && st.votedOn == st.voteId)
            .put("signed", st.postedSig).put("sigs", st.sigs.size).put("txid", st.txid ?: "")
            .put("planFee", plan?.fee ?: 0).put("planPeople", plan?.coins?.size ?: 0)
            .put("planIdentical", plan?.outputs?.count { it.value == st.terms.amount } ?: 0)
    }

    /** A user@domain handle isn't resolved on the server yet: only addresses. */
    private fun resolve(to: String): String {
        require(!to.contains("@")) { "Handles (user@domain) are not supported here yet: paste the address." }
        require(!to.trim().lowercase().startsWith("sp1")) { "Silent payments are not supported here yet." }
        return to.trim()
    }

    private fun ours(w: NodeWallet): Map<String, Pair<Int, Int>> {
        val m = HashMap<String, Pair<Int, Int>>()
        for (b in 0..1) for (i in 0 until 400) m[w.script(b, i).toHex()] = b to i
        return m
    }

    private fun review(ex: HttpExchange, w: NodeWallet, d: Spend.Draft) {
        drafts[d.id] = d
        val mix = mixWarning(w, d)?.also { mixWarnings[d.id] = it }
        reply(ex, 200, JSONObject().put("draft", d.id).put("to", d.toAddress).put("amount", d.amount).put("fee", d.fee)
            .put("change", d.change).put("inputs", d.inputs.size).put("vbytes", d.vbytes)
            .put("rate", d.fee / d.vbytes).put("concern", Spend.concern(d) ?: JSONObject.NULL)
            .put("replaces", d.replaces ?: JSONObject.NULL).put("replacedFee", d.replacedFee)
            .put("cpfpParent", d.cpfpParent ?: JSONObject.NULL).put("packageRate", d.packageRate)
            .put("mixWarning", mix ?: JSONObject.NULL))
    }

    // ------------------------------------------------------------------ setup

    private fun requireNoWallet() { require(mode().isEmpty()) { "This server already has a wallet." } }

    private fun setupNew(ex: HttpExchange, b: JSONObject) {
        requireNoWallet()
        val words = Bip39.fromEntropy(ByteArray(if (b.optInt("count", 12) == 24) 32 else 16).also { rnd.nextBytes(it) })
        finishHot(ex, words, b.optString("passphrase"), b.getString("password"), null, restored = false)
        // The new words are shown once, to be written down.
    }

    private fun setupRestore(ex: HttpExchange, b: JSONObject) {
        requireNoWallet()
        val words = b.getString("words").trim().lowercase().split(Regex("\\s+"))
        require(Bip39.isValid(words)) { "These words are not a valid BIP-39 seed (a word is wrong or out of order)." }
        finishHot(ex, words, b.optString("passphrase"), b.getString("password"), b.optLong("since", 0).takeIf { it > 0 }, restored = true)
    }

    private fun finishHot(ex: HttpExchange, words: List<String>, passphrase: String, password: String, since: Long?, restored: Boolean) {
        vault.store(words, passphrase, password)
        val s = Vault.Secret(words, passphrase)
        saveCfg { it.put("mode", "hot").put("type", "P2WPKH").put("accountKey", Spend.accountKey(s, ScriptType.P2WPKH)) }
        secret = s
        openWallet(since, restored)
        newSession(ex)
        reply(ex, 200, JSONObject().put("ok", true).apply { if (!restored) put("words", words.joinToString(" ")) })
    }

    private fun setupWatch(ex: HttpExchange, b: JSONObject) {
        requireNoWallet()
        val key = b.getString("key").trim()
        val parsed = runCatching { Bip32.parseExtendedPubKey(key) }.getOrElse { error(it.message ?: "Not an extended public key.") }
        val t = if (b.optBoolean("taproot")) ScriptType.P2TR else parsed.scriptType
        vault.store(listOf("watch-only"), "", b.getString("password"))
        saveCfg { it.put("mode", "watch").put("type", t.name).put("accountKey", key) }
        openWallet(b.optLong("since", 0).takeIf { it > 0 }, restored = true)
        newSession(ex)
        reply(ex, 200, ok())
    }

    private fun unlock(ex: HttpExchange, b: JSONObject) {
        val s = try { vault.open(b.getString("password")) } catch (e: Vault.WrongPassword) {
            Thread.sleep(1500) // slows guessing down
            return reply(ex, 403, err("Wrong password."))
        }
        secret = if (mode() == "hot") s else null
        newSession(ex)
        reply(ex, 200, ok())
    }

    // ------------------------------------------------------------------ JSON

    private fun settingsJson() = cfg().let { c ->
        JSONObject().put("streetDefault", c.optBoolean("streetDefault", true)).put("prices", c.optBoolean("prices", true))
            .put("explorer", c.optString("explorer", "https://mempool.kilombino.com")).put("keyOrigin", c.optString("keyOrigin"))
    }

    private fun walletJson(w: NodeWallet): JSONObject {
        val o = JSONObject().put("mode", mode()).put("type", type().name).put("node", w.name)
        walletError?.let { return o.put("error", it) }
        if (importing) return o.put("importing", true)
        val (conf, pending) = runCatching { w.balance() }.getOrElse { return o.put("error", it.message ?: "node error") }
        val txs = w.transactions()
        var left = conf + pending
        val txArr = JSONArray()
        for (t in txs) {
            txArr.put(JSONObject().put("txid", t.txid).put("net", t.net).put("confirmations", t.confirmations)
                .put("time", t.time).put("left", left))
            left -= t.net
        }
        val utxos = w.utxos()
        val (ri, ra) = w.receive()
        val locked = coinjoin.lockedOutpoints(); val mixed = coinjoin.mixedScripts()
        o.put("confirmed", conf).put("pending", pending).put("transactions", txArr)
            .put("coins", JSONArray(utxos.map { u ->
                JSONObject().put("outpoint", u.outpoint).put("value", u.value).put("confirmations", u.confirmations)
                    .put("address", w.address(u.branch, u.index)).put("change", u.branch == 1)
                    .put("mixed", isMixed(w, u, mixed)).put("inRound", u.outpoint in locked)
            }))
            .put("receive", JSONObject().put("index", ri).put("address", ra).put("path", "${ri}"))
            .put("height", runCatching { rpc.height() }.getOrDefault(0))
            .put("accountKey", cfg().optString("accountKey"))
            .put("settings", settingsJson())
            .put("contacts", cfg().optJSONArray("contacts") ?: JSONArray())
        market?.let { m -> o.put("price", JSONObject().put("usd", m.optDouble("xbtUsd")).put("eur", m.optDouble("xbtEur"))) }
        return o
    }

    companion object { const val VERSION = "0.2.0-beta1" }
}
