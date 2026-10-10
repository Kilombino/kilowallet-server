package com.kilombino.kilowallet

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/**
 * Ark, as in the app's ARK tab, through the Paperclip Ark server. The engine is the app's own
 * (the Paperclip/bark wallet in Rust), here as its own process, `kilombino-arkd`: the wallet
 * daemon and its REST API on 127.0.0.1 only, behind a random bearer token made at every start.
 *
 * Same words as the BTC wallet (Ark keys at m/350', its deposit at BIP86; the BTC wallet is
 * BIP84), handed to the engine over a pipe, never written to disk. The engine needs them to run,
 * so it starts when the wallet is unlocked and keeps running while the server runs: locking
 * the page does not stop it, it goes on renewing coins. After a restart it waits for an unlock,
 * and says so through a notification while coins are close to expiry.
 *
 * Chain data comes from the node itself over RPC (the bitcoind backend that upstream Paperclip
 * requires on XBT; it needs txindex and a synced node), or, if the node can't, from the Esplora
 * API of mempool.kilombino.com, as the phone does.
 */
class ArkEngine(
    private val dataDir: File,
    private val rpcUrl: String?,
    private val rpcUser: String?,
    private val rpcPass: String?,
    private val rpcCookie: String?,
    private val events: Coinjoin,
    private val nodeTip: () -> Int?,
) {
    companion object {
        const val SERVER = "https://ark.paperclippool.xyz"
        const val ESPLORA = "https://mempool.kilombino.com/api"
        // Limits advertised by the Paperclip Ark server (GetArkInfo, Oct 2026); only for text.
        const val VTXO_LIFETIME_BLOCKS = 4320
        const val MIN_BOARD_SAT = 20_000L
        const val BOARD_CONFIRMATIONS = 3
        const val MAX_VTXO_SAT = 1_000_000L
        const val MAX_LIGHTNING_SAT = 250_000L
        const val RESERVE_SAT = 2_000L
        const val MIN_OUTPUT_SAT = 1_330L
        /** Paperclip Ark opened in late September 2026: a restored wallet's deposit can't be older. */
        const val ARK_EPOCH_HEIGHT = 973_000
        /** Under about a week left, ask for a renewal. */
        const val EXPIRY_WARN_BLOCKS = 1008
    }

    val dir = File(dataDir, "ark")
    private val stateFile = File(dataDir, "ark-state.json")
    private val bin = System.getenv("KILOWALLET_ARKD") ?: "/opt/kilowallet/kilombino-arkd"

    @Volatile private var proc: Process? = null
    @Volatile private var port = 0
    @Volatile private var token: String? = null
    /** The words the engine runs with, to start it again after a crash or a node restart. */
    @Volatile private var secret: Vault.Secret? = null
    @Volatile var lastError: String? = null
        private set
    @Volatile var activating = false
        private set
    @Volatile private var cookieSeen: String? = null
    @Volatile private var failures = 0
    @Volatile private var nextTry = 0L
    private val timer = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "ark").apply { isDaemon = true } }

    class ArkError(val status: Int, message: String) : Exception(message)

    // ------------------------------------------------------------------ state (no secrets)

    @Synchronized fun state(): JSONObject = if (stateFile.exists()) runCatching { JSONObject(stateFile.readText()) }.getOrDefault(JSONObject()) else JSONObject()
    @Synchronized private fun saveState(f: (JSONObject) -> Unit) {
        val o = state(); f(o)
        val tmp = File(dataDir, "ark-state.json.tmp"); tmp.writeText(o.toString(2)); tmp.renameTo(stateFile)
    }

    /** Ark was activated on this server (the engine has a wallet in [dir]). */
    val enabled: Boolean get() = state().optBoolean("enabled", false)
    val chain: String get() = state().optString("chain", "node")
    val running: Boolean get() = proc?.isAlive == true && token != null
    val hasWords: Boolean get() = secret != null

    // ------------------------------------------------------------------ the node as chain source

    /** Why the node can't be the engine's chain source, or null when it can. */
    fun nodeProblem(rpc: Rpc): String? = runCatching {
        if (rpcUrl == null) return@runCatching "No node RPC is configured."
        val chain = rpc.call("getblockchaininfo") as JSONObject
        if (chain.optBoolean("initialblockdownload", true)) return@runCatching "The node is still syncing (initial block download). Ark needs a node that is up to date."
        if (chain.optBoolean("pruned")) return@runCatching "The node is pruned. Ark needs a full node with txindex."
        val idx = rpc.call("getindexinfo") as JSONObject
        val tx = idx.optJSONObject("txindex")
        if (tx == null) "The node has no transaction index. Turn on txindex in the node's settings (it takes a while to build), or use mempool.kilombino.com."
        else if (!tx.optBoolean("synced")) "The node is still building its transaction index (txindex)."
        else null
    }.getOrElse { "The node did not answer: ${it.message}" }

    private fun cookieNow(): String? = rpcCookie?.let { runCatching { File(it).readText().trim() }.getOrNull() }

    /** Owner-only: the folder holds the wallet's database (coins, keys' metadata) and its log. */
    private fun harden() {
        runCatching {
            dir.mkdirs()
            java.nio.file.Files.setPosixFilePermissions(dir.toPath(), java.nio.file.attribute.PosixFilePermissions.fromString("rwx------"))
            dir.listFiles()?.filter { it.isFile }?.forEach {
                java.nio.file.Files.setPosixFilePermissions(it.toPath(), java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"))
            }
        }
        // The engine's log only grows: keep the last one aside past 20 MB.
        val log = File(dir, "debug.log")
        if (log.length() > 20_000_000) { File(dir, "debug.log.1").delete(); log.renameTo(File(dir, "debug.log.1")) }
    }

    /** The engine's config.toml: the servers always come from here, never from the file on disk. */
    private fun writeConfig() {
        harden()
        val f = File(dir, "config.toml")
        val keep = if (f.exists()) f.readLines().filterNot { l ->
            val k = l.trimStart()
            k.startsWith("server_address") || k.startsWith("esplora_address") || k.startsWith("bitcoind")
        } else emptyList()
        val out = ArrayList<String>()
        out += "server_address = \"$SERVER\""
        if (chain == "esplora" || rpcUrl == null) out += "esplora_address = \"$ESPLORA\""
        else {
            out += "bitcoind_address = \"${rpcUrl.trimEnd('/')}\""
            if (rpcCookie != null) out += "bitcoind_cookiefile = \"$rpcCookie\""
            else { out += "bitcoind_user = \"${rpcUser ?: ""}\""; out += "bitcoind_pass = \"${rpcPass ?: ""}\"" }
        }
        val tmp = File(dir, "config.toml.tmp")
        tmp.delete(); tmp.createNewFile()
        java.nio.file.Files.setPosixFilePermissions(tmp.toPath(), java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"))
        tmp.writeText((out + keep.filter { it.isNotBlank() }).joinToString("\n") + "\n")
        tmp.renameTo(f)
    }

    // ------------------------------------------------------------------ the process

    /**
     * Starts the engine with [s]'s words (null words: the API only, to create the wallet).
     * Blocking, up to a couple of minutes: the engine checks the chain source and the server.
     */
    @Synchronized
    private fun launch(s: Vault.Secret, withWords: Boolean) {
        stopProcess()
        // Before the wallet exists the engine must find no config.toml: creating it writes its own.
        if (withWords) writeConfig() else harden()
        var last = "could not start the Ark engine"
        repeat(5) {
            val p = Random.nextInt(20_000, 60_000)
            val pb = ProcessBuilder(bin, "--datadir", dir.absolutePath, "--port", p.toString())
                .redirectError(ProcessBuilder.Redirect.appendTo(File(dataDir, "ark-engine.err")))
            // The wallet's own debug lines stay; the RPC clients' per-request lines (thousands
            // while the deposit is scanned) do not.
            pb.environment()["BARK_LOG"] = "debug,bitcoincore_rpc=info,bitcoind_async_client=info"
            val pr = pb.start()
            // Words and passphrase on stdin; stdin stays open: closing it stops the engine.
            pr.outputStream.write(((if (withWords) s.words.joinToString(" ") else "") + "\n" + (if (withWords) s.passphrase else "") + "\n").toByteArray())
            pr.outputStream.flush()
            val reader = pr.inputStream.bufferedReader()
            val line = java.util.concurrent.CompletableFuture.supplyAsync { runCatching { reader.readLine() }.getOrNull() }
                .get(180, TimeUnit.SECONDS) ?: ""
            if (line.startsWith("TOKEN ")) {
                proc = pr; port = p; token = line.removePrefix("TOKEN ").trim()
                cookieSeen = cookieNow()
                // Keep draining stdout so the engine never blocks on a full pipe.
                Thread { runCatching { reader.forEachLine { } } }.apply { isDaemon = true }.start()
                return
            }
            runCatching { pr.waitFor(5, TimeUnit.SECONDS) }; pr.destroy()
            last = line.removePrefix("ERR ").ifBlank { "the Ark engine exited (exit ${runCatching { pr.exitValue() }.getOrNull()})" }
            if (!last.contains("bind", ignoreCase = true) && !last.contains("address in use", ignoreCase = true)) throw IllegalStateException(last)
        }
        throw IllegalStateException(last)
    }

    @Synchronized
    private fun stopProcess() {
        val p = proc ?: return
        token = null; proc = null
        // Closing stdin asks for a clean shutdown; SIGTERM after a while, SIGKILL last.
        runCatching { p.outputStream.close() }
        if (!p.waitFor(20, TimeUnit.SECONDS)) { p.destroy(); if (!p.waitFor(10, TimeUnit.SECONDS)) p.destroyForcibly() }
    }

    fun shutdown() { secret = null; stopProcess() }

    /** The wallet was unlocked: start the engine if Ark is on (in the background). */
    fun unlocked(s: Vault.Secret) {
        secret = s
        if (!enabled || running) return
        failures = 0; nextTry = 0
        timer.execute { supervise() }
    }

    /** The supervisor: keeps the engine up while Ark is on and the words are known; watches it. */
    fun startTimers() {
        timer.scheduleWithFixedDelay({ runCatching { supervise() } }, 20, 30, TimeUnit.SECONDS)
        timer.scheduleWithFixedDelay({ runCatching { watch() } }, 60, 60, TimeUnit.SECONDS)
    }

    @Synchronized
    private fun supervise() {
        val s = secret ?: return
        if (!enabled || activating) return
        // The node rewrites its cookie when it restarts; the engine read the old one.
        if (running && chain == "node" && rpcCookie != null && cookieNow() != null && cookieNow() != cookieSeen) {
            System.err.println("Ark: the node's RPC cookie changed, restarting the engine"); stopProcess()
        }
        if (running) { failures = 0; return }
        if (System.currentTimeMillis() < nextTry) return
        try {
            launch(s, withWords = true)
            lastError = null; failures = 0
            System.err.println("Ark engine running on 127.0.0.1:$port")
        } catch (e: Exception) {
            lastError = e.message ?: e.toString()
            failures++
            nextTry = System.currentTimeMillis() + minOf(30L * 60_000, 30_000L shl minOf(failures, 6))
            System.err.println("Ark engine failed to start: $lastError")
        }
    }

    /**
     * Turns Ark on with the wallet's own words: creates the engine's wallet (words that already
     * held Ark coins get them back from the server's recovery mailbox), then runs it. [birthday]
     * is where the node starts looking for the deposit's coins (bitcoind backend only).
     */
    fun activate(s: Vault.Secret, useNode: Boolean, birthday: Int) {
        synchronized(this) {
            require(!activating) { "Ark is already being activated." }
            require(!enabled) { "Ark is already active." }
            activating = true
        }
        saveState { it.put("chain", if (useNode) "node" else "esplora") }
        secret = s
        try {
            // Whatever an earlier try left: a wallet database is set aside (it might hold coins),
            // anything else goes.
            if (File(dir, "db.sqlite").exists()) dir.renameTo(File(dataDir, "ark.removed-" + System.currentTimeMillis()))
            else dir.listFiles()?.forEach { f -> if (f.name != "LOCK" && f.name != "barkd.lock") f.deleteRecursively() }
            launch(s, withWords = false)
            val req = JSONObject()
                .put("ark_server", SERVER)
                .put("chain_source", if (useNode && rpcUrl != null) JSONObject().put("bitcoind", JSONObject()
                    .put("bitcoind", rpcUrl.trimEnd('/'))
                    .put("bitcoind_auth", if (rpcCookie != null) JSONObject().put("cookie", JSONObject().put("cookie", rpcCookie))
                        else JSONObject().put("user-pass", JSONObject().put("user", rpcUser ?: "").put("pass", rpcPass ?: ""))))
                    else JSONObject().put("esplora", JSONObject().put("url", ESPLORA)))
                .put("network", "mainnet")
                .put("mnemonic", s.words.joinToString(" "))
                .put("birthday_height", birthday)
            if (s.passphrase.isNotEmpty()) req.put("passphrase", s.passphrase)
            call("POST", "/wallet/create", req, timeoutMs = 3_600_000)
            saveState { it.put("enabled", true).put("activatedAt", System.currentTimeMillis()).remove("seen") }
            // From now on the engine runs with the words (they were only in the request so far).
            launch(s, withWords = true)
            lastError = null
            events.emit("Ark activated", "Your Ark wallet is ready, with the same words as this wallet.", null)
        } catch (e: Exception) {
            stopProcess()
            lastError = e.message
            throw e
        } finally {
            activating = false
        }
    }

    /** Ark off: the engine stops; its folder is kept aside (never deleted: it may hold coins). */
    @Synchronized
    fun forget() {
        stopProcess()
        if (dir.exists()) dir.renameTo(File(dataDir, "ark.removed-" + System.currentTimeMillis()))
        saveState { it.remove("enabled"); it.remove("seen"); it.remove("server_rejected") }
    }

    // ------------------------------------------------------------------ HTTP to the engine

    /** The engine words amounts as "0.00009000 BTC"; the wallet speaks in sats. */
    private fun inSats(msg: String): String {
        val withSats = Regex("(\\d+\\.\\d{8}) BTC").replace(msg) { m ->
            val sats = m.groupValues[1].replace(".", "").trimStart('0').ifEmpty { "0" }.toLong()
            "%,d sats".format(java.util.Locale.US, sats).replace(',', ' ')
        }
        return withSats.trimEnd().let { if (it.endsWith(".")) it else "$it." }
    }

    fun call(method: String, path: String, body: JSONObject? = null, timeoutMs: Int = 60_000): String {
        val t = token ?: throw IllegalStateException(
            if (secret == null) "Unlock the wallet: the Ark engine needs its words to run." else "The Ark engine is not running" + (lastError?.let { ": $it" } ?: "."))
        val conn = (URL("http://127.0.0.1:$port/api/v1$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 5_000
            readTimeout = timeoutMs
            setRequestProperty("Authorization", "Bearer $t")
            setRequestProperty("Accept", "application/json")
            if (body != null || method == "POST") { doOutput = true; setRequestProperty("Content-Type", "application/json") }
        }
        try {
            if (conn.doOutput) conn.outputStream.use { it.write((body ?: JSONObject()).toString().toByteArray()) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) {
                val msg = runCatching { JSONObject(text).optString("message", text) }.getOrDefault(text)
                throw ArkError(code, inSats(msg).ifBlank { "HTTP $code" })
            }
            return text
        } finally { conn.disconnect() }
    }

    // ------------------------------------------------------------------ wallet

    data class Balance(
        val spendable: Long, val pendingBoard: Long, val pendingRound: Long, val needsRefresh: Long,
        val pendingExit: Long, val onchainConfirmed: Long, val onchainPending: Long,
        val lightningPending: Long = 0, val refused: Long = 0,
    ) {
        val arkTotal: Long get() = spendable + pendingBoard + pendingRound
    }

    fun balance(): Balance {
        val a = JSONObject(call("GET", "/wallet/balance"))
        val o = runCatching { JSONObject(call("GET", "/onchain/balance")) }.getOrNull()
        val b = Balance(
            spendable = a.optLong("spendable_sat"), pendingBoard = a.optLong("pending_board_sat"),
            pendingRound = a.optLong("pending_in_round_sat"), needsRefresh = a.optLong("needs_refresh_sat"),
            pendingExit = a.optLong("pending_exit_sat"),
            onchainConfirmed = o?.optLong("confirmed_sat") ?: 0,
            onchainPending = (o?.optLong("trusted_pending_sat") ?: 0) + (o?.optLong("untrusted_pending_sat") ?: 0),
            lightningPending = a.optLong("claimable_lightning_receive_sat") + a.optLong("pending_lightning_send_sat"),
        )
        // Coins the server refused as already spent (an old backup restored) never count again.
        val bad = rejected()
        if (bad.isEmpty()) return b
        val sum = runCatching { arkCoins().filter { it.id in bad }.sumOf { it.amount } }.getOrDefault(0L)
        return b.copy(spendable = (b.spendable - sum).coerceAtLeast(0), refused = sum)
    }

    fun arkAddress(): String = JSONObject(call("POST", "/wallet/addresses/next")).getString("address")
    fun onchainAddress(): String = JSONObject(call("POST", "/onchain/addresses/next")).getString("address")

    fun board(sats: Long?, feeRate: Double?) {
        val req = JSONObject()
        if (sats != null) req.put("amount_sat", sats)
        if (feeRate != null) req.put("fee_rate_sat_per_vb", feeRate)
        call("POST", if (sats == null) "/boards/board-all" else "/boards/board-amount", req, 180_000)
    }

    data class FeeRates(val fast: Long, val regular: Long, val slow: Long)
    fun onchainFeeRates(): FeeRates? = runCatching {
        val r = JSONObject(call("GET", "/fees/onchain"))
        FeeRates(r.optLong("fast_sat_per_vb"), r.optLong("regular_sat_per_vb"), r.optLong("slow_sat_per_vb"))
    }.getOrNull()

    fun estimateBoardNetworkFee(rate: Double, all: Boolean): Long {
        val inputs = runCatching { JSONArray(call("GET", "/onchain/utxos")).length() }.getOrDefault(1).coerceAtLeast(1)
        val vbytes = 10.5 + 57.5 * inputs + 43.0 * (if (all) 1 else 2)
        return kotlin.math.ceil(vbytes * rate).toLong()
    }

    data class Estimate(val amount: Long, val fee: Long, val total: Long, val exact: Boolean, val note: String, val problem: String? = null) {
        fun json(): JSONObject = JSONObject().put("amount", amount).put("fee", fee).put("total", total).put("exact", exact)
            .put("note", note).put("problem", problem ?: JSONObject.NULL)
    }

    /** Sats in a BOLT11 invoice's human-readable part (lnbc2500u…), or null. */
    fun invoiceSats(invoice: String): Long? {
        val m = Regex("^ln(?:bc|tb|bcrt)(\\d+)([munp]?)1", RegexOption.IGNORE_CASE).find(invoice.trim()) ?: return null
        val n = m.groupValues[1].toLongOrNull() ?: return null
        return when (m.groupValues[2].lowercase()) {
            "" -> n * 100_000_000; "m" -> n * 100_000; "u" -> n * 100; "n" -> n / 10; "p" -> n / 10_000; else -> null
        }
    }

    private fun feeQuery(path: String): Estimate? = runCatching {
        val r = JSONObject(call("GET", path))
        Estimate(r.optLong("net_amount_sat"), r.optLong("fee_sat"), r.optLong("gross_amount_sat"), true, "")
    }.getOrNull()

    fun estimateSend(destination: String, sats: Long?): Estimate? {
        val d = destination.trim()
        return when {
            d.startsWith("lno", ignoreCase = true) && sats == null ->
                Estimate(0, 0, 0, false, "", "This is a reusable BOLT12 offer: enter the amount to pay.")
            d.startsWith("ln", ignoreCase = true) -> {
                val amt = sats ?: invoiceSats(d) ?: return null
                feeQuery("/fees/lightning/pay?amount_sat=$amt")?.let {
                    it.copy(note = "Lightning: the server's fee plus the recovery reserve of the transfer. If the " +
                        "payment fails, the amount comes back but the recovery reserve is NOT refunded, so " +
                        "each failed attempt costs about ${maxOf(it.fee, 0)} sats.")
                }
            }
            d.startsWith("ark1", ignoreCase = true) -> estimateArkPayment(d, sats ?: return Estimate(0, 0, 0, false, "", "Enter the amount to pay."), null)
            else -> {
                val addr = java.net.URLEncoder.encode(d, "UTF-8")
                if (sats == null) feeQuery("/fees/offboard-all?address=$addr")?.let {
                    Estimate(it.amount, it.fee, it.total, true, "Everything in Ark leaves to this address in the next round, minus the on-chain fee.")
                } else feeQuery("/fees/send-onchain?amount_sat=$sats&address=$addr")?.copy(note = "Leaves Ark through the next round and pays the on-chain fee.")
            }
        }
    }

    private fun ids(a: List<String>) = JSONArray().apply { a.forEach { put(it) } }

    private fun estimateArkPayment(dest: String, amt: Long, coins: List<String>?): Estimate = try {
        val req = JSONObject().put("destination", dest).put("amount_sat", amt)
        if (coins != null) req.put("vtxos", ids(coins))
        val r = JSONObject(call("POST", "/fees/ark/send", req))
        val n = r.optInt("input_count", 1)
        Estimate(r.optLong("recipient_amount_sat"), r.optLong("recovery_reserve_sat") + r.optLong("service_fee_sat"),
            r.optLong("total_debit_sat"), true,
            "Recovery reserve pre-paid for the emergency exit of " + (if (n == 1) "the coin used" else "each of the $n coins used") +
                "; not refunded." + (if (n > 1) " RENEW first joins your coins into one and makes payments cheaper." else ""))
    } catch (e: ArkError) {
        Estimate(amt, 0, amt, false, "", (e.message ?: "The engine refused this payment.") + if (coins == null) arkPaymentHint() else "")
    }

    fun estimateArkCoins(dest: String, sats: Long, coins: List<String>) = estimateArkPayment(dest.trim(), sats, coins)

    private fun arkPaymentHint(): String = runCatching {
        val arr = JSONArray(call("GET", "/wallet/vtxos"))
        val biggest = (0 until arr.length()).map { arr.getJSONObject(it) }
            .filter { it.optJSONObject("state")?.optString("type") == "spendable" }
            .maxOfOrNull { it.optLong("amount_sat") } ?: 0L
        val maxOne = biggest - 3 * RESERVE_SAT - MIN_OUTPUT_SAT
        if (maxOne >= MIN_OUTPUT_SAT) " The most you can pay from one coin is $maxOne sats: tick Choose coins and pick that coin, or RENEW to join your coins into one."
        else " To empty Ark, send to an XBT address (on-chain) instead."
    }.getOrDefault("")

    /** Pays an Ark address, a Lightning invoice / offer, an XBT address or a BIP-321 URI; [maxTotal] caps the debit. */
    fun send(destination: String, sats: Long?, maxTotal: Long?): String {
        val d = destination.trim()
        val req = JSONObject().put("destination", d)
        if (sats != null) req.put("amount_sat", sats)
        if (maxTotal != null && d.startsWith("ark1", ignoreCase = true)) req.put("max_total_sat", maxTotal)
        // The engine caps only Ark payments itself: for the rest, ask for the cost again now.
        if (maxTotal != null && !d.startsWith("ark1", ignoreCase = true)) {
            val now = estimateSend(d, sats) ?: error("Could not confirm the cost right before paying; nothing was sent.")
            require(now.total <= maxTotal + maxOf(20L, maxTotal / 100)) {
                "The cost went up since you reviewed it (${now.total} sats instead of at most $maxTotal); nothing was sent."
            }
        }
        if (!d.startsWith("ark1", ignoreCase = true) && !d.startsWith("ln", ignoreCase = true)) {
            return if (sats == null) {
                call("POST", "/wallet/offboard/all", JSONObject().put("address", d), 180_000)
                "Withdrawal requested: everything leaves Ark in the next round."
            } else {
                call("POST", "/wallet/send-onchain", JSONObject().put("destination", d).put("amount_sat", sats), 180_000)
                "Withdrawal requested: it leaves Ark in the next round."
            }
        }
        val r = JSONObject(call("POST", "/wallet/send", req, 180_000))
        val hash = r.optString("payment_hash").takeIf { it.length == 64 }
        // "Payment sent successfully" comes as soon as a Lightning payment STARTS: wait for its outcome.
        if (hash == null || !d.startsWith("ln", ignoreCase = true)) return r.optString("message")
        return lightningOutcome(hash)
    }

    fun lightningOutcome(hash: String, waitMs: Long = 90_000): String {
        val deadline = System.currentTimeMillis() + waitMs
        while (System.currentTimeMillis() < deadline) {
            val m = history().firstOrNull { it.paymentHash == hash }
            when (m?.status) {
                "successful" -> return "Lightning payment completed."
                "failed", "canceled", "cancelled" -> return "Error: the Lightning payment failed. The coins came back to " +
                    "Ark, but the recovery reserve it pre-paid (${kotlin.math.abs(m.amount)} sats) is not refunded."
            }
            Thread.sleep(3_000)
        }
        return "The Lightning payment is still in progress. Its result will show in Ark activity."
    }

    fun sendArkCoins(dest: String, sats: Long, maxTotal: Long, coins: List<String>): String {
        val req = JSONObject().put("destination", dest.trim()).put("amount_sat", sats).put("max_total_sat", maxTotal).put("vtxos", ids(coins))
        return JSONObject(call("POST", "/wallet/send", req, 180_000)).optString("message")
    }

    // ------------------------------------------------------------------ deposit (on-chain)

    data class DepositTx(val txid: String, val change: Long, val fee: Long?, val height: Int?)

    fun depositTxs(): List<DepositTx> = runCatching {
        val arr = JSONArray(call("GET", "/onchain/transactions"))
        (0 until arr.length()).map { arr.getJSONObject(it) }.map { t ->
            DepositTx(t.getString("txid"), t.optLong("balance_change_sat"),
                t.optLong("onchain_fee_sat", -1).takeIf { it >= 0 }, t.optJSONObject("confirmation")?.optInt("height"))
        }.reversed()
    }.getOrDefault(emptyList())

    fun estimateDepositSend(dest: String, sats: Long?): Estimate? = runCatching {
        val d = dest.trim()
        if (d.startsWith("ark1", ignoreCase = true) || d.startsWith("ln", ignoreCase = true))
            return@runCatching Estimate(0, 0, 0, false, "", "From the deposit you can only send to an XBT address. Choose ARK to pay an Ark address or Lightning.")
        val available = balance().onchainConfirmed
        val rate = JSONObject(call("GET", "/fees/onchain")).let { r ->
            listOf("regular_sat_per_vb", "slow_sat_per_vb", "fast_sat_per_vb").firstNotNullOfOrNull { k -> r.optDouble(k).takeIf { !it.isNaN() && it > 0 } } ?: 1.0
        }.coerceAtLeast(1.0)
        val inputs = runCatching { JSONArray(call("GET", "/onchain/utxos")).length() }.getOrDefault(1).coerceAtLeast(1)
        val fee = kotlin.math.ceil(rate * (11 + 58 * inputs + 43 * (if (sats == null) 1 else 2))).toLong()
        val amount = sats ?: (available - fee)
        val problem = when {
            amount < 330 -> "Not enough confirmed in the deposit to send."
            sats != null && sats + fee > available -> "The deposit has $available sats confirmed; this needs ${sats + fee} with the fee."
            else -> null
        }
        Estimate(amount, fee, amount + fee, false, "Plain on-chain XBT from your deposit: only the network fee (about " +
            String.format(java.util.Locale.US, "%.1f", rate) + " sat/vB), no Ark reserves.", problem)
    }.getOrNull()

    fun sendFromDeposit(dest: String, sats: Long?): String {
        val d = dest.trim()
        val r = if (sats == null) JSONObject(call("POST", "/onchain/drain", JSONObject().put("destination", d), 120_000))
            else JSONObject(call("POST", "/onchain/send", JSONObject().put("destination", d).put("amount_sat", sats), 120_000))
        return "Sent from the deposit: " + r.optString("txid").take(16) + "…"
    }

    // ------------------------------------------------------------------ coin control

    data class Coin(val id: String, val amount: Long, val note: String)

    fun depositCoins(): List<Coin> = runCatching {
        val arr = JSONArray(call("GET", "/onchain/utxos"))
        (0 until arr.length()).map { arr.getJSONObject(it) }.map { u ->
            val h = u.optInt("confirmation_height", -1)
            Coin(u.getString("outpoint"), u.optLong("amount_sat"), if (h > 0) "block $h" else "unconfirmed")
        }.sortedByDescending { it.amount }
    }.getOrDefault(emptyList())

    fun arkCoins(): List<Coin> = runCatching {
        val tip = tip() ?: -1
        val arr = JSONArray(call("GET", "/wallet/vtxos"))
        (0 until arr.length()).map { arr.getJSONObject(it) }
            .filter { it.optJSONObject("state")?.optString("type") == "spendable" }
            .map { v ->
                val left = v.optInt("expiry_height") - tip
                Coin(v.getString("id"), v.optLong("amount_sat"),
                    if (tip > 0) "expires in $left blocks (≈ ${String.format(java.util.Locale.US, "%.1f", left * 10 / 1440.0)} d)" else "")
            }.sortedByDescending { it.amount }
    }.getOrDefault(emptyList())

    fun estimateDepositCoins(dest: String, sats: Long?, coins: List<String>): Estimate? = runCatching {
        val req = JSONObject().put("destination", dest.trim()).put("outpoints", ids(coins))
        if (sats != null) req.put("amount_sat", sats)
        val r = JSONObject(call("POST", "/onchain/send-selected/estimate", req))
        val amount = r.optLong("amount_sat"); val fee = r.optLong("fee_sat"); val change = r.optLong("change_sat")
        Estimate(amount, fee, amount + fee, true, "From ${coins.size} chosen coin" + (if (coins.size == 1) "" else "s") +
            "; network fee only" + (if (change > 0) "; $change sats of change back to the deposit." else "."))
    }.getOrElse { e -> if (e is ArkError) Estimate(0, 0, 0, false, "", e.message) else null }

    fun sendDepositCoins(dest: String, sats: Long?, coins: List<String>): String {
        val req = JSONObject().put("destination", dest.trim()).put("outpoints", ids(coins))
        if (sats != null) req.put("amount_sat", sats)
        val r = JSONObject(call("POST", "/onchain/send-selected", req, 120_000))
        return "Sent from the chosen coins: " + r.optString("txid").take(16) + "…"
    }

    fun estimateWithdrawCoins(dest: String, coins: List<String>): Estimate? = runCatching {
        val r = JSONObject(call("POST", "/fees/offboard", JSONObject().put("address", dest.trim()).put("vtxos", ids(coins))))
        Estimate(r.optLong("net_amount_sat"), r.optLong("fee_sat"), r.optLong("gross_amount_sat"), true,
            "${coins.size} chosen Ark coin" + (if (coins.size == 1) "" else "s") + " leave Ark whole in the next round.")
    }.getOrElse { e -> if (e is ArkError) Estimate(0, 0, 0, false, "", e.message) else null }

    fun withdrawCoins(dest: String, coins: List<String>): String {
        call("POST", "/wallet/offboard/vtxos", JSONObject().put("address", dest.trim()).put("vtxos", ids(coins)), 180_000)
        return "Withdrawal requested: the chosen coins leave Ark in the next round."
    }

    // ------------------------------------------------------------------ renewal

    fun estimateRenew(): Estimate? = runCatching {
        val r = JSONObject(call("GET", "/fees/refresh-all"))
        val coins = r.optJSONArray("vtxos_spent")?.length() ?: 0
        Estimate(r.optLong("net_amount_sat"), r.optLong("fee_sat"), r.optLong("gross_amount_sat"), true,
            "$coins coin" + (if (coins == 1) "" else "s") + " renewed into one")
    }.getOrElse { e ->
        if (e !is ArkError) null
        else Estimate(0, 0, 0, false, "", if (e.message.orEmpty().contains("No VTXOs")) "You have no Ark coins to renew." else e.message)
    }

    fun estimateRenewCoins(coins: List<String>): Estimate? = runCatching {
        val r = JSONObject(call("POST", "/fees/refresh", JSONObject().put("vtxos", ids(coins))))
        Estimate(r.optLong("net_amount_sat"), r.optLong("fee_sat"), r.optLong("gross_amount_sat"), true,
            "${coins.size} coin" + (if (coins.size == 1) "" else "s") + " renewed into one")
    }.getOrElse { e -> if (e is ArkError) Estimate(0, 0, 0, false, "", e.message) else null }

    private fun renewCoins(coins: List<String>) { call("POST", "/wallet/refresh/vtxos", JSONObject().put("vtxos", ids(coins)), 180_000) }

    fun rejected(): Set<String> = state().optJSONArray("server_rejected")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } ?: emptySet()
    private fun setRejected(ids: Set<String>) = saveState { it.put("server_rejected", JSONArray(ids.toList())) }

    /** The coins the engine's log says the server refused ("unusable inputs: [id, id]") after [sinceMs]. */
    private fun rejectedSince(sinceMs: Long): Set<String> {
        val log = engineLogTail(200_000) ?: return emptySet()
        val iso = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
        val out = HashSet<String>()
        for (line in log.lines()) {
            val i = line.indexOf("unusable inputs: [")
            if (i < 0) continue
            val at = runCatching { iso.parse(line.substring(1, 20))!!.time }.getOrNull() ?: continue
            if (at + 1000 < sinceMs) continue
            line.substring(i + 18).substringBefore(']').split(',').map { it.trim() }.filter { it.contains(':') }.forEach { out += it }
        }
        return out
    }

    private fun awaitRenewal(known: Set<String>, timeoutMs: Long = 240_000): String? {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            Thread.sleep(5_000)
            val m = history().firstOrNull { it.kind == "renewal" && it.id !in known } ?: continue
            if (m.status != "pending") return m.status
        }
        return null
    }

    /** Renews [coins]; coins the server refuses are set aside (remembered) and the rest renewed. */
    fun renewSkippingRejected(coins: List<String>): String {
        var todo = coins.filter { it !in rejected() }.ifEmpty { coins }
        val refused = LinkedHashSet<String>()
        repeat(3) {
            val known = history().filter { it.kind == "renewal" }.map { it.id }.toSet()
            val start = System.currentTimeMillis()
            renewCoins(todo)
            when (awaitRenewal(known)) {
                "successful" -> return "Renewed ${todo.size} coin(s)." +
                    (if (refused.isNotEmpty()) " The server says ${refused.size} other coin(s) were already spent earlier (an older wallet state); they no longer count in your balance." else "")
                null -> return "Renewal requested; it completes in a coming round."
                else -> {
                    val bad = rejectedSince(start).filter { it in todo }
                    if (bad.isEmpty()) error("The renewal round failed. The engine log (below) says why.")
                    refused += bad; setRejected(rejected() + bad)
                    todo = todo - bad.toSet()
                    if (todo.isEmpty()) error("The server says every chosen coin was already spent earlier (an older wallet state); they no longer count in your balance.")
                }
            }
        }
        error("The renewal kept failing. The engine log (below) says why.")
    }

    // ------------------------------------------------------------------ Lightning receive

    fun estimateLightningReceive(sats: Long): Estimate? = feeQuery("/fees/lightning/receive?amount_sat=$sats")?.copy(
        note = "The server's receive fee plus the recovery reserve are taken from what arrives.")

    fun lightningInvoice(sats: Long): String {
        val net = estimateLightningReceive(sats)?.amount
        // An invoice whose payment could never be claimed (too little left) is refused here.
        require(net == null || net >= MIN_OUTPUT_SAT) {
            "An invoice of $sats sats leaves you ${net ?: 0} after the receive cost, below the $MIN_OUTPUT_SAT-sat minimum, so the payment would fail. Ask for at least about 5 500 sats."
        }
        require(sats <= MAX_LIGHTNING_SAT) { "Lightning: up to $MAX_LIGHTNING_SAT sats per payment." }
        val r = JSONObject(call("POST", "/lightning/receives/invoice", JSONObject().put("amount_sat", sats), 120_000))
        return r.optString("invoice", r.toString())
    }

    fun lightningReceiveState(invoice: String): String? = runCatching {
        JSONObject(call("GET", "/lightning/receives/" + java.net.URLEncoder.encode(invoice, "UTF-8"))).optString("state").ifBlank { null }
    }.getOrNull()

    fun reusableOffer(description: String, sats: Long?): String {
        runCatching { JSONObject(call("GET", "/lightning/offers")) }.getOrNull()
            ?.takeIf { it.optBoolean("active") && it.optString("offer").isNotEmpty() }
            ?.let { if (sats == null || it.optLong("amount_sat") == sats) return it.getString("offer") }
        val req = JSONObject().put("description", description)
        if (sats != null) req.put("amount_sat", sats)
        return JSONObject(call("POST", "/lightning/offers", req, 60_000)).getString("offer")
    }

    fun disableOffer() { call("DELETE", "/lightning/offers") }

    // ------------------------------------------------------------------ emergency exit

    data class ExitState(val vtxo: String, val type: String, val claimableHeight: Int?, val tip: Int?)

    fun exits(): List<ExitState> = runCatching {
        val arr = JSONArray(call("GET", "/exits/status/all"))
        (0 until arr.length()).map { arr.getJSONObject(it) }.map { e ->
            val st = e.optJSONObject("state") ?: JSONObject()
            ExitState(e.optString("vtxo_id"), st.optString("type"), st.optInt("claimable_height").takeIf { it > 0 }, st.optInt("tip_height").takeIf { it > 0 })
        }
    }.getOrDefault(emptyList())

    private fun satsOf(o: JSONObject, k: String): Long =
        o.opt(k).let { v -> if (v is Number && v.toString().contains('.')) Math.round(v.toDouble() * 1e8) else (v as? Number)?.toLong() ?: 0L }

    fun estimateExit(): Estimate? = runCatching {
        val b = balance()
        if (b.spendable == 0L) return@runCatching Estimate(0, 0, 0, false, "", "You have no Ark coins to exit.")
        val r = JSONObject(call("GET", "/exits/fee"))
        val total = satsOf(r, "total_fee"); val broadcast = satsOf(r, "exit_broadcast_fee"); val deposit = b.onchainConfirmed
        Estimate(b.spendable - total, total, b.spendable, false,
            "broadcast $broadcast sats for " + r.optInt("txs_to_broadcast") + " transactions + claim " + satsOf(r, "claim_fee") + " sats",
            if (broadcast > deposit) "Broadcasting needs $broadcast sats confirmed in your on-chain deposit and it has $deposit. Send that much to your DEPOSIT address first." else null)
    }.getOrElse { e -> if (e is ArkError) Estimate(0, 0, 0, false, "", e.message) else null }

    fun startExitAll(): String = JSONObject(call("POST", "/exits/start/all", JSONObject(), 120_000)).optString("message", "Exit started.")

    fun claimExits(dest: String): String {
        call("POST", "/exits/claim/all", JSONObject().put("destination", dest.trim()), 120_000)
        return "Claimed: the recovered XBT is on its way to the address."
    }

    /** Exits that can no longer finish: the coin expired 144+ blocks ago and the server swept it. */
    fun lostExits(): Set<String> = runCatching {
        val tip = tip() ?: return@runCatching emptySet<String>()
        val open = exits().filter { it.type != "claimable" && it.type != "claimed" && it.type != "claim-in-progress" }.map { it.vtxo }.toSet()
        val arr = JSONArray(call("GET", "/wallet/vtxos"))
        (0 until arr.length()).map { arr.getJSONObject(it) }
            .filter { it.optString("id") in open && it.optInt("expiry_height", Int.MAX_VALUE) + 144 < tip }
            .map { it.getString("id") }.toSet()
    }.getOrDefault(emptySet())

    // ------------------------------------------------------------------ history

    data class Movement(
        val id: String, val status: String, val kind: String, val amount: Long, val time: String,
        val fee: Long = 0, val destinations: List<String> = emptyList(), val onchainTxid: String? = null,
        val vtxos: List<String> = emptyList(), val paymentHash: String? = null, val preimage: String? = null,
        val confirmations: Int? = null,
    ) {
        fun json(): JSONObject = JSONObject().put("id", id).put("status", status).put("kind", kind).put("amount", amount)
            .put("time", time).put("fee", fee).put("to", JSONArray(destinations)).put("txid", onchainTxid ?: JSONObject.NULL)
            .put("vtxos", JSONArray(vtxos)).put("paymentHash", paymentHash ?: JSONObject.NULL).put("preimage", preimage ?: JSONObject.NULL)
            .put("confirmations", confirmations ?: JSONObject.NULL)
    }

    private fun kindLabel(subsystem: String): String = when (subsystem) {
        "bark.board" -> "move into Ark"; "bark.arkoor" -> "Ark payment"; "bark.round" -> "renewal"
        "bark.offboard" -> "withdrawal"; "bark.lightning_send" -> "Lightning payment"
        "bark.lightning_receive" -> "Lightning received"; "bark.exit" -> "emergency exit"
        else -> subsystem.removePrefix("bark.")
    }

    private fun strings(a: JSONArray?): List<String> =
        if (a == null) emptyList() else (0 until a.length()).map { a.optString(it) }.filter { it.isNotEmpty() }

    private fun onchainTxid(m: JSONObject): String? {
        val meta = m.optJSONObject("metadata")
        meta?.optString("chain_anchor")?.takeIf { it.isNotEmpty() }?.let { return it.substringBefore(':') }
        for (k in listOf("funding_txid", "offboard_txid", "txid")) meta?.optString(k)?.takeIf { it.length == 64 }?.let { return it }
        if (m.optJSONObject("subsystem")?.optString("name") == "bark.exit") return strings(m.optJSONArray("input_vtxos")).firstOrNull()?.substringBefore(':')
        return null
    }

    fun history(): List<Movement> {
        val arr = runCatching { JSONArray(call("GET", "/history")) }.getOrElse { JSONArray() }
        return (0 until arr.length()).map { i ->
            val m = arr.getJSONObject(i)
            Movement(
                id = m.optString("id"), status = m.optString("status"),
                kind = kindLabel(m.optJSONObject("subsystem")?.optString("name").orEmpty()).let { k ->
                    if (k == "Ark payment" && m.optLong("effective_balance_sat") > 0) "Ark received" else k
                },
                amount = m.optLong("effective_balance_sat", m.optLong("intended_balance_sat")),
                time = m.optJSONObject("time")?.optString("created_at") ?: "",
                fee = m.optLong("offchain_fee_sat") + (m.optJSONObject("metadata")?.optLong("onchain_fee_sat") ?: 0),
                destinations = m.optJSONArray("sent_to")?.let { a ->
                    (0 until a.length()).mapNotNull { a.getJSONObject(it).optJSONObject("destination")?.optString("value") }
                }.orEmpty(),
                onchainTxid = onchainTxid(m),
                vtxos = strings(m.optJSONArray("output_vtxos")).ifEmpty { strings(m.optJSONArray("input_vtxos")) },
                paymentHash = m.optJSONObject("metadata")?.optString("payment_hash")?.takeIf { it.isNotEmpty() },
                preimage = m.optJSONObject("metadata")?.optString("payment_preimage")?.takeIf { it.isNotEmpty() },
            )
        }
    }

    /** Ark movements and the deposit's own transactions, newest first. */
    fun activity(): List<Movement> {
        val txs = depositTxs()
        val tip = tip() ?: -1
        fun confs(txid: String?): Int? {
            val t = txs.firstOrNull { it.txid == txid } ?: return null
            return if (t.height == null) 0 else if (tip < 0) null else (tip - t.height + 1).coerceAtLeast(1)
        }
        val lost = lostExits()
        val moves = history().map { m ->
            when {
                m.kind == "move into Ark" && m.status != "successful" -> m.copy(confirmations = confs(m.onchainTxid))
                m.kind == "emergency exit" && m.status == "pending" && m.vtxos.any { it in lost } -> m.copy(status = "lost")
                else -> m
            }
        }
        val anchored = moves.mapNotNull { it.onchainTxid }.toSet()
        val now = System.currentTimeMillis()
        val iso = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", java.util.Locale.US).apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
        val deposits = txs.filter { it.txid !in anchored && it.change != 0L }.map { t ->
            val ms = if (t.height == null || tip < 0) now else now - (tip - t.height).coerceAtLeast(0) * 600_000L
            Movement(id = "tx:" + t.txid, status = if (t.height == null) "unconfirmed" else "confirmed",
                kind = if (t.change > 0) "deposit received" else "sent from deposit",
                amount = t.change, time = iso.format(java.util.Date(ms)), fee = t.fee ?: 0, onchainTxid = t.txid,
                confirmations = if (t.height == null) 0 else null)
        }
        return (moves + deposits).sortedByDescending { it.time }
    }

    fun tip(): Int? = runCatching { JSONObject(call("GET", "/bitcoin/tip")).optInt("tip_height", -1) }.getOrNull()?.takeIf { it > 0 }

    /** Blocks until the next spendable Ark coin expires; null if unknown or none. */
    fun blocksToNearestExpiry(): Int? = nearestExpiryHeight()?.let { h -> tip()?.let { h - it } }

    private fun nearestExpiryHeight(): Int? = runCatching {
        val vtxos = JSONArray(call("GET", "/wallet/vtxos"))
        (0 until vtxos.length()).map { vtxos.getJSONObject(it) }
            .filter { it.optJSONObject("state")?.optString("type") == "spendable" }
            .mapNotNull { it.optInt("expiry_height", -1).takeIf { h -> h > 0 } }.minOrNull()
    }.getOrNull()

    fun syncOnchain() { runCatching { call("POST", "/onchain/sync", JSONObject(), 60_000) } }

    /** The end of the engine's own log (debug.log); lines that mention words or seeds are dropped. */
    fun engineLogTail(maxBytes: Int = 48_000): String? = runCatching {
        val f = File(dir, "debug.log")
        if (!f.exists()) return@runCatching null
        java.io.RandomAccessFile(f, "r").use { raf ->
            val start = maxOf(0L, raf.length() - maxBytes)
            raf.seek(start)
            val bytes = ByteArray((raf.length() - start).toInt()); raf.readFully(bytes)
            String(bytes, Charsets.UTF_8).lines().drop(if (start > 0) 1 else 0)
                .filterNot { it.contains("mnemonic", true) || it.contains("seed", true) || it.contains("passphrase", true) }
                .joinToString("\n")
        }
    }.getOrNull()

    // ------------------------------------------------------------------ alerts (the app's ArkWatch)

    private fun sats(v: Long) = "%,d".format(kotlin.math.abs(v)).replace(',', ' ')

    /**
     * Compares every movement's status with what it saw last time and raises events: payments in
     * and out, moves into Ark (started, spendable), renewals, withdrawals, deposits, failures, and
     * coins close to expiry. The first run records a baseline only. While the engine is down
     * (after a restart, until an unlock), it warns from the last expiry it knew.
     */
    @Synchronized
    fun watch() {
        if (!enabled || activating) return
        if (!running) {
            val known = state().optInt("nearest_expiry_height", 0)
            val tip = nodeTip() ?: return
            val left = if (known > 0) known - tip else null
            val last = state().optLong("down_warned", 0)
            val every = when { left != null && left < 432 -> 6 * 3600_000L; left != null && left < EXPIRY_WARN_BLOCKS -> 24 * 3600_000L; else -> 3 * 24 * 3600_000L }
            val downFor = System.currentTimeMillis() - state().optLong("engine_seen", System.currentTimeMillis())
            if (System.currentTimeMillis() - last > every && (downFor > 10 * 60_000 || (left != null && left < EXPIRY_WARN_BLOCKS))) {
                val why = if (secret == null) "Kilowallet was restarted and Ark needs your password to run: open Kilowallet and unlock it."
                    else "The Ark engine is not running" + (lastError?.let { ": $it" } ?: ".")
                events.emit("Ark is not running", why + (left?.let { " Your next Ark coin expires in about $it blocks (≈ ${String.format(java.util.Locale.US, "%.1f", it * 10 / 1440.0)} days); it is only renewed while Ark runs." } ?: ""), null)
                saveState { it.put("down_warned", System.currentTimeMillis()) }
            }
            return
        }
        runCatching { balance() }.getOrNull() ?: return
        saveState { it.put("engine_seen", System.currentTimeMillis()) }
        val movements = activity()
        val seen = state().optJSONObject("seen")
        val now = JSONObject()
        movements.forEach { now.put(it.id, it.status) }
        if (seen != null) for (m in movements) {
            val before = if (seen.has(m.id)) seen.getString(m.id) else null
            if (before == m.status) continue
            val done = m.status == "successful"
            val failed = m.status == "failed" || m.status == "canceled" || m.status == "cancelled"
            when (m.kind) {
                "Ark received", "Lightning received" -> if (done && m.amount > 0) events.emit("Ark: received ${sats(m.amount)} sats", "${m.kind}: ${sats(m.amount)} sats arrived in your Ark wallet.", null)
                "move into Ark" -> when {
                    done -> events.emit("Ark: move into Ark spendable", "${sats(m.amount)} sats are now spendable in Ark.", null)
                    before == null && !failed -> events.emit("Ark: moving into Ark", "${sats(m.amount)} sats on their way into Ark; spendable after $BOARD_CONFIRMATIONS confirmations.", null)
                }
                "withdrawal" -> if (done) events.emit("Ark: withdrawal confirmed", "${sats(m.amount)} sats left Ark on-chain.", null)
                "Ark payment", "Lightning payment" -> when {
                    done -> events.emit("Ark: sent ${sats(m.amount)} sats", "${m.kind} of ${sats(m.amount)} sats completed.", null)
                    failed -> events.emit("Ark: payment failed", "${m.kind} of ${sats(m.amount)} sats failed; the coins came back (the recovery reserve is not refunded).", null)
                }
                "renewal" -> if (done) events.emit("Ark: coins renewed", "Your Ark coins were renewed for about 30 more days (cost ${sats(maxOf(m.fee, -m.amount))} sats).", null)
                "deposit received" -> events.emit(if (m.status == "confirmed") "Ark: deposit confirmed" else "Ark: deposit arriving",
                    "${sats(m.amount)} sats to your Ark deposit address" + (if (m.status == "confirmed") ", confirmed. MOVE INTO ARK to use them in Ark." else ", in the mempool."), null)
                "sent from deposit" -> events.emit(if (m.status == "confirmed") "Ark: deposit send confirmed" else "Ark: sent from the deposit",
                    "${sats(m.amount)} sats from your Ark deposit" + (if (m.status == "confirmed") ", confirmed." else ", in the mempool."), null)
            }
        }
        val nearest = nearestExpiryHeight()
        saveState { it.put("seen", now).put("nearest_expiry_height", nearest ?: 0) }
        val tip = tip() ?: return
        val blocks = nearest?.let { it - tip } ?: return
        val last = state().optLong("expiry_warned", 0)
        // Under 3 days, every 6 hours: an expired coin is the server's to sweep.
        val every = if (blocks < 432) 6 * 3600_000L else 24 * 3600_000L
        if (blocks in 0 until EXPIRY_WARN_BLOCKS && System.currentTimeMillis() - last > every) {
            events.emit("Ark: coins expire soon", "Your next Ark coin expires in $blocks blocks (≈ ${String.format(java.util.Locale.US, "%.1f", blocks * 10 / 1440.0)} days). " +
                "The engine renews coins by itself while it runs; if this warning repeats, open the ARK tab and RENEW, or withdraw.", null)
            saveState { it.put("expiry_warned", System.currentTimeMillis()) }
        }
    }

    /** A digest of the coins and movements (to tell whether a backup is out of date). */
    fun fingerprint(): String? = runCatching {
        val vtxos = JSONArray(call("GET", "/wallet/vtxos"))
        val ids = (0 until vtxos.length()).map { vtxos.getJSONObject(it).optString("id") }.sorted()
        val moves = history().map { "${it.id}:${it.status}" }.sorted()
        MessageDigest.getInstance("SHA-256").digest((ids + "|" + moves).joinToString(",").toByteArray()).joinToString("") { "%02x".format(it) }
    }.getOrNull()
}
