package com.kilombino.kilowallet

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

    init {
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
                review(ex, Spend.plan(w, w.utxos(), chosen, resolve(b.getString("to")), amount, b.getDouble("rate")))
            }
            "/api/bump" -> review(ex, Spend.bump(w, b.getString("txid"), b.getDouble("rate"), ours(w)))
            "/api/cpfp" -> review(ex, Spend.cpfp(w, b.getString("txid"), b.getDouble("rate"), w.utxos()))
            "/api/send/confirm" -> {
                val d = drafts[b.getString("draft")] ?: error("This review is no longer open: prepare it again.")
                require(mode() == "hot") { "A watch-only wallet signs elsewhere: export the PSBT." }
                require(Spend.concern(d) == null || b.optBoolean("acceptFee")) { Spend.concern(d)!! }
                val signed = Spend.sign(recheck(b), d)
                val txid = w.broadcast(signed.rawHex)
                d.changeIndex?.let { w.freshChange() }
                drafts.remove(d.id)
                reply(ex, 200, JSONObject().put("txid", txid))
            }
            "/api/psbt/export" -> {
                val d = drafts[b.getString("draft")] ?: error("This review is no longer open: prepare it again.")
                require(Spend.concern(d) == null || b.optBoolean("acceptFee")) { Spend.concern(d)!! }
                saveCfg { it.put("keyOrigin", b.optString("origin")) }
                val psbt = Spend.psbt(w, d, b.optString("origin"))
                reply(ex, 200, JSONObject().put("psbt", Psbt.base64(psbt)))
            }
            "/api/psbt/import" -> {
                val d = drafts[b.getString("draft")] ?: error("This review is no longer open: prepare it again.")
                val returned = runCatching { Psbt.decodeText(b.getString("psbt")) }.getOrElse { error("That is not a PSBT (base64 or hex).") }
                val signed = Spend.finishPsbt(w, d, returned, cfg().optString("keyOrigin"))
                val txid = w.broadcast(signed.rawHex)
                d.changeIndex?.let { w.freshChange() }
                drafts.remove(d.id)
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
                saveCfg { it.remove("accountKey"); it.remove("mode"); it.remove("type") }
                File(dir, "vault.json").delete()
                wallet = null; secret = null; token = null
                reply(ex, 200, ok())
            }
            else -> reply(ex, 404, err("not found"))
        }
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

    private fun review(ex: HttpExchange, d: Spend.Draft) {
        drafts[d.id] = d
        reply(ex, 200, JSONObject().put("draft", d.id).put("to", d.toAddress).put("amount", d.amount).put("fee", d.fee)
            .put("change", d.change).put("inputs", d.inputs.size).put("vbytes", d.vbytes)
            .put("rate", d.fee / d.vbytes).put("concern", Spend.concern(d) ?: JSONObject.NULL)
            .put("replaces", d.replaces ?: JSONObject.NULL).put("replacedFee", d.replacedFee)
            .put("cpfpParent", d.cpfpParent ?: JSONObject.NULL).put("packageRate", d.packageRate))
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
        o.put("confirmed", conf).put("pending", pending).put("transactions", txArr)
            .put("coins", JSONArray(utxos.map { u ->
                JSONObject().put("outpoint", u.outpoint).put("value", u.value).put("confirmations", u.confirmations)
                    .put("address", w.address(u.branch, u.index)).put("change", u.branch == 1)
            }))
            .put("receive", JSONObject().put("index", ri).put("address", ra).put("path", "${ri}"))
            .put("height", runCatching { rpc.height() }.getOrDefault(0))
            .put("accountKey", cfg().optString("accountKey"))
            .put("settings", settingsJson())
            .put("contacts", cfg().optJSONArray("contacts") ?: JSONArray())
        market?.let { m -> o.put("price", JSONObject().put("usd", m.optDouble("xbtUsd")).put("eur", m.optDouble("xbtEur"))) }
        return o
    }

    companion object { const val VERSION = "0.1.0" }
}
