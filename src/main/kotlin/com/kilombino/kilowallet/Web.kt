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
class Web(private val dir: File, private val rpc: Rpc, port: Int, arkRpc: ArkRpc = ArkRpc(null, null, null, null)) {
    /** How the Ark engine reaches the node (the same RPC as the wallet's). */
    data class ArkRpc(val url: String?, val user: String?, val pass: String?, val cookie: String?)
    private val vault = Vault(dir)
    private val cfgFile = File(dir, "config.json")
    @Volatile private var secret: Vault.Secret? = null
    @Volatile private var token: String? = null
    @Volatile private var wallet: NodeWallet? = null
    /**
     * A hot wallet's Taproot (BIP-86) account, next to its own (BIP-84): a second watch-only wallet
     * in the node, set up at the first unlock after 0.3.0. Its coins count in the balance, can be
     * spent with the others and join Taproot pools.
     */
    @Volatile private var walletTr: NodeWallet? = null
    private fun wallets(): List<NodeWallet> = listOfNotNull(wallet, walletTr)
    /** The account whose coins are of [t] (null if this wallet has none of that type). */
    private fun walletFor(t: ScriptType): NodeWallet? = wallets().firstOrNull { it.type == t }
    private fun walletOf(u: NodeWallet.Utxo): NodeWallet = walletFor(u.type) ?: wallet!!
    @Volatile private var walletError: String? = null
    @Volatile private var importing = false
    private val drafts = ConcurrentHashMap<String, Spend.Draft>()
    private val server = HttpServer.create(InetSocketAddress(port), 0)
    private val rnd = SecureRandom()
    @Volatile private var market: JSONObject? = null
    /** Coinjoin rounds of this wallet (the app's COINJOIN tab). */
    val coinjoin = Coinjoin(dir, rpc) { wallets() }
    /** Other wallets a coinjoin's mixed outputs can go to (watch-only, Jam's Apricot). */
    val destinations = Destinations(dir, rpc).also { d ->
        coinjoin.destScripts = { id, type, n ->
            val dest = d.get(id)
            require(dest.type == type) { "${dest.label} has no addresses of this pool's type." }
            d.scripts(dest, n, coinjoin.heldScripts())
        }
        coinjoin.destWhich = { id -> d.list().firstOrNull { it.id == id }?.which() }
    }
    /** Open pools as last listed, so a join is checked against what the user saw. */
    @Volatile private var pools: List<Protocol.Terms> = emptyList()
    /** Mixed-coin warnings of the open reviews, by draft id. */
    private val mixWarnings = ConcurrentHashMap<String, String>()
    /** Ark (the app's ARK tab): the engine, run with this wallet's words. */
    val ark = ArkEngine(dir, arkRpc.url, arkRpc.user, arkRpc.pass, arkRpc.cookie, coinjoin) { runCatching { rpc.height() }.getOrNull() }
    /**
     * Which chain the node follows ([ChainCheck]), checked at start and every minute. Until it is
     * known to be the BLAKE2b chain nothing touches the node's wallets: no watch-only wallet is
     * created or loaded, nothing is scanned or sent, coinjoin rounds wait.
     */
    // Not known until the first check (a moment after start), test networks too: that first check
    // is what opens the wallet and starts the coinjoin rounds after a restart.
    @Volatile private var chain: ChainCheck.Result = ChainCheck.Result(ChainCheck.State.UNREACHABLE, detail = "not checked yet")
    @Volatile private var nodeWorkStarted = false

    init {
        coinjoin.secretProvider = { secret }
        coinjoin.load()
        server.executor = Executors.newFixedThreadPool(8)
        server.createContext("/") { ex -> runCatching { route(ex) }.onFailure { e -> runCatching { reply(ex, 400, err(e.message ?: "error")) } } }
        Executors.newSingleThreadScheduledExecutor().scheduleWithFixedDelay({ runCatching { checkChain() } }, 0, 60, java.util.concurrent.TimeUnit.SECONDS)
        ark.startTimers()
        Runtime.getRuntime().addShutdownHook(Thread { runCatching { ark.shutdown() } })
    }

    fun start() {
        server.start()
        // Prices for USD/EUR, from the same feed the app and the widget use (can be turned off).
        Executors.newSingleThreadScheduledExecutor().scheduleWithFixedDelay({
            if (cfg().optBoolean("prices", true)) market = runCatching { fetchJson("https://mempool.kilombino.com/api/v1/blake2b/widget") }.getOrNull()
        }, 0, 15, java.util.concurrent.TimeUnit.MINUTES)
    }

    // ------------------------------------------------------------------ the node's chain

    @Synchronized private fun checkChain() {
        val was = chain
        val now = if (NodeWallet.testnet) ChainCheck.Result(ChainCheck.State.SKIPPED)
            else runCatching { ChainCheck.check(rpc) }.getOrElse { ChainCheck.Result(ChainCheck.State.UNREACHABLE, detail = it.message) }
        // A node that stops answering for a moment is not a different chain: keep a good verdict.
        if (now.state == ChainCheck.State.UNREACHABLE && was.ok) return
        chain = now
        if (now.state != was.state) System.err.println("Node chain: ${now.state} (${now.title()}) at block ${now.height}")
        if (now.ok && !was.ok) {
            // Opening is idempotent (a wallet already in the node is only loaded), so it runs again after a bad spell.
            runCatching { openWallet() }
            if (!nodeWorkStarted) { nodeWorkStarted = true; coinjoin.startAll(); coinjoin.startPoolWatcher() }
        }
    }

    private fun requireChain() { check(chain.ok) { chain.title() + ". " + chain.message() } }

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
            runCatching { requireChain(); w.ensure(rescanFrom ?: if (restored) w.autoSince() else null) }.also { importing = false }.onFailure {
                walletError = "The node could not open this wallet's history: ${it.message}. The node needs its wallet " +
                    "feature enabled (not disablewallet)."
            }
        }.start()
        wallet = w
        openTaproot()
        warm(w)
    }

    /** Derives the addresses a speed-up or a cancellation looks its coins up in, ahead of time (seconds of work). */
    private fun warm(w: NodeWallet) = Thread {
        runCatching { for (b in 0..1) for (i in 0 until OURS) w.script(b, i) }
    }.apply { isDaemon = true; priority = Thread.MIN_PRIORITY }.start()

    /** The hot wallet's Taproot account, once its key is known (derived from the words at an unlock). */
    private fun openTaproot(rescanFrom: Long? = null) {
        if (mode() != "hot" || type() != ScriptType.P2WPKH) { walletTr = null; return }
        val key = cfg().optString("accountKeyTr").takeIf { it.isNotEmpty() } ?: return
        val w = NodeWallet(dir, rpc, key, ScriptType.P2TR)
        Thread { runCatching { requireChain(); w.ensure(rescanFrom ?: runCatching { w.autoSince() }.getOrNull()) }
            .onFailure { System.err.println("Taproot account: ${it.message}") } }.start()
        walletTr = w
        warm(w)
    }

    /** First unlock with the words after 0.3.0 (or a new wallet): work out and open the Taproot account. */
    private fun ensureTaproot(s: Vault.Secret) {
        if (mode() != "hot" || type() != ScriptType.P2WPKH || cfg().optString("accountKeyTr").isNotEmpty()) return
        saveCfg { it.put("accountKeyTr", Spend.accountKey(s, ScriptType.P2TR)) }
        openTaproot()
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
            .put("version", javaClass.`package`?.implementationVersion ?: VERSION).put("chain", chain.json()))
        // A node on another chain (or not known yet to be on this one): nothing but locking goes through.
        if (!chain.ok && p != "/api/lock") return reply(ex, 503, err(chain.title() + ". " + chain.message()).put("chain", chain.json()))
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
            "/api/receive/next" -> {
                val rw = if (b.optString("type") == "p2tr") walletTr ?: error("Unlock the wallet once to set up its Taproot addresses.") else w
                val (i, a) = rw.next(); reply(ex, 200, JSONObject().put("index", i).put("address", a).put("type", if (rw.type == ScriptType.P2TR) "p2tr" else "p2wpkh"))
            }
            "/api/fee" -> reply(ex, 200, JSONObject().put("suggested", rpc.feeEstimate() ?: JSONObject.NULL))
            "/api/send/prepare" -> {
                val chosen = b.optJSONArray("coins")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } ?: emptySet()
                val amount = b.optLong("amount", 0).takeIf { it > 0 && !b.optBoolean("max") }
                // More recipients, as the app's SEND: one transaction pays them all.
                val extra = b.optJSONArray("extra")?.let { a -> (0 until a.length()).map { a.getJSONObject(it) }
                    .map { resolve(it.getString("to")) to it.optLong("amount", 0) } } ?: emptyList()
                review(ex, w, planSend(w, chosen, resolve(b.getString("to")), amount, b.getDouble("rate"), extra))
            }
            "/api/bump" -> review(ex, w, Spend.bump(w, b.getString("txid"), b.getDouble("rate"), ours(), oursTypes()).also { requireUnlocked(it) })
            "/api/cpfp" -> review(ex, w, Spend.cpfp(w, b.getString("txid"), b.getDouble("rate"), allSpendable()))
            // Cancel an unconfirmed send (RBF back to a fresh change address of this wallet).
            "/api/cancel" -> review(ex, w, Spend.cancel(w, b.getString("txid"), b.optDouble("rate", 1.0), ours(), oursTypes()) { t -> walletFor(t) ?: w }
                .also { requireUnlocked(it) })
            "/api/send/confirm" -> {
                val d = drafts[b.getString("draft")] ?: error("This review is no longer open: prepare it again.")
                require(mode() == "hot") { "A watch-only wallet signs elsewhere: export the PSBT." }
                require(Spend.concern(d) == null || b.optBoolean("acceptFee")) { Spend.concern(d)!! }
                mixWarnings[d.id]?.let { m -> require(b.optBoolean("acceptMix")) { m } }
                requireUnlocked(d)
                val sec = recheck(b)
                val signed = Spend.sign(sec, d)
                val txid = w.broadcast(signed.rawHex).also { w.noteSent(it) }
                // The perfect coin of a pool: its key goes with it, so the pool goes on by itself.
                runCatching { coinjoin.exactSigned(d.toAddress, d.amount, sec) }
                afterSent(w, d)
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
                afterSent(w, d)
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
            "/api/destinations" -> reply(ex, 200, destinationsJson())
            "/api/destinations/add" -> {
                recheck(b)
                val since = if (b.isNull("since") || !b.has("since")) null else b.getLong("since")
                destinations.add(b.getString("text"), b.optString("label"), chosenType(b), since)
                reply(ex, 200, destinationsJson())
            }
            "/api/destinations/remove" -> {
                val id = b.getString("id")
                require(coinjoin.live().none { coinjoin.destOf(it.poolId) == id }) { "A round still going sends its mixed outputs there: wait for it first." }
                destinations.remove(id); reply(ex, 200, destinationsJson())
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
            "/api/rescan" -> { Thread { wallets().forEach { x -> runCatching { x.rescan(b.optInt("from", 0)) } } }.start(); reply(ex, 200, ok()) }
            "/api/forget" -> {
                recheck(b)
                require(coinjoin.live().isEmpty()) { "A coin of this wallet is in a coinjoin round: leave the pool first." }
                coinjoin.clear()
                // The Ark wallet goes too, but its folder is only set aside: it may still hold coins.
                ark.forget()
                saveCfg { it.remove("accountKey"); it.remove("accountKeyTr"); it.remove("mode"); it.remove("type"); it.remove("createdHeight") }
                File(dir, "vault.json").delete()
                wallet = null; walletTr = null; secret = null; token = null
                reply(ex, 200, ok())
            }
            else -> when {
                p.startsWith("/api/coinjoin") -> coinjoinRoute(ex, p, b, w)
                p.startsWith("/api/ark") -> arkRoute(ex, p, b)
                else -> reply(ex, 404, err("not found"))
            }
        }
    }

    // ------------------------------------------------------------------ ark

    private fun strs(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).map { a.getString(it) }

    private fun arkBlocker(): String? = if (mode() != "hot")
        "Ark needs a wallet that can sign here: it runs with this wallet's words, and a watch-only wallet has none." else null

    private fun arkJson(): JSONObject {
        val a = ark
        val o = JSONObject().put("enabled", a.enabled).put("activating", a.activating).put("running", a.running)
            .put("hasWords", a.hasWords).put("error", a.lastError ?: JSONObject.NULL).put("chain", a.chain)
            .put("blocker", arkBlocker() ?: JSONObject.NULL).put("server", ArkEngine.SERVER).put("esplora", ArkEngine.ESPLORA)
            .put("limits", JSONObject().put("lifetime", ArkEngine.VTXO_LIFETIME_BLOCKS).put("minBoard", ArkEngine.MIN_BOARD_SAT)
                .put("boardConfs", ArkEngine.BOARD_CONFIRMATIONS).put("maxVtxo", ArkEngine.MAX_VTXO_SAT)
                .put("maxLightning", ArkEngine.MAX_LIGHTNING_SAT).put("minOutput", ArkEngine.MIN_OUTPUT_SAT)
                .put("warnBlocks", ArkEngine.EXPIRY_WARN_BLOCKS))
        if (!a.enabled && !a.activating) { o.put("nodeProblem", a.nodeProblem(rpc) ?: JSONObject.NULL); return o }
        if (!a.running) {
            val known = a.state().optInt("nearest_expiry_height", 0)
            val tip = runCatching { rpc.height() }.getOrNull()
            if (known > 0 && tip != null) o.put("expiry", known - tip).put("expiryStale", true)
            return o
        }
        val b = runCatching { a.balance() }.getOrElse { return o.put("error", it.message) }
        o.put("balance", JSONObject().put("spendable", b.spendable).put("pendingBoard", b.pendingBoard).put("pendingRound", b.pendingRound)
            .put("needsRefresh", b.needsRefresh).put("pendingExit", b.pendingExit).put("onchainConfirmed", b.onchainConfirmed)
            .put("onchainPending", b.onchainPending).put("lightningPending", b.lightningPending).put("refused", b.refused))
        a.blocksToNearestExpiry()?.let { o.put("expiry", it) }
        val arkTip = a.tip(); val nodeTip = runCatching { rpc.height() }.getOrNull()
        o.put("tip", arkTip ?: JSONObject.NULL).put("nodeTip", nodeTip ?: JSONObject.NULL)
        // With Esplora as its chain source the engine could be shown another chain than the node's.
        if (arkTip != null && nodeTip != null && kotlin.math.abs(arkTip - nodeTip) > 3) o.put("tipMismatch",
            "The Ark engine's chain source (block $arkTip) and your node (block $nodeTip) disagree. One of them is behind or not telling the whole story: wait before moving Ark funds, and check your node.")
        o.put("activity", JSONArray(runCatching { a.activity() }.getOrDefault(emptyList()).take(40).map { it.json() }))
        o.put("exits", JSONArray(a.exits().let { list -> val lost = if (list.isEmpty()) emptySet() else a.lostExits()
            list.map { e -> JSONObject().put("vtxo", e.vtxo).put("type", e.type).put("claimableHeight", e.claimableHeight ?: JSONObject.NULL)
                .put("tip", e.tip ?: JSONObject.NULL).put("lost", e.vtxo in lost) } }))
        return o
    }

    private fun estimateJson(e: ArkEngine.Estimate?) = e?.json() ?: err("Could not estimate the cost. Check the destination and the amount.")

    private fun arkRoute(ex: HttpExchange, p: String, b: JSONObject) {
        val a = ark
        if (p == "/api/ark") return reply(ex, 200, arkJson())
        arkBlocker()?.let { error(it) }
        if (p == "/api/ark/activate") {
            require(b.optBoolean("accept")) { "Read the warnings and tick the box first." }
            val s = recheck(b)
            val useNode = b.optString("chain", "node") == "node"
            if (useNode) a.nodeProblem(rpc)?.let { error(it) }
            val tip = runCatching { rpc.height() }.getOrNull() ?: error("The node did not answer.")
            val created = cfg().optInt("createdHeight", 0)
            val birthday = minOf(tip, if (created > 0) created else ArkEngine.ARK_EPOCH_HEIGHT)
            // Creating can take a while (the deposit's past is looked up): it goes on in the background.
            Thread { runCatching { a.activate(s, useNode, birthday) }.onFailure { System.err.println("Ark activation failed: ${it.message}") } }.start()
            return reply(ex, 200, ok())
        }
        require(a.enabled) { "Activate Ark first." }
        val to = b.optString("to").trim()
        val amount = b.optLong("amount", 0).takeIf { it > 0 }
        val coins = strs(b.optJSONArray("coins"))
        when (p) {
            "/api/ark/sync" -> { a.syncOnchain(); reply(ex, 200, arkJson()) }
            "/api/ark/address" -> reply(ex, 200, JSONObject().put("address", if (b.optString("kind") == "deposit") a.onchainAddress() else a.arkAddress()))
            "/api/ark/invoice" -> reply(ex, 200, JSONObject().put("invoice", a.lightningInvoice(amount ?: error("Type the amount in sats first."))))
            "/api/ark/invoice/state" -> reply(ex, 200, JSONObject().put("state", a.lightningReceiveState(b.getString("invoice")) ?: JSONObject.NULL))
            "/api/ark/offer" -> reply(ex, 200, JSONObject().put("offer", a.reusableOffer("Kilowallet", amount)))
            "/api/ark/offer/disable" -> { a.disableOffer(); reply(ex, 200, ok()) }
            "/api/ark/fees" -> reply(ex, 200, a.onchainFeeRates()?.let { JSONObject().put("fast", it.fast).put("regular", it.regular).put("slow", it.slow) } ?: JSONObject())
            "/api/ark/coins" -> reply(ex, 200, JSONArray((if (b.optBoolean("deposit")) a.depositCoins() else a.arkCoins()).map { c ->
                JSONObject().put("id", c.id).put("amount", c.amount).put("note", c.note).put("refused", c.id in a.rejected()) }))
            "/api/ark/estimate" -> {
                val fromDeposit = b.optBoolean("fromDeposit")
                val e = when (b.optString("kind")) {
                    "lnreceive" -> a.estimateLightningReceive(amount ?: error("Type the amount in sats first."))
                    "board" -> {
                        val rate = b.optDouble("rate", Double.NaN).takeIf { !it.isNaN() }
                        val avail = a.balance().onchainConfirmed
                        val netFee = rate?.let { runCatching { a.estimateBoardNetworkFee(it, amount == null) }.getOrNull() }
                        val target = amount ?: (avail - (netFee ?: 0))
                        if (target < ArkEngine.MIN_BOARD_SAT) ArkEngine.Estimate(0, 0, 0, false, "", "Moving into Ark needs at least ${ArkEngine.MIN_BOARD_SAT} sats confirmed in the deposit.")
                        else feeQueryBoard(a, target)?.let { it.copy(note = it.note + (netFee?.let { f -> " Plus the network fee of the move: about $f sats, paid from the deposit." } ?: "")) }
                    }
                    "renew" -> if (coins.isEmpty()) a.estimateRenew() else a.estimateRenewCoins(coins)
                    "exit" -> a.estimateExit()
                    else -> when {
                        to.isEmpty() -> error("Type where to send.")
                        b.optBoolean("choose") && coins.isEmpty() -> ArkEngine.Estimate(0, 0, 0, false, "", "Tick the coins to spend.")
                        b.optBoolean("choose") && fromDeposit -> a.estimateDepositCoins(to, amount, coins)
                        b.optBoolean("choose") && to.startsWith("ark1", true) ->
                            if (amount == null) ArkEngine.Estimate(0, 0, 0, false, "", "Enter the amount to pay.") else a.estimateArkCoins(to, amount, coins)
                        b.optBoolean("choose") && to.startsWith("ln", true) -> ArkEngine.Estimate(0, 0, 0, false, "",
                            "Choosing coins works for Ark payments and withdrawals to an XBT address. Lightning payments pick their coins themselves.")
                        b.optBoolean("choose") && amount != null -> ArkEngine.Estimate(0, 0, 0, false, "", "Chosen Ark coins leave whole: leave the amount empty.")
                        b.optBoolean("choose") -> a.estimateWithdrawCoins(to, coins)
                        fromDeposit -> a.estimateDepositSend(to, amount)
                        else -> a.estimateSend(to, amount)?.let { q ->
                            // The engine quotes a cost without looking at the balance: say so before a review.
                            val have = runCatching { a.balance().spendable }.getOrNull()
                            if (q.problem == null && have != null && q.total > have) q.copy(problem = "That needs ${q.total} sats in total and you have $have spendable in Ark.") else q
                        }
                    }
                }
                reply(ex, 200, estimateJson(e))
            }
            "/api/ark/send" -> {
                recheck(b)
                val approved = b.optLong("approved", 0).takeIf { it > 0 } ?: error("Review the cost first.")
                val fromDeposit = b.optBoolean("fromDeposit")
                val r = when {
                    coins.isNotEmpty() && fromDeposit -> a.sendDepositCoins(to, amount, coins)
                    coins.isNotEmpty() && to.startsWith("ark1", true) && amount != null -> a.sendArkCoins(to, amount, approved, coins)
                    coins.isNotEmpty() -> a.withdrawCoins(to, coins)
                    fromDeposit -> a.sendFromDeposit(to, amount)
                    else -> a.send(to, amount, approved)
                }.ifBlank { "Sent." }
                reply(ex, 200, JSONObject().put("message", r))
            }
            "/api/ark/board" -> {
                recheck(b)
                val rate = b.optDouble("rate", Double.NaN).takeIf { !it.isNaN() }
                require(rate == null || rate in 0.1..10_000.0) { "Fee rate: 0.1 to 10 000 sat/vB." }
                require(amount == null || amount >= ArkEngine.MIN_BOARD_SAT) { "Minimum to move into Ark: ${ArkEngine.MIN_BOARD_SAT} sats." }
                a.board(amount, rate)
                reply(ex, 200, JSONObject().put("message", "Moving into Ark. It becomes spendable after ${ArkEngine.BOARD_CONFIRMATIONS} confirmations."))
            }
            "/api/ark/renew" -> {
                recheck(b)
                val chosen = coins.ifEmpty { a.arkCoins().map { it.id } }
                require(chosen.isNotEmpty()) { "You have no Ark coins to renew." }
                reply(ex, 200, JSONObject().put("message", a.renewSkippingRejected(chosen)))
            }
            "/api/ark/exit/start" -> {
                require(b.optString("confirm") == "EXIT") { "Type EXIT to confirm." }
                recheck(b)
                reply(ex, 200, JSONObject().put("message", "Emergency exit started: " + a.startExitAll()))
            }
            "/api/ark/exit/claim" -> { recheck(b); reply(ex, 200, JSONObject().put("message", a.claimExits(to))) }
            "/api/ark/log" -> reply(ex, 200, JSONObject().put("log", a.engineLogTail() ?: ""))
            else -> reply(ex, 404, err("not found"))
        }
    }

    /**
     * Moving [sats] into Ark. The server's quote leaves out what Paperclip documents: boarding costs
     * the greater of the quote or 1 000 sats (the anchor) plus a separate 1 000-sat miner fee.
     */
    private fun feeQueryBoard(a: ArkEngine, sats: Long): ArkEngine.Estimate? = runCatching {
        val r = JSONObject(a.call("GET", "/fees/board?amount_sat=$sats"))
        val fee = maxOf(r.optLong("fee_sat"), 1_000L) + 1_000L
        ArkEngine.Estimate(sats - fee, fee, sats, false, "Anchor and miner fee of the recovery transaction.")
    }.getOrNull()

    // ------------------------------------------------------------------ coinjoin

    /** Coins a normal send may use: not promised to a coinjoin round. */
    private fun spendable(w: NodeWallet): List<NodeWallet.Utxo> {
        val locked = coinjoin.lockedOutpoints()
        return w.utxos().filter { it.outpoint !in locked }
    }

    /** Every account's spendable coins (a hot wallet's bc1q and bc1p), biggest first. */
    private fun allSpendable(): List<NodeWallet.Utxo> = wallets().flatMap { spendable(it) }.sortedByDescending { it.value }

    private fun requireUnlocked(d: Spend.Draft) {
        val locked = coinjoin.lockedOutpoints()
        require(d.inputs.none { it.outpoint in locked }) { "A coin of this send is in a coinjoin round right now: leave the pool first, or pick other coins." }
    }

    @Suppress("UNUSED_PARAMETER")
    private fun isMixed(w: NodeWallet, u: NodeWallet.Utxo, mixed: Set<String>) = walletOf(u).script(u.branch, u.index).toHex() in mixed

    /**
     * A send, with coins in a live round left out. Without coin control, unmixed coins are
     * tried first, so a mixed coin is never pulled in with others unless nothing else covers it.
     */
    private fun planSend(w: NodeWallet, chosen: Set<String>, to: String, amount: Long?, rate: Double,
                         extra: List<Pair<String, Long>> = emptyList()): Spend.Draft {
        val locked = coinjoin.lockedOutpoints()
        require(chosen.none { it in locked }) { "A chosen coin is in a coinjoin round right now." }
        val coins = allSpendable()
        // The payment that makes a perfect coin: its change goes to the pool's account, like the coin.
        val changeTo = runCatching { coinjoin.exactType(Spend.addressOf(com.kilombino.pyblockwatch.crypto.Address.decodeToScriptPubKey(to))) }
            .getOrNull()?.let { walletFor(it) } ?: w
        if (chosen.isEmpty() && amount != null) {
            val mixed = coinjoin.mixedScripts()
            val plain = coins.filter { !isMixed(w, it, mixed) }
            if (plain.size in 1 until coins.size) runCatching { return Spend.plan(w, plain, chosen, to, amount, rate, changeTo, extra) }
        }
        return Spend.plan(w, coins, chosen, to, amount, rate, changeTo, extra)
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
        walletFor(ScriptType.P2WPKH) == null && walletFor(ScriptType.P2TR) == null ->
            "Coinjoin needs native SegWit (bc1q) or Taproot (bc1p) addresses: every coin and output in a round must look the same, or yours would stand out."
        else -> null
    }

    /** The coins a create/join asks for: `coins` (a list) or the older single `coin`. */
    /** The account a pool of [t] uses, or why there is none. */
    private fun cjWallet(t: ScriptType): NodeWallet = walletFor(t)
        ?: error(if (t == ScriptType.P2TR) "This wallet has no Taproot (bc1p) account yet: unlock it once to set it up." else "This wallet has no native SegWit (bc1q) coins.")

    private fun cjCoins(w: NodeWallet, b: JSONObject): List<NodeWallet.Utxo> {
        val ops = b.optJSONArray("coins")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: listOf(b.getString("coin"))
        require(ops.isNotEmpty() && ops.toSet().size == ops.size) { "Pick each coin once." }
        return ops.map { cjCoin(w, it) }
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
            "/api/coinjoin/enable" -> {
                coinjoin.setSetting("enabled", b.optBoolean("on", true))
                // "Open without notifications" (as the app since 1.2.5): the tab, but no word about new pools.
                if (b.has("notify")) coinjoin.setSetting("notify_new_pools", b.getBoolean("notify"))
                reply(ex, 200, coinjoinJson(w))
            }
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
                val rate = b.optDouble("feeRate", 0.0)
                val maxPeers = b.optInt("maxPeers", 5); val minPeers = b.optInt("minPeers", 2); val hours = b.optInt("hours", 6)
                require(rate in 1.0..500.0) { "Fee: 1 to 500 sat/vB." }
                require(maxPeers in Protocol.MIN_PEERS..Protocol.MAX_PEERS) { "Most people: ${Protocol.MIN_PEERS} to ${Protocol.MAX_PEERS}." }
                require(minPeers in Protocol.MIN_PEERS..maxPeers) { "Fewest people: ${Protocol.MIN_PEERS} to $maxPeers (the most)." }
                require(hours in 1..72) { "Open for 1 to 72 hours." }
                val maxInputs = b.optInt("maxInputs", 1)
                require(maxInputs in 1..Protocol.MAX_INPUTS) { "Coins per person: 1 to ${Protocol.MAX_INPUTS}." }
                // A payment from SEND (as the app since 1.2.7): its recipients, each with its amount.
                val pay = b.optJSONArray("pay")?.let { a -> (0 until a.length()).map { a.getJSONObject(it) }.map { it.getString("to").trim() to it.getLong("amount") } }
                val payV5 = pay != null && b.optBoolean("paymentPool")
                val check = pay?.let { CoinjoinPay.check(it, walletFor(ScriptType.P2TR) != null) }
                if (check != null) require(if (payV5) check.paymentOk else check.ok) { check.reason ?: "These payments can't go through one pool." }
                val type = check?.type ?: if (b.optString("script") == "p2tr") ScriptType.P2TR else ScriptType.P2WPKH
                val pw = cjWallet(type)
                val us = cjCoins(pw, b)
                require(us.size <= maxInputs) { "At most $maxInputs coin(s) per person in this pool." }
                // v5: the payments' total split for the others, the outputs asked for when it splits evenly, else one.
                val split = if (payV5) Protocol.v5Split(check!!.amounts.sum(), b.optInt("outputs", 1)) else null
                val outputs = split?.second ?: if (pay != null) pay.size else b.optInt("outputs", 1)
                require(outputs in 1..Protocol.MAX_OUTPUTS) { "Mixed outputs per person: 1 to ${Protocol.MAX_OUTPUTS}." }
                // From your coins (the app's default since 1.2.7): the amount worked out so they go in with no change.
                val fromCoins = pay == null && b.optBoolean("fromCoins")
                val amount = when {
                    split != null -> split.first
                    pay != null -> check!!.amount
                    fromCoins -> CoinjoinTx.noChangeAmount(us.sumOf { it.value }, us.size, rate, pw.type, outputs) ?: error("These coins don't even cover the fee.")
                    else -> b.optLong("amount", 0)
                }
                require(amount in Protocol.TEST_MIN_AMOUNT..Protocol.MAX_AMOUNT) {
                    if (fromCoins) "These coins make ${amount.coerceAtLeast(0)} sats per output: a pool takes ${Protocol.TEST_MIN_AMOUNT} to ${Protocol.MAX_AMOUNT} sats (1 BTC) per output."
                    else "Amount per output: ${Protocol.TEST_MIN_AMOUNT} to ${Protocol.MAX_AMOUNT} sats (1 BTC)."
                }
                // The minimum is per person in all, amount × outputs (the app since 1.2.7): below it a pool is only a test.
                require(amount * outputs >= Protocol.MIN_AMOUNT) {
                    "$amount × $outputs = ${amount * outputs} sats each: a pool takes at least ${Protocol.MIN_AMOUNT} each in all."
                }
                val payments = if (payV5) check!!.amounts else emptyList()
                // What our seat puts in, over how many outputs of ours (the payments, for a payment pool's creator).
                val mixTotal = amount * outputs
                val ourOutputs = if (payV5) payments.size else outputs
                require(CoinjoinTx.changeOf(us.sumOf { it.value }, mixTotal, rate, us.size, pw.type, ourOutputs) != null) { "These coins are too small for this pool." }
                val s = recheck(b)
                val dest = if (pay != null) null else b.optString("dest").ifEmpty { null }
                val mixes = check?.scripts ?: dest?.let { coinjoin.destScripts!!(it, pw.type, outputs) }
                val st = coinjoin.create(s, pw, us, amount, rate, minPeers, maxPeers, hours, b.optString("poolPassword"), maxInputs, outputs, mixes, payments)
                if (pay != null) coinjoin.rememberDest(st.poolId, Coinjoin.PAY)
                dest?.let { coinjoin.rememberDest(st.poolId, it, destinations.get(it).which()) }
                reply(ex, 200, JSONObject().put("pool", st.poolId).put("amount", amount).put("outputs", outputs))
            }
            // Whether SEND's recipients can be paid through a pool, and how (the app's rule).
            "/api/coinjoin/pay/check" -> {
                val a = b.getJSONArray("recipients")
                val r = (0 until a.length()).map { a.getJSONObject(it) }.map { it.optString("to").trim() to it.optLong("amount", 0) }
                val c = CoinjoinPay.check(r, walletFor(ScriptType.P2TR) != null)
                reply(ex, 200, JSONObject().put("ok", c.ok).put("paymentOk", c.paymentOk).put("any", c.any).put("reason", c.reason ?: JSONObject.NULL)
                    .put("type", c.type?.let { Protocol.scriptName(it) } ?: JSONObject.NULL).put("amount", c.amount)
                    .put("amounts", JSONArray(c.amounts)).put("total", c.amounts.sum()))
            }
            "/api/coinjoin/join" -> {
                val id = b.getString("pool")
                val t = pools.firstOrNull { it.id == id }
                    ?: runCatching { coinjoin.fetchPools() }.getOrNull()?.also { pools = it }?.firstOrNull { it.id == id }
                    ?: error("That pool is no longer open.")
                require(!t.private || b.optString("poolPassword").isNotEmpty()) { "Type the pool's password first." }
                val pw = cjWallet(t.script)
                val us = cjCoins(pw, b)
                require(CoinjoinTx.change(us.sumOf { it.value }, t.amount, t.feeRate, us.size, t.script, t.outputs) != null) { "These coins are too small for this pool." }
                val s = recheck(b)
                val dest = b.optString("dest").ifEmpty { null }
                val mixes = dest?.let { coinjoin.destScripts!!(it, pw.type, t.outputs) }
                coinjoin.join(s, pw, us, t, b.optString("poolPassword"), mixes)
                dest?.let { coinjoin.rememberDest(t.id, it, destinations.get(it).which()) }
                reply(ex, 200, ok())
            }
            // The unused addresses of a destination the mixed outputs would take now, one per output, with their paths.
            "/api/coinjoin/dest/preview" -> {
                val d = destinations.get(b.getString("dest"))
                val t = if (b.optString("script") == "p2tr") ScriptType.P2TR else ScriptType.P2WPKH
                require(d.type == t) { "${d.label} has no addresses of this pool's type." }
                val n = b.optInt("outputs", 1)
                require(n in 1..Protocol.MAX_OUTPUTS) { "Mixed outputs per person: 1 to ${Protocol.MAX_OUTPUTS}." }
                reply(ex, 200, JSONArray(destinations.preview(d, n, coinjoin.heldScripts()).map { it.json() }))
            }
            // A round going to another wallet: the real addresses of its mixed outputs, with their paths.
            "/api/coinjoin/round/addresses" -> {
                val st = coinjoin.session(b.getString("pool")).state
                val id = coinjoin.destOf(st.poolId) ?: error("This round's mixed outputs come to this wallet.")
                val d = destinations.list().firstOrNull { it.id == id } ?: error("That wallet is not a destination here any more.")
                reply(ex, 200, JSONArray(destinations.describe(d, st.mixScripts).map { it.json() }))
            }
            "/api/coinjoin/close" -> { coinjoin.session(b.getString("pool")).requestClose(); reply(ex, 200, ok()) }
            "/api/coinjoin/vote" -> { coinjoin.session(b.getString("pool")).vote(b.getBoolean("accept")); reply(ex, 200, ok()) }
            "/api/coinjoin/sign" -> { coinjoin.sign(recheck(b), b.getString("pool")); reply(ex, 200, ok()) }
            "/api/coinjoin/leave" -> { coinjoin.session(b.getString("pool")).leave(); reply(ex, 200, ok()) }
            "/api/coinjoin/remove" -> { coinjoin.remove(b.getString("pool")); reply(ex, 200, ok()) }
            // The perfect coin for a pool: a payment to a fresh address of this wallet nobody has seen.
            "/api/coinjoin/exact" -> {
                // Of the pool's type, whatever coins pay for it.
                val t = if (b.optString("script") == "p2tr") ScriptType.P2TR else ScriptType.P2WPKH
                val (i, script) = cjWallet(t).reserveReceive()
                val address = Spend.addressOf(script)
                // What to do once it confirms: join that pool, or open the one being set up.
                val after = b.optJSONObject("after")
                if (after != null && b.optLong("exact", 0) > 0) {
                    val c = after.optJSONObject("create")
                    if (c != null) {
                        require(c.optLong("amount") in Protocol.TEST_MIN_AMOUNT..Protocol.MAX_AMOUNT &&
                            c.optLong("amount") * c.optInt("outputs", 1) >= Protocol.MIN_AMOUNT && c.optDouble("feeRate") in 1.0..500.0 &&
                            c.optInt("maxPeers") in Protocol.MIN_PEERS..Protocol.MAX_PEERS && c.optInt("minPeers") in Protocol.MIN_PEERS..c.optInt("maxPeers") &&
                            c.optInt("hours") in 1..72 && c.optInt("maxInputs", 1) in 1..Protocol.MAX_INPUTS &&
                            c.optInt("outputs", 1) in 1..Protocol.MAX_OUTPUTS) { "Check the pool's settings." }
                    }
                    val dest = b.optString("dest").ifEmpty { null }
                    dest?.let { require(destinations.get(it).type == t) { "That destination has no addresses of this pool's type." } }
                    coinjoin.expectExact(address, Coinjoin.AfterExact(t, i, b.getLong("exact"),
                        after.optString("pool").ifEmpty { null }, after.optString("poolPassword").ifEmpty { null }, c, dest = dest))
                }
                reply(ex, 200, JSONObject().put("index", i).put("address", address))
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
        .put("feeWithChange", CoinjoinTx.feeShare(t.feeRate, true, 1, t.script, t.outputs))
        .put("feeNoChange", CoinjoinTx.feeShare(t.feeRate, false, 1, t.script, t.outputs))
        .put("script", Protocol.scriptName(t.script)).put("maxInputs", t.maxInputs).put("version", t.version).put("outputs", t.outputs)
        .put("v5", t.v5).put("payments", JSONArray(t.payments)).put("mixTotal", t.mixTotal).put("test", Protocol.isTest(t))
        .put("joinable", walletFor(t.script) != null)

    private fun coinjoinJson(w: NodeWallet): JSONObject {
        val o = JSONObject().put("enabled", coinjoin.enabled).put("relay", Protocol.RELAY)
            .put("blocker", coinjoinBlocker() ?: JSONObject.NULL).put("settings", cjSettingsJson())
            .put("script", Protocol.scriptName(if (type() == ScriptType.P2TR) ScriptType.P2TR else ScriptType.P2WPKH))
            .put("taproot", walletFor(ScriptType.P2TR) != null).put("segwit", walletFor(ScriptType.P2WPKH) != null)
            .put("maxInputs", Protocol.MAX_INPUTS)
            .put("destinations", destinationsJson())
            .put("unlockedForAutoSign", secret != null)
            .put("waitingExact", JSONArray(coinjoin.waitingExact().map { JSONObject().put("value", it.value).put("create", it.create != null) }))
            .put("limits", JSONObject().put("minAmount", Protocol.MIN_AMOUNT).put("maxAmount", Protocol.MAX_AMOUNT)
                .put("testMinAmount", Protocol.TEST_MIN_AMOUNT).put("minPayment", Protocol.MIN_PAYMENT).put("maxOutputs", Protocol.MAX_OUTPUTS)
                .put("maxInputs", Protocol.MAX_INPUTS)
                .put("minPeers", Protocol.MIN_PEERS).put("maxPeers", Protocol.MAX_PEERS).put("voteMinutes", Protocol.VOTE_SECONDS / 60)
                .put("joinMinutes", PoolSession.JOIN_TIMEOUT / 60).put("dust", CoinjoinTx.DUST))
        o.put("mine", JSONArray(coinjoin.states().map { stateJson(it) }))
        if (coinjoin.enabled && coinjoinBlocker() == null) {
            val locked = coinjoin.lockedOutpoints(); val mixed = coinjoin.mixedScripts()
            val us = wallets().flatMap { x -> runCatching { x.utxos() }.getOrDefault(emptyList()) }.sortedByDescending { it.value }
            o.put("coins", JSONArray(us.map { u ->
                JSONObject().put("outpoint", u.outpoint).put("value", u.value).put("confirmations", u.confirmations)
                    .put("mixed", isMixed(w, u, mixed)).put("change", u.branch == 1).put("inRound", u.outpoint in locked)
                    .put("address", walletOf(u).address(u.branch, u.index))
                    .put("type", if (u.type == ScriptType.P2TR) "p2tr" else "p2wpkh")
            }))
        }
        return o
    }

    private fun stateJson(st: PoolSession.State): JSONObject {
        val plan = runCatching { coinjoin.session(st.poolId).plan() }.getOrNull()
        val people = if (st.round.isNotEmpty()) st.round.size else st.seats.size
        return JSONObject().put("id", st.poolId).put("amount", st.terms.amount).put("feeRate", st.terms.feeRate).put("outputs", st.terms.outputs)
            .put("creator", st.creator).put("private", st.terms.private).put("phase", st.phase.name).put("reason", st.reason)
            .put("people", people).put("minPeers", st.terms.minPeers).put("maxPeers", st.terms.maxPeers)
            .put("expiresAt", st.terms.expiresAt).put("phaseDeadline", st.phaseDeadline).put("voteDeadline", st.voteDeadline)
            .put("coinValue", st.seat.inputValue).put("coins", st.seat.coins.size).put("change", st.seat.changeValue)
            .put("script", Protocol.scriptName(st.terms.script))
            .put("dest", coinjoin.destOf(st.poolId)?.takeIf { it != Coinjoin.PAY }?.let { id ->
                coinjoin.destWhichOf(st.poolId) ?: destinations.list().firstOrNull { it.id == id }?.which() ?: "another wallet (removed since)" } ?: JSONObject.NULL)
            .put("v5", st.terms.v5).put("payments", JSONArray(st.terms.payments)).put("mixTotal", st.terms.mixTotal)
            // A payment through the pool: what it pays, and to whom (only on this server, never announced).
            .put("pay", coinjoin.isPay(st.poolId))
            .put("recipients", if (!coinjoin.isPay(st.poolId)) JSONArray() else JSONArray(st.mixScripts.mapIndexed { i, sp ->
                JSONObject().put("address", Spend.addressOf(sp)).put("amount", if (st.terms.v5 && st.creator) st.terms.payments.getOrElse(i) { 0L } else st.terms.amount) }))
            .put("iAsked", st.voteBy != null && st.voteBy == st.token?.let { Protocol.tokenHash(it) })
            .put("voted", st.votedOn != null && st.votedOn == st.voteId)
            .put("signed", st.postedSig).put("sigs", st.sigs.size).put("txid", st.txid ?: "")
            .put("planFee", plan?.fee ?: 0).put("planPeople", st.round.size).put("planCoins", plan?.coins?.size ?: 0)
            .put("planIdentical", plan?.outputs?.count { it.value == st.terms.amount } ?: 0)
            .put("planPayments", if (st.terms.v5) st.terms.payments.size else 0)
    }

    /** A user@domain handle isn't resolved on the server yet: only addresses. */
    private fun resolve(to: String): String {
        require(!to.contains("@")) { "Handles (user@domain) are not supported here yet: paste the address." }
        require(!to.trim().lowercase().startsWith("sp1")) { "Silent payments are not supported here yet." }
        return to.trim()
    }

    private fun ours(): Map<String, Pair<Int, Int>> {
        val m = HashMap<String, Pair<Int, Int>>()
        for (w in wallets()) for (b in 0..1) for (i in 0 until OURS) m[w.script(b, i).toHex()] = b to i
        return m
    }

    /** The type of each of our scripts, for a replacement that spends coins of both accounts. */
    private fun oursTypes(): Map<String, ScriptType> {
        val m = HashMap<String, ScriptType>()
        for (w in wallets()) for (b in 0..1) for (i in 0 until OURS) m[w.script(b, i).toHex()] = w.type
        return m
    }

    /** After a send went out: its change address is used, and a cancelled payment's perfect coins will never come. */
    private fun afterSent(w: NodeWallet, d: Spend.Draft) {
        d.changeIndex?.let { (walletFor(d.changeType) ?: w).freshChange() }
        if (d.cancels) runCatching { coinjoin.dropExact(d.cancelled) }
    }

    private fun review(ex: HttpExchange, w: NodeWallet, d: Spend.Draft) {
        drafts[d.id] = d
        val mix = mixWarning(w, d)?.also { mixWarnings[d.id] = it }
        reply(ex, 200, JSONObject().put("draft", d.id).put("to", d.toAddress).put("amount", d.amount).put("fee", d.fee)
            .put("change", d.change).put("inputs", d.inputs.size).put("vbytes", d.vbytes)
            .put("changeAddress", d.changeIndex?.let { Spend.addressOf((walletFor(d.changeType) ?: w).script(1, it)) } ?: JSONObject.NULL)
            .put("cancels", d.cancels)
            .put("recipients", JSONArray(d.recipients.map { (a, v) -> JSONObject().put("to", a).put("amount", v) }))
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
        val created = if (restored) null else runCatching { rpc.height() }.getOrNull()
        saveCfg {
            it.put("mode", "hot").put("type", "P2WPKH").put("accountKey", Spend.accountKey(s, ScriptType.P2WPKH))
            // Where a new wallet's history starts: the Ark deposit needs no older scan.
            if (created != null) it.put("createdHeight", created) else it.remove("createdHeight")
        }
        secret = s
        ark.unlocked(s)
        saveCfg { it.put("accountKeyTr", Spend.accountKey(s, ScriptType.P2TR)) }
        openWallet(since, restored)
        newSession(ex)
        reply(ex, 200, JSONObject().put("ok", true).apply { if (!restored) put("words", words.joinToString(" ")) })
    }

    /** The address type picked for a plain xpub ("p2wpkh", "p2tr", "p2sh-p2wpkh", "p2pkh"; or the older `taproot` flag). */
    private fun chosenType(b: JSONObject): ScriptType? = when (b.optString("type")) {
        "p2wpkh" -> ScriptType.P2WPKH; "p2tr" -> ScriptType.P2TR; "p2sh-p2wpkh" -> ScriptType.P2SH_P2WPKH; "p2pkh" -> ScriptType.P2PKH
        else -> if (b.optBoolean("taproot")) ScriptType.P2TR else null
    }

    private fun setupWatch(ex: HttpExchange, b: JSONObject) {
        requireNoWallet()
        val key = b.getString("key").trim().replace(Regex("\\s"), "")
        val parsed = runCatching { Bip32.parseExtendedPubKey(key) }.getOrElse { error(it.message ?: "Not an extended public key.") }
        // A ypub/zpub says its addresses; a plain xpub doesn't, so its type is asked (as the app since 1.2.4).
        val t = if (parsed.scriptType != ScriptType.P2PKH) parsed.scriptType
            else chosenType(b) ?: error("A plain xpub doesn't say which addresses it makes: pick the type your wallet uses.")
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
        // Ark runs with the words: it starts (or goes on) once unlocked, and keeps running after a lock.
        if (mode() == "hot") { ark.unlocked(s); runCatching { ensureTaproot(s) } }
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
        val (conf, pending) = runCatching {
            wallets().map { it.balance() }.fold(0L to 0L) { a, x -> (a.first + x.first) to (a.second + x.second) }
        }.getOrElse { return o.put("error", it.message ?: "node error") }
        // One movement per transaction: one that touches both accounts adds up what it did to each.
        val txs = wallets().flatMap { x -> runCatching { x.transactions() }.getOrDefault(emptyList()) }
            .groupBy { it.txid }.values.map { g ->
                NodeWallet.Tx(g[0].txid, g.sumOf { it.net }, g.maxOf { it.confirmations }, g.maxOf { it.time }, g.mapNotNull { it.fee }.maxOrNull())
            }.sortedWith(compareBy({ it.confirmations > 0 }, { if (it.confirmations > 0) it.confirmations.toLong() else -it.time }))
        var left = conf + pending
        val txArr = JSONArray()
        for (t in txs) {
            txArr.put(JSONObject().put("txid", t.txid).put("net", t.net).put("confirmations", t.confirmations)
                .put("time", t.time).put("left", left))
            left -= t.net
        }
        val utxos = wallets().flatMap { it.utxos() }.sortedByDescending { it.value }
        val (ri, ra) = w.receive()
        val locked = coinjoin.lockedOutpoints(); val mixed = coinjoin.mixedScripts()
        o.put("confirmed", conf).put("pending", pending).put("transactions", txArr)
            .put("coins", JSONArray(utxos.map { u ->
                JSONObject().put("outpoint", u.outpoint).put("value", u.value).put("confirmations", u.confirmations)
                    .put("address", walletOf(u).address(u.branch, u.index)).put("change", u.branch == 1)
                    .put("type", if (u.type == ScriptType.P2TR) "p2tr" else "p2wpkh")
                    .put("mixed", isMixed(w, u, mixed)).put("inRound", u.outpoint in locked)
            }))
            .put("receive", JSONObject().put("index", ri).put("address", ra).put("path", "${ri}"))
            .put("taproot", walletTr != null)
            .apply { walletTr?.receive()?.let { (ti, ta) -> put("receiveTr", JSONObject().put("index", ti).put("address", ta)) } }
            .put("height", runCatching { rpc.height() }.getOrDefault(0))
            .put("accountKey", cfg().optString("accountKey"))
            .put("settings", settingsJson())
            .put("contacts", cfg().optJSONArray("contacts") ?: JSONArray())
        market?.let { m -> o.put("price", JSONObject().put("usd", m.optDouble("xbtUsd")).put("eur", m.optDouble("xbtEur"))
            .put("perUsd", m.optJSONObject("fiatPerUsd") ?: JSONObject())) }
        return o
    }

    private fun destinationsJson(): JSONArray = JSONArray(destinations.list().map { d ->
        d.public().put("scanning", destinations.scanning(d))
    })

    companion object {
        const val VERSION = "0.9.1"
        /** How far (per branch) a replaced transaction's coins are looked up in this wallet. */
        const val OURS = 400
    }
}
