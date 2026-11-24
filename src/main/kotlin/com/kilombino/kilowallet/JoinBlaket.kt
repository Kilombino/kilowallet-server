package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.coinjoin.JoinBlaketMarket
import com.kilombino.pyblockwatch.crypto.Address
import com.kilombino.pyblockwatch.crypto.Bech32
import com.kilombino.pyblockwatch.crypto.Bip32Priv
import com.kilombino.pyblockwatch.crypto.ScriptType
import com.kilombino.pyblockwatch.crypto.TxParse
import com.kilombino.pyblockwatch.joinblaket.ChainLookup
import com.kilombino.pyblockwatch.joinblaket.CommitmentStore
import com.kilombino.pyblockwatch.joinblaket.Directory
import com.kilombino.pyblockwatch.joinblaket.DirectoryClient
import com.kilombino.pyblockwatch.joinblaket.DirectoryPool
import com.kilombino.pyblockwatch.joinblaket.DirectoryException
import com.kilombino.pyblockwatch.joinblaket.FileCommitmentStore
import com.kilombino.pyblockwatch.joinblaket.JbNetwork
import com.kilombino.pyblockwatch.joinblaket.JoinBlaketDirectory
import com.kilombino.pyblockwatch.joinblaket.NickIdentity
import com.kilombino.pyblockwatch.joinblaket.RpcChainLookup
import com.kilombino.pyblockwatch.joinblaket.TakerCoin
import com.kilombino.pyblockwatch.joinblaket.TakerConfig
import com.kilombino.pyblockwatch.joinblaket.TakerEnv
import com.kilombino.pyblockwatch.joinblaket.TakerPlan
import com.kilombino.pyblockwatch.joinblaket.TakerRequest
import com.kilombino.pyblockwatch.joinblaket.TakerResult
import com.kilombino.pyblockwatch.joinblaket.TakerSession
import com.kilombino.pyblockwatch.joinblaket.TakerStep
import com.kilombino.pyblockwatch.joinblaket.TakerText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket

/**
 * PAY THROUGH JOINBLAKET on this server, as the app since 1.6.0 (its `JoinBlaketPay`, whose
 * Android parts don't come here): SEND hands over one payment to one bc1q address, and it goes
 * out as the CoinJoin output of a JoinMarket CoinJoin with bonded makers ([TakerSession], the
 * app's own taker), change back to this wallet. The user confirms the plan (each maker's fee,
 * the mining fee and its ceiling) on the page before anything about the coins leaves the server.
 *
 * - The directory is an onion: it is reached through the SOCKS proxy in [torSocks] (Umbrel's or
 *   StartOS's Tor). Without one the feature says Tor is not available and does nothing.
 * - Chain lookups (makers' coins, fidelity bonds) and the broadcast go through the node by RPC.
 * - Used PoDLE commitments are kept in `joinblaket/commitments.json` (Python's format), in the
 *   data directory, so they are in the box's backups too.
 *
 * One round at a time. Its coins are held out of other sends and pools ([lockedOutpoints]); its
 * change address is taken from the wallet's change branch at the start, so nothing reuses it.
 * The coins' keys live only in the round and are dropped when it ends.
 */
class JoinBlaket(
    private val dir: File,
    private val rpc: Rpc,
    /** `host:port` of a SOCKS5 proxy into Tor, or null when this server has none. */
    val torSocks: String?,
    /** Tests only (a regtest lab): another directory, its nick-auth id and network. */
    private val directoryOverride: Triple<String, Int, String>? = null,
    val network: JbNetwork = if (directoryOverride != null) JbNetwork.REGTEST else JoinBlaketDirectory.NETWORK,
    private val config: TakerConfig = TakerConfig(network = network),
) {
    class View(
        val amount: Long, val recipient: String, val startedAt: Long,
        @Volatile var step: TakerStep? = null,
        @Volatile var plan: TakerPlan? = null,
        @Volatile var result: TakerResult? = null,
        /** Makers in the plan the user confirmed, for the line until the round says how many are ready. */
        @Volatile var confirmedMakers: Int = 0,
    ) {
        val finished: Boolean get() = result != null
        /** Signed and on its way: cancelling no longer stops it. */
        val pastReturn: Boolean get() = step == TakerStep.Broadcasting
    }

    private class Round(val request: TakerRequest, val view: View, val noteSent: (String) -> Unit) {
        @Volatile var job: Job? = null
        @Volatile var answer: CompletableDeferred<Boolean>? = null
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var round: Round? = null
    val commitments = FileCommitmentStore(File(dir, "joinblaket/commitments.json"))

    val view: View? get() = round?.view
    val running: Boolean get() = round?.view?.finished == false

    // ------------------------------------------------------------------ the market (start10's orderbook watcher)

    @Volatile private var market: JoinBlaketMarket.Market? = null
    @Volatile private var marketAt = 0L
    @Volatile private var marketError: String? = null

    /** The market, read again when older than 25 s (the page asks every 30 s, as the app's send screen). */
    fun market(): JoinBlaketMarket.Market? {
        val now = System.currentTimeMillis()
        if (now - marketAt > 25_000) synchronized(this) {
            if (now - marketAt > 25_000) {
                runCatching { JoinBlaketMarket.fetch() }
                    .onSuccess { market = it; marketError = null }
                    .onFailure { marketError = it.message ?: "error" }
                marketAt = System.currentTimeMillis()
            }
        }
        return market
    }

    fun marketJson(amount: Long, feeRate: Double): JSONObject {
        val m = market()
        val o = JSONObject().put("tor", torSocks != null).put("read", m != null).put("failed", m == null && marketError != null)
        if (m == null) return o
        o.put("makers", m.makers).put("min", m.minAmount ?: JSONObject.NULL).put("max", m.maxAmount ?: JSONObject.NULL)
            .put("height", m.height ?: JSONObject.NULL)
        if (amount > 0) {
            // Whether a maker takes the amount at all (the app checks it at 1 sat/vB), and the cost at the typed rate.
            o.put("takes", JoinBlaketMarket.estimate(m, amount, 1.0) != null)
            JoinBlaketMarket.estimate(m, amount, feeRate)?.let { e ->
                o.put("estimate", JSONObject().put("makers", e.makers).put("makerFees", e.makerFees).put("miningFee", e.miningFee).put("total", e.total))
            }
        }
        return o
    }

    /** Whether the SOCKS proxy answers at all (a TCP connect), for the page: Tor configured but down says so. */
    fun torUp(): Boolean {
        val (h, p) = socksAddress() ?: return false
        val now = System.currentTimeMillis()
        if (now - torCheckedAt > 60_000) {
            torAnswers = runCatching { Socket().use { it.connect(InetSocketAddress(h, p), 3_000) }; true }.getOrDefault(false)
            torCheckedAt = now
        }
        return torAnswers
    }
    @Volatile private var torAnswers = false
    @Volatile private var torCheckedAt = 0L

    private fun socksAddress(): Pair<String, Int>? {
        val s = torSocks?.trim()?.ifEmpty { null } ?: return null
        val i = s.lastIndexOf(':')
        if (i <= 0) return null
        val port = s.substring(i + 1).toIntOrNull() ?: return null
        return s.substring(0, i).trim('[', ']') to port
    }

    // ------------------------------------------------------------------ addresses on this round's network

    /**
     * The scriptPubKey of [address] if it is a plain bc1q address (the CoinJoin's equal outputs are
     * all native SegWit), else null. In the regtest lab a `bcrt1q` address, or the `bc1q` the
     * server shows for a regtest wallet, both work.
     */
    fun p2wpkhScript(address: String): ByteArray? {
        val a = address.trim()
        val spk = runCatching { Address.decodeToScriptPubKey(a) }.getOrNull()
            ?: if (network == JbNetwork.REGTEST) Bech32.decodeSegwit("bcrt", a)?.let { byteArrayOf(0, it.program.size.toByte()) + it.program } else null
        return spk?.takeIf { it.size == 22 && it[0] == 0.toByte() && it[1] == 0x14.toByte() }
    }

    // ------------------------------------------------------------------ before unlocking

    /**
     * The checks the app makes before asking for the fingerprint: one confirmed bc1q coin among
     * [coins] must have [TakerConfig.utxoAge] confirmations and at least [TakerConfig.utxoAmountPercent] %
     * of [amount], or the makers refuse its PoDLE. [unconfirmed]: the wallet's coins still at 0
     * confirmations (they count for "wait"). Null when it can go on, else what to tell the user.
     */
    fun precheck(coins: List<NodeWallet.Utxo>, unconfirmed: List<NodeWallet.Utxo>, amount: Long): String? {
        val age = config.utxoAge
        val need = amount * config.utxoAmountPercent / 100
        val pendingBig = unconfirmed.filter { it.value >= need }
        if (coins.isEmpty()) return if (pendingBig.isNotEmpty()) TakerText.fill(WAIT_UNCONFIRMED, age, age * 10) else NO_COINS
        if (coins.none { it.confirmations >= age && it.value >= need }) {
            val big = coins.filter { it.value >= need }
            if (big.isEmpty() && pendingBig.isEmpty()) return TakerText.fill(NO_BIG_COIN, need)
            val wait = (big.map { age - it.confirmations } + if (pendingBig.isNotEmpty()) listOf(age) else emptyList()).min().coerceAtLeast(1)
            return TakerText.fill(WAIT_CONFIRMATIONS, wait, wait * 10)
        }
        return null
    }

    // ------------------------------------------------------------------ the round

    /** Coins of the round going: kept out of other payments and pools until it ends. */
    fun lockedOutpoints(): Set<String> =
        round?.takeIf { !it.view.finished }?.request?.coins?.map { "${it.txid}:${it.vout}" }?.toSet().orEmpty()

    /**
     * Start a round paying [amount] sats to [recipient] from [coins] of [w] (the bc1q account),
     * keys from [secret], at about [feeRate] sat/vB. Throws (with the reason for the user) when it
     * can't start; the round's own failures end up in its [View.result].
     */
    @Synchronized fun start(secret: Vault.Secret, w: NodeWallet, coins: List<NodeWallet.Utxo>, recipient: String, amount: Long,
                            feeRate: Double, tip: Int): View {
        check(!running) { BUSY }
        require(torSocks != null) { NO_TOR }
        require(w.type == ScriptType.P2WPKH) { NOT_SUPPORTED }
        require(coins.isNotEmpty()) { NO_COINS }
        val to = p2wpkhScript(recipient) ?: throw IllegalArgumentException(ONLY_BC1Q)
        val master = Spend.master(secret)
        val takerCoins = coins.map { u ->
            require(u.type == ScriptType.P2WPKH) { NOT_SUPPORTED }
            val node = Bip32Priv.derivePath(master, "m/84'/0'/0'/${u.branch}/${u.index}")
            // Each key must spend its coin's address: a mismatch would only fail later, at the makers.
            check(node.publicKey().contentEquals(w.pubkey(u.branch, u.index))) { "These words do not match this wallet's key." }
            val height = if (u.confirmations > 0) tip - u.confirmations + 1 else 0
            TakerCoin(u.txid, u.vout.toLong(), u.value, node.key, height)
        }
        // A fresh change address of this wallet, taken now: no other send or pool can be given it.
        val change = w.freshChange().second
        val request = TakerRequest(network.p2wpkhAddress(to), amount, feeRate, takerCoins, network.p2wpkhAddress(change))
        val r = Round(request, View(amount, recipient.trim(), System.currentTimeMillis() / 1000)) { w.noteSent(it) }
        round = r
        r.job = scope.launch {
            val result = try {
                TakerSession(Env(r), config).run(request)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                TakerResult.Failed(CHAIN, e.message)
            }
            finish(r, result)
        }
        return r.view
    }

    /** The user's answer to the plan. */
    fun answer(yes: Boolean) { round?.answer?.complete(yes) }

    /** Stop the round, unless it is already signed and on its way. */
    fun cancel() {
        val r = round ?: return
        if (r.view.finished || r.view.pastReturn) return
        r.answer?.complete(false)
        r.job?.cancel()
        finish(r, TakerResult.Cancelled(TakerText.CANCELLED))
    }

    /** Forget a finished round (its sheet is closed). */
    @Synchronized fun dismiss() { if (round?.view?.finished == true) round = null }

    @Synchronized private fun finish(r: Round, result: TakerResult) {
        if (r.view.finished) return
        r.view.plan = null
        r.view.result = result
        r.answer = null; r.job = null
        if (result is TakerResult.Sent) runCatching { r.noteSent(result.txid) }
        // The keys go with the request: only the view stays, until the page dismisses it.
        round = Round(TakerRequest(r.request.recipient, r.request.amount, r.request.feeRate, emptyList(), r.request.changeAddress), r.view, r.noteSent)
        System.err.println("JoinBlaket: " + when (result) {
            is TakerResult.Sent -> "sent ${result.txid} (${result.makers} makers, makers' fees ${result.makerFees}, mining fee ${result.txFee})"
            is TakerResult.Failed -> "failed: ${result.reason}${result.detail?.let { " ($it)" } ?: ""}"
            is TakerResult.Cancelled -> "cancelled"
        })
    }

    private inner class Env(private val r: Round) : TakerEnv {
        override fun directory(identity: NickIdentity): Directory = newDirectory(identity)
        override val chain: ChainLookup = nodeLookup()
        override fun broadcast(rawHex: String): String = rpc.call("sendrawtransaction", rawHex) as String
        override val commitments: CommitmentStore = this@JoinBlaket.commitments

        override suspend fun confirm(plan: TakerPlan): Boolean {
            val d = CompletableDeferred<Boolean>()
            r.answer = d
            r.view.plan = plan
            return try { d.await().also { if (it) r.view.confirmedMakers = plan.makers.size } } finally { r.view.plan = null }
        }

        override fun progress(step: TakerStep) { r.view.step = step }
        override fun log(line: String) { if (System.getenv("KILOWALLET_JB_LOG") != null) System.err.println("[taker] $line") }
    }

    /**
     * JoinBlaket's directories through Tor, all at once with one nick, as the app does
     * ([DirectoryPool]: the round goes on with those that answer); the lab's single directory
     * (without Tor unless an onion) in a regtest test.
     */
    private fun newDirectory(identity: NickIdentity): Directory {
        val (h, p) = socksAddress() ?: throw DirectoryException(NO_TOR)
        // The name is resolved by the proxy: an onion has no other way in.
        val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress.createUnresolved(h, p))
        val d = directoryOverride
        return if (d != null) DirectoryClient(d.first, d.second, identity, network.wire, d.third, requireVerified = true,
            proxy = proxy.takeIf { DirectoryClient.isOnion(d.first) }, allowClearnet = true)
        else DirectoryPool(JoinBlaketDirectory.ALL.map { e ->
            DirectoryClient(e.host, e.port, identity, network.wire, e.id, requireVerified = true, proxy = proxy)
        })
    }

    /** Chain lookups (makers' coins, fidelity bonds) through the node by RPC, as the Python taker does. */
    private fun nodeLookup(): ChainLookup = RpcChainLookup { method, params -> rpc.call(method, *params.toTypedArray()) }

    /**
     * Read-only check of the whole path a round takes before anything of the wallet's is sent:
     * the directory through Tor with nick authentication, its `!orderbook`, and every bonded
     * offer valued on the node. A fresh random nick; no coin, commitment or address goes out.
     * For the operator (loopback-only endpoint) and tests.
     */
    fun probe(amount: Long = 30_000_000): JSONObject = kotlinx.coroutines.runBlocking(Dispatchers.IO) {
        val started = System.currentTimeMillis()
        var tries = 0
        var c = newDirectory(NickIdentity.random())
        // Onion circuits fail now and then: a fresh one, as a round does.
        while (true) {
            try { c.connect(); break } catch (e: DirectoryException) {
                if (++tries >= config.connectAttempts) throw e
                c = newDirectory(NickIdentity.random())
            }
        }
        val ob = try { com.kilombino.pyblockwatch.joinblaket.Orderbook.fetch(c, config.orderbook) } finally { c.close() }
        val valued = com.kilombino.pyblockwatch.joinblaket.BondValues.value(ob.offers, nodeLookup())
        val takes = valued.firstOrNull()?.offer?.let { maxOf(it.minsize, minOf(amount, it.maxsize)) } ?: amount
        val pick = com.kilombino.pyblockwatch.joinblaket.MakerSelection.choose(valued, takes, n = 9)
        val directories = (c as? DirectoryPool)?.connectedEndpoints ?: listOfNotNull((c as? DirectoryClient)?.let { "${it.host}:${it.port}" })
        JSONObject().put("authenticated", c.authenticated).put("directories", JSONArray(directories))
            .put("directoryFeatures", JSONArray(((c as? DirectoryClient)?.directoryFeatures ?: emptySet<String>()).sorted()))
            .put("peers", (c as? DirectoryClient)?.peers?.size ?: JSONObject.NULL).put("offerMessages", ob.offerMessages).put("bondedOffers", ob.offers.size).put("dropped", ob.dropped)
            .put("valued", valued.count { it.value > 0 }).put("tries", tries + 1).put("seconds", (System.currentTimeMillis() - started) / 1000)
            .put("offers", JSONArray(valued.map { v ->
                JSONObject().put("type", v.offer.type.wire).put("minsize", v.offer.minsize).put("maxsize", v.offer.maxsize)
                    .put("txfee", v.offer.txfee).put("cjfee", v.offer.cjfee).put("bondValue", v.value).put("problem", v.problem ?: JSONObject.NULL)
            }))
            .put("amount", takes).put("selection", when (pick) {
                is com.kilombino.pyblockwatch.joinblaket.MakerSelection.Result.Chosen -> "${pick.offers.size} maker(s), fees ${pick.totalFee} sats"
                is com.kilombino.pyblockwatch.joinblaket.MakerSelection.Result.Failed -> "none: ${pick.reason}"
            })
    }

    // ------------------------------------------------------------------ for the page

    fun viewJson(): JSONObject? {
        val v = view ?: return null
        val o = JSONObject().put("amount", v.amount).put("recipient", v.recipient).put("startedAt", v.startedAt)
            .put("finished", v.finished).put("pastReturn", v.pastReturn).put("line", line(v))
        v.plan?.let { p ->
            o.put("plan", JSONObject().put("amount", p.amount).put("makers", JSONArray(p.makers.map { JSONObject().put("fee", it.fee).put("bond", it.bondValue) }))
                .put("makerFees", p.makerFees).put("inputs", p.inputs).put("inputTotal", p.inputTotal).put("feeRate", p.feeRate)
                .put("miningFeeEstimate", p.miningFeeEstimate).put("miningFeeMax", p.miningFeeMax)
                .put("totalEstimate", p.totalEstimate).put("totalMax", p.totalMax))
        }
        when (val r = v.result) {
            is TakerResult.Sent -> o.put("result", JSONObject().put("kind", "sent").put("txid", r.txid).put("makers", r.makers)
                .put("makerFees", r.makerFees).put("txFee", r.txFee).put("minerFee", r.minerFee).put("change", r.change)
                .put("viaMaker", r.viaMaker).put("seen", r.seen)
                .put("vbytes", runCatching { TxParse.vsize(r.rawHex) }.getOrNull() ?: JSONObject.NULL))
            is TakerResult.Failed -> o.put("result", JSONObject().put("kind", "failed").put("reason", r.reason).put("detail", r.detail ?: JSONObject.NULL))
            is TakerResult.Cancelled -> o.put("result", JSONObject().put("kind", "cancelled").put("reason", r.reason))
            null -> {}
        }
        return o
    }

    companion object {
        /** The app's progress lines (JoinBlaketService.line), in English as the tables have them. */
        fun line(v: View): String {
            v.result?.let { r ->
                return when (r) {
                    is TakerResult.Sent -> if (r.seen) "Done: the CoinJoin was broadcast." else "Sent to the makers; your server doesn't show it yet."
                    is TakerResult.Failed -> r.reason
                    is TakerResult.Cancelled -> r.reason
                }
            }
            if (v.plan != null) return "Confirm the CoinJoin"
            return when (val s = v.step) {
                null, is TakerStep.Connecting -> "Connecting to JoinBlaket through Tor…"
                TakerStep.ReadingOffers -> "Reading the makers' offers…"
                is TakerStep.CheckingBonds -> "Checking the makers' fidelity bonds…"
                // Confirmed: the makers are being asked.
                is TakerStep.Confirm -> if (v.confirmedMakers > 0) "Waiting for the makers: 0 of ${v.confirmedMakers} ready" else "Confirm the CoinJoin"
                is TakerStep.WaitingForMakers -> "Waiting for the makers: ${s.ready} of ${s.asked} ready"
                is TakerStep.CollectingSignatures -> "Collecting the makers' signatures…"
                TakerStep.Broadcasting -> "Signing and broadcasting…"
            }
        }

        const val NO_TOR = "Tor is not available on this server, and the JoinBlaket directory is reached only through Tor."
        const val CHAIN = "Your BTC server could not be reached or its data did not verify. Nothing was sent."
        const val BUSY = "Another JoinBlaket payment is going: wait for it to end."
        const val NO_COINS = "No confirmed bc1q coins to pay from."
        const val ONLY_BC1Q = "Only plain bc1q addresses can be paid through JoinBlaket."
        const val NOT_SUPPORTED = "JoinBlaket needs a spending wallet with native SegWit (bc1q) addresses."
        /** JoinBlaket's PoDLE needs a coin with 5 confirmations and 20% of the amount: said before unlocking (the app's texts). */
        const val WAIT_CONFIRMATIONS =
            "None of these coins has 5 confirmations yet: makers only accept one that has. The first will in about {0} blocks (~{1} min)."
        const val WAIT_UNCONFIRMED =
            "Your coin is still unconfirmed: it needs {0} confirmations before it can open a CoinJoin (~{1} min)."
        const val NO_BIG_COIN =
            "None of these coins can open this CoinJoin: one needs at least {0} sats (20% of the amount)."
    }
}
