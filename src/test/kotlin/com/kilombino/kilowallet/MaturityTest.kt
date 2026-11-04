package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.crypto.ScriptType
import com.sun.net.httpserver.HttpServer
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Mined rewards still maturing: the rule (as the app's Scanner), the node's figures and what the page gets. */
class MaturityTest {
    @Test fun maturityByHeight() {
        assertEquals(100, Maturity.maturityFor(1))
        assertEquals(100, Maturity.maturityFor(961_640))
        assertEquals(100, Maturity.maturityFor(973_439))
        assertEquals(6480, Maturity.maturityFor(973_440))
        assertEquals(6480, Maturity.maturityFor(979_918))
        assertEquals(25920, Maturity.maturityFor(979_919))
        assertEquals(25920, Maturity.maturityFor(1_100_000))
    }

    @Test fun unlocksAtTheFirstTipThatCanSpendIt() {
        // Where the node's wallet frees it: height + maturity (Scanner.maturesAt + 1).
        assertEquals(973_539, Maturity.maturesAt(973_439))
        assertEquals(979_920, Maturity.maturesAt(973_440))
        assertEquals(986_398, Maturity.maturesAt(979_918))
        assertEquals(1_005_839, Maturity.maturesAt(979_919))
        assertEquals(201, Maturity.maturesAt(101)) // regtest: freed at 100 confirmations + 1, as seen on a node
    }

    @Test fun etaIsNeverInThePast() {
        assertEquals(1_000L + 10 * 600, Maturity.eta(110, 100, 600.0, 1_000))
        assertEquals(1_000L, Maturity.eta(90, 100, 600.0, 1_000))
    }

    @Test fun pageJsonListsEachCoinByUnlock() {
        val coins = listOf(
            Maturity.Coin("bb", 0, 312_500_000, 980_000),
            Maturity.Coin("aa", 1, 1_000, 975_000))
        val o = Maturity.json(312_501_000, coins, 980_010, 600.0, now = 1_000_000)
        assertEquals(312_501_000, o.getLong("total"))
        assertTrue(o.getBoolean("estimate"))
        assertEquals(980_010, o.getInt("tip"))
        val a = o.getJSONArray("coins")
        assertEquals(2, a.length())
        val first = a.getJSONObject(0)
        assertEquals("aa", first.getString("txid")); assertEquals(1, first.getInt("vout"))
        assertEquals(975_000 + 6480, first.getInt("unlockHeight"))
        assertEquals(5_011, first.getInt("confirmations"))
        assertEquals(1_000_000L + (981_480 - 980_010) * 600L, first.getLong("unlockTime"))
        val second = a.getJSONObject(1)
        assertEquals(980_000 + 25920, second.getInt("unlockHeight"))
        assertEquals(312_500_000, second.getLong("value"))
        assertEquals(980_000, second.getInt("height"))
    }

    // ------------------------------------------------------------------ against a fake node

    /** BIP84 test vector account key ("abandon … about", m/84'/0'/0'). */
    private val zpub = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs"

    private fun withNode(answer: (String, JSONArray) -> Any, block: (Rpc, MutableList<String>) -> Unit) {
        val calls = mutableListOf<String>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val req = JSONObject(ex.requestBody.bufferedReader().readText())
            val method = req.getString("method"); calls += method
            val body = JSONObject().put("result", answer(method, req.getJSONArray("params"))).put("error", JSONObject.NULL)
                .put("id", "kilowallet").toString().toByteArray()
            ex.sendResponseHeaders(200, body.size.toLong()); ex.responseBody.use { it.write(body) }
        }
        server.start()
        try { block(Rpc("http://127.0.0.1:${server.address.port}/", "u", "p", null), calls) } finally { server.stop(0) }
    }

    @Test fun immatureIsApartFromTheSpendableBalance() = withNode({ m, _ ->
        when (m) {
            "getbalances" -> JSONObject().put("mine", JSONObject().put("trusted", 0.5).put("untrusted_pending", 0.001).put("immature", 3.125))
            else -> error("unexpected $m")
        }
    }) { rpc, _ ->
        val b = NodeWallet(Files.createTempDirectory("kw").toFile(), rpc, zpub, ScriptType.P2WPKH).balance()
        assertEquals(50_000_000, b.confirmed)
        assertEquals(100_000, b.pending)
        assertEquals(312_500_000, b.immature)
    }

    @Test fun maturingCoinsFromTheNodeOncePerTip() = withNode({ m, p ->
        when (m) {
            "getblockhash" -> { assertEquals(980_010 - 25920, p.getInt(0)); "00ab" }
            "listsinceblock" -> { assertEquals("00ab", p.getString(0)); JSONObject().put("transactions", JSONArray()
                .put(JSONObject().put("category", "immature").put("txid", "cb1").put("vout", 0).put("amount", 3.125).put("blockheight", 980_000))
                .put(JSONObject().put("category", "receive").put("txid", "r1").put("vout", 1).put("amount", 0.1).put("blockheight", 979_000))
                .put(JSONObject().put("category", "generate").put("txid", "old").put("vout", 0).put("amount", 3.125).put("blockheight", 960_000))) }
            else -> error("unexpected $m")
        }
    }) { rpc, calls ->
        val w = NodeWallet(Files.createTempDirectory("kw").toFile(), rpc, zpub, ScriptType.P2WPKH)
        val l = w.maturing("tip1", 980_010)
        assertEquals(listOf(Maturity.Coin("cb1", 0, 312_500_000, 980_000)), l)
        assertEquals(1_005_920, l[0].maturesAt)
        w.maturing("tip1", 980_010)
        assertEquals(listOf("getblockhash", "listsinceblock"), calls) // the same tip: no new look
    }

    @Test fun aYoungChainIsLookedThroughFromTheStart() = withNode({ m, p ->
        when (m) {
            "listsinceblock" -> { assertEquals("", p.getString(0)); JSONObject().put("transactions", JSONArray()) }
            else -> error("unexpected $m")
        }
    }) { rpc, calls ->
        assertEquals(emptyList(), NodeWallet(Files.createTempDirectory("kw").toFile(), rpc, zpub, ScriptType.P2WPKH).maturing("t", 300))
        assertEquals(listOf("listsinceblock"), calls)
    }

    @Test fun paceFromTheLastDayOrTenMinutes() {
        withNode({ m, p ->
            when (m) {
                "getblockheader" -> JSONObject().put("time", if (p.getString(0) == "tipA") 1_000_000 + 144 * 900 else 1_000_000)
                "getblockhash" -> { assertEquals(1000 - 144, p.getInt(0)); "old" }
                else -> error("unexpected $m")
            }
        }) { rpc, _ -> assertEquals(900.0, Maturity.pace(rpc, "tipA", 1000)) }
        // Regtest mining in a burst: one second a block makes no sense, ten minutes instead.
        withNode({ m, p ->
            when (m) {
                "getblockheader" -> JSONObject().put("time", if (p.getString(0) == "tipB") 1_000_144 else 1_000_000)
                "getblockhash" -> "old"
                else -> error("unexpected $m")
            }
        }) { rpc, _ -> assertEquals(600.0, Maturity.pace(rpc, "tipB", 1000)) }
    }

    @Test fun aMinedRewardShowsItsAmountWhileMaturingAndAfter() {
        var mature = false
        withNode({ m, _ ->
            when (m) {
                "listtransactions" -> JSONArray().put(JSONObject().put("txid", "cb1").put("category", if (mature) "generate" else "immature").put("address", ""))
                "listunspent" -> JSONArray()
                "gettransaction" -> JSONObject().put("amount", if (mature) 50.0 else 0.0).put("confirmations", if (mature) 101 else 100)
                    .put("time", 1).put("generated", true)
                    .put("details", JSONArray().put(JSONObject().put("category", if (mature) "generate" else "immature").put("amount", 50.0)))
                else -> error("unexpected $m")
            }
        }) { rpc, _ ->
            val w = NodeWallet(Files.createTempDirectory("kw").toFile(), rpc, zpub, ScriptType.P2WPKH)
            assertEquals(5_000_000_000, w.transactions().single().net) // not +0 while it matures
            mature = true
            val t = w.transactions().single()
            assertEquals(5_000_000_000, t.net); assertEquals(101, t.confirmations) // looked up again once mature
        }
    }
}
