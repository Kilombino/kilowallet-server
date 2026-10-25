package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.coinjoin.CoinjoinTx
import com.kilombino.pyblockwatch.coinjoin.PoolSession
import com.kilombino.pyblockwatch.coinjoin.Protocol
import com.kilombino.pyblockwatch.coinjoin.RelayClient
import com.kilombino.pyblockwatch.crypto.Address
import com.kilombino.pyblockwatch.crypto.Bech32
import com.kilombino.pyblockwatch.crypto.Hashes.toHex
import com.kilombino.pyblockwatch.crypto.ScriptType
import com.kilombino.pyblockwatch.crypto.Secp256k1
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import kotlin.test.Test

/**
 * A pool member made only of the app's own protocol code, for rounds against this server and
 * Kilojoin on a BLAKE2b regtest node, through the relay. Runs only with KW_E2E_PEER set:
 *   KW_E2E_PEER=create  opens a v5 payment pool paying KW_E2E_PAYS (e.g. "37123,62877") to keys
 *                       of its own, KW_E2E_OUTPUTS equal outputs for each of the others; asks to
 *                       close once KW_E2E_PEOPLE are in (2 by default), signs, mines, checks.
 *   KW_E2E_PEER=equal   opens a pool of KW_E2E_AMOUNT × KW_E2E_OUTPUTS equal outputs each (a test pool
 *                       when that is under the minimum per person), waits KW_E2E_WAIT seconds, ends it.
 *   KW_E2E_PEER=join    joins pool KW_E2E_POOL (or the newest v5 one), with a coin of exactly
 *                       its amount plus fee (KW_E2E_EXTRA sats more for change), votes yes, signs.
 *   KW_E2E_RPC          user:pass@host:port of the regtest node; KW_E2E_WALLET its funded wallet.
 *   KW_E2E_NETWORK      the coinjoin network name all members use (not the mainnet one).
 * Prints RESULT lines with what happened.
 */
class E2EPeer {
    private lateinit var url: String
    private lateinit var auth: String
    private var wallet = "w"

    private fun rpc(method: String, vararg params: Any, w: Boolean = true): Any? {
        val c = URL(url + (if (w) "wallet/$wallet" else "")).openConnection() as HttpURLConnection
        c.requestMethod = "POST"; c.doOutput = true
        c.setRequestProperty("Authorization", "Basic " + Base64.getEncoder().encodeToString(auth.toByteArray()))
        c.outputStream.write(JSONObject().put("method", method).put("params", JSONArray(params.toList())).toString().toByteArray())
        val o = JSONObject((if (c.responseCode == 200) c.inputStream else c.errorStream).bufferedReader().readText())
        if (!o.isNull("error")) throw IllegalStateException(o.getJSONObject("error").getString("message"))
        return o.opt("result")
    }

    private val rnd = SecureRandom()
    private val base = BigInteger(250, rnd).add(BigInteger.ONE)
    private fun key(n: Int) = base.add(BigInteger.valueOf(n.toLong())).mod(Secp256k1.N)
    private fun pub(n: Int) = Secp256k1.compress(Secp256k1.multiply(key(n), Secp256k1.G))
    private fun script(n: Int, t: ScriptType = ScriptType.P2WPKH) = Address.scriptPubKey(pub(n), t)
    private fun mine() { rpc("generatetoaddress", 1, rpc("getnewaddress") as String) }

    /** Pays [sats] from the regtest wallet to key [n] and gives back that coin, mined. */
    private fun fund(n: Int, sats: Long): CoinjoinTx.Coin {
        val spk = script(n)
        val a = Bech32.encodeSegwit("bcrt", 0, spk.copyOfRange(2, spk.size))
        val txid = rpc("sendtoaddress", a, sats / 1e8) as String
        val tx = rpc("getrawtransaction", txid, true, w = false) as JSONObject
        val vout = tx.getJSONArray("vout").let { v -> (0 until v.length()).first { v.getJSONObject(it).getJSONObject("scriptPubKey").getString("hex") == spk.toHex() } }
        mine()
        return CoinjoinTx.Coin(txid, vout, sats, pub(n))
    }

    private fun env(name: String) = object : PoolSession.Env {
        override fun coinUnspent(coin: CoinjoinTx.Coin): Boolean {
            val o = rpc("gettxout", coin.txid, coin.vout, true, w = false) as? JSONObject ?: return false
            return Math.round(o.getDouble("value") * 1e8) == coin.value && o.getJSONObject("scriptPubKey").getString("hex") == coin.script.toHex()
        }
        override fun broadcast(rawHex: String): String = rpc("sendrawtransaction", rawHex, w = false) as String
        override fun confirmations(txid: String): Int? =
            runCatching { (rpc("getrawtransaction", txid, true, w = false) as JSONObject).optInt("confirmations", 0) }.getOrNull()
        override fun save(state: PoolSession.State) { PoolSession.State.parse(state.toJson()) }
        override fun log(msg: String) = println("[$name] $msg")
        override fun event(e: PoolSession.Event) { if (e !is PoolSession.Event.Changed) println("[$name] EVENT ${e.javaClass.simpleName} $e") }
    }

    private fun pools(): List<Protocol.Terms> {
        val found = ConcurrentHashMap<String, Protocol.Terms>()
        val r = RelayClient(Protocol.RELAY, { _, ev -> Protocol.Terms.parse(ev)?.let { t -> if ((found[t.id]?.createdAt ?: 0) < t.createdAt) found[t.id] = t } })
        try {
            r.connect()
            r.subscribe("p", listOf(JSONObject().put("kinds", JSONArray().put(Protocol.KIND_POOL)).put("#t", JSONArray().put(Protocol.TAG))
                .put("since", System.currentTimeMillis() / 1000 - 3 * 3600)))
        } finally { r.close() }
        return found.values.filter { it.state == "open" }.sortedByDescending { it.createdAt }
    }

    /** Votes yes, signs when the round is ready, until it is out; then mines it and waits for the confirmation. */
    private fun drive(s: PoolSession, keys: List<BigInteger>, closeAt: Int?, minutes: Int = 40): String? {
        var voted: String? = null; var signed = false; var asked = false
        val stop = System.currentTimeMillis() + minutes * 60_000L
        while (System.currentTimeMillis() < stop) {
            val st = s.state
            if (closeAt != null && !asked && st.phase == PoolSession.Phase.OPEN && st.seats.size >= closeAt) { Thread.sleep(3000); s.requestClose(); asked = true; println("asked to close") }
            if (st.phase == PoolSession.Phase.VOTING && st.voteId != voted) { voted = st.voteId; runCatching { s.vote(true) }; println("voted yes") }
            if (st.phase == PoolSession.Phase.SIGNING && !signed) { s.sign(keys); signed = true; println("signed (plan txid ${CoinjoinTx.txid(s.plan()!!)})") }
            if (st.phase == PoolSession.Phase.BROADCAST && st.txid != null) break
            if (st.phase in setOf(PoolSession.Phase.ABORTED, PoolSession.Phase.REJECTED)) { println("RESULT ENDED ${st.phase} ${st.reason}"); return null }
            Thread.sleep(2000)
        }
        val txid = s.state.txid ?: run { println("RESULT TIMEOUT phase ${s.state.phase}"); return null }
        mine()
        val until = System.currentTimeMillis() + 120_000
        while (s.state.phase != PoolSession.Phase.CONFIRMED && System.currentTimeMillis() < until) Thread.sleep(2000)
        println("RESULT ${s.state.phase} $txid")
        return txid
    }

    private fun outputsOf(txid: String): List<Pair<String, Long>> {
        val tx = rpc("getrawtransaction", txid, true, w = false) as JSONObject
        return tx.getJSONArray("vout").let { v -> (0 until v.length()).map { v.getJSONObject(it) } }
            .map { it.getJSONObject("scriptPubKey").getString("hex") to Math.round(it.getDouble("value") * 1e8) }
    }

    @Test fun peer() {
        val mode = System.getenv("KW_E2E_PEER") ?: return
        val (cred, host) = System.getenv("KW_E2E_RPC")!!.split("@")
        auth = cred; url = "http://$host/"
        wallet = System.getenv("KW_E2E_WALLET") ?: "w"
        Protocol.NETWORK = System.getenv("KW_E2E_NETWORK") ?: error("set KW_E2E_NETWORK (not the mainnet one)")
        require(Protocol.NETWORK != "blake2b") { "not on mainnet" }
        val rate = System.getenv("KW_E2E_RATE")?.toDouble() ?: 1.0
        when (mode) {
            "create" -> {
                val pays = System.getenv("KW_E2E_PAYS")!!.split(",").map { it.trim().toLong() }
                val (d, k) = Protocol.v5Split(pays.sum(), System.getenv("KW_E2E_OUTPUTS")?.toInt() ?: 1)
                val people = System.getenv("KW_E2E_PEOPLE")?.toInt() ?: 2
                val coin = fund(1, pays.sum() + 50_000)
                val np = PoolSession.newPool(d, rate, 5, 2, minPeers = 2, maxInputs = 2, v3 = true, outputs = k, payments = pays)
                val payTo = pays.indices.map { script(100 + it) }
                val s = PoolSession(env("creator"), PoolSession.newState(np.terms, true, np.secret, listOf(coin), listOf(key(1)), listOf("a"),
                    payTo, script(2), creatorSecret = np.creatorSecret, blindPriv = np.blindPriv))
                s.start()
                println("RESULT POOL ${np.terms.id} v${np.terms.version} payments $pays, ${k} × $d for each of the others")
                val txid = drive(s, listOf(key(1)), people) ?: return
                val got = outputsOf(txid)
                val paid = pays.indices.all { i -> got.count { it.first == payTo[i].toHex() && it.second == pays[i] } == 1 }
                println("RESULT PAID $paid outputs ${got.map { it.second }}")
                s.stop()
            }
            "equal" -> {
                val amount = System.getenv("KW_E2E_AMOUNT")!!.toLong(); val k = System.getenv("KW_E2E_OUTPUTS")?.toInt() ?: 1
                val coin = fund(1, amount * k + 20_000)
                val np = PoolSession.newPool(amount, rate, 5, 1, minPeers = 2, v3 = true, outputs = k)
                val s = PoolSession(env("creator"), PoolSession.newState(np.terms, true, np.secret, listOf(coin), listOf(key(1)), listOf("a"),
                    (0 until k).map { script(10 + it) }, script(2), creatorSecret = np.creatorSecret, blindPriv = np.blindPriv))
                s.start()
                println("RESULT POOL ${np.terms.id} v${np.terms.version} $k × $amount, test ${Protocol.isTest(np.terms)}")
                Thread.sleep((System.getenv("KW_E2E_WAIT")?.toLong() ?: 90) * 1000)
                println("RESULT LISTED-BY-ME ${pools().any { it.id == np.terms.id }} seats ${s.state.seats.size}")
                s.leave(); Thread.sleep(3000); s.stop()
            }
            "join" -> {
                val id = System.getenv("KW_E2E_POOL")
                var t: Protocol.Terms? = null
                val end = System.currentTimeMillis() + 10 * 60_000
                while (t == null && System.currentTimeMillis() < end) {
                    t = pools().firstOrNull { if (id != null) it.id == id else it.v5 }
                    if (t == null) { println("waiting for the pool…"); Thread.sleep(10_000) }
                }
                t ?: error("no pool")
                println("joining ${t.id}: v${t.version} ${t.outputs} × ${t.amount}, payments ${t.payments}, test ${Protocol.isTest(t)}")
                val extra = System.getenv("KW_E2E_EXTRA")?.toLong() ?: 0L
                val coin = fund(1, CoinjoinTx.minimumCoin(t.amount, t.feeRate, t.script, t.outputs) + extra)
                val mixes = (0 until t.outputs).map { script(10 + it) }
                val s = PoolSession(env("joiner"), PoolSession.newState(t, false, null, listOf(coin), listOf(key(1)), listOf("b"), mixes, script(2)))
                s.start()
                val txid = drive(s, listOf(key(1)), System.getenv("KW_E2E_CLOSE_AT")?.toInt()) ?: return
                val got = outputsOf(txid)
                println("RESULT MINE ${mixes.all { m -> got.count { it.first == m.toHex() && it.second == t.amount } == 1 }} outputs ${got.map { it.second }}")
                s.stop()
            }
        }
    }
}
