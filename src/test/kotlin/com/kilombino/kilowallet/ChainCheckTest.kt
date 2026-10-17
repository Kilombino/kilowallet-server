package com.kilombino.kilowallet

import com.kilombino.kilowallet.ChainCheck.State
import com.kilombino.kilowallet.ChainCheck.Tip
import com.sun.net.httpserver.HttpServer
import org.json.JSONArray
import org.json.JSONObject
import java.net.InetSocketAddress
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Which chain the node follows, from real mainnet headers of both chains. */
class ChainCheckTest {
    companion object {
        /** Block 961,639, the last one both chains share (80 bytes). */
        const val PRE_FORK = "10000a205fca17a6566978303e989d163e1aa9dc6715eef5542e0000000000000000000080fe52c98f1c1f8484213dff5a88315f7c334d0705f7d79579b289781868c0dff5c1916a3d350217510c87ed"
        /** Block 961,640 of the BLAKE2b chain (164 bytes, version bit 31 set). */
        const val BLAKE2B = "000000a0657e02138733654183a2c7320d85ca9d743fe139c4bb01000000000000000000c137a8515a0f6b3aaf6049cc7611787c022ad523d51094be0a0363d0dc0bc7684dca936a4f8d001a5671798c84daeb494dca936a00000000b1ccf00d0300000000000000000000001e0300000000000000000000000000000000000068ac0e000000000000000000000000000000000000000000000000000000000000000000"
        /** Block 961,640 of the SHA-256 chain (80 bytes). */
        const val SHA256 = "00c0cd2f5020e5d6a59cf5acc8ab25e86ded4c3528c5216205ca01000000000000000000317c696ea6df187e55b05be2146a5afffa3d3f7d9c23c8cec147d52d9f8b3e0ea6a6776a3d35021742202ecb"
        const val FORK = ChainCheck.BLAKE2B_HEIGHT
    }

    @Test fun headerSizesOfBothChains() {
        assertEquals(80, ChainCheck.headerSize(PRE_FORK))
        assertEquals(80, ChainCheck.headerSize(SHA256))
        assertEquals(164, ChainCheck.headerSize(BLAKE2B))
        assertEquals(null, ChainCheck.headerSize("00"))
        // 164 bytes without the version bit (or 80 with it) is no header of either chain.
        assertEquals(null, ChainCheck.headerSize("00000020" + BLAKE2B.substring(8)))
        assertEquals(null, ChainCheck.headerSize("000000a0" + SHA256.substring(8)))
    }

    @Test fun aBlake2bTipIsTheRightChain() {
        val r = ChainCheck.judge("main", 977_688, 977_688, Tip(977_688, BLAKE2B))
        assertEquals(State.OK, r.state); assertTrue(r.ok)
    }

    @Test fun anEightyByteTipPastTheForkIsTheSha256Chain() {
        val r = ChainCheck.judge("main", 971_834, 971_834, Tip(971_834, SHA256))
        assertEquals(State.WRONG_CHAIN, r.state); assertFalse(r.ok)
        assertTrue("SHA-256 chain" in r.message())
        assertEquals(false, r.json().getBoolean("ok"))
        assertEquals("wrong_chain", r.json().getString("state"))
    }

    @Test fun exactlyAtTheForkTheHeaderDecides() {
        assertEquals(State.OK, ChainCheck.judge("main", FORK, FORK, Tip(FORK, BLAKE2B)).state)
        assertEquals(State.WRONG_CHAIN, ChainCheck.judge("main", FORK, FORK, Tip(FORK, SHA256)).state)
    }

    @Test fun belowTheForkWhileSyncingItCannotBeJudgedYet() {
        val r = ChainCheck.judge("main", 500_000, 0, Tip(500_000, PRE_FORK))
        assertEquals(State.SYNCING, r.state); assertFalse(r.ok)
        assertEquals(State.SYNCING, ChainCheck.judge("main", 961_600, 961_620, Tip(961_600, PRE_FORK)).state)
    }

    @Test fun belowTheForkTheBestHeaderTellsEarly() {
        assertEquals(State.SYNCING, ChainCheck.judge("main", 800_000, 977_688, Tip(800_000, PRE_FORK), Tip(977_688, BLAKE2B)).state)
        assertEquals(State.WRONG_CHAIN, ChainCheck.judge("main", 800_000, 971_834, Tip(800_000, PRE_FORK), Tip(971_834, SHA256)).state)
    }

    @Test fun stoppedOnTheLastSharedBlockIsAKnotsWithoutBlake2b() {
        val r = ChainCheck.judge("main", FORK - 1, FORK - 1, Tip(FORK - 1, PRE_FORK))
        assertEquals(State.STUCK, r.state); assertFalse(r.ok)
        assertTrue("does not follow the BLAKE2b chain" in r.message())
        assertTrue("block 961,639" in r.message()) // English digits whatever the server's locale
    }

    @Test fun anotherNetworkIsRefused() {
        val r = ChainCheck.judge("test", 100, 100, Tip(100, PRE_FORK))
        assertEquals(State.WRONG_NETWORK, r.state); assertFalse(r.ok)
    }

    @Test fun aHeaderOfNeitherChainIsNotTrusted() {
        assertEquals(State.UNKNOWN, ChainCheck.judge("main", 977_688, 977_688, Tip(977_688, "00".repeat(100))).state)
    }

    // ------------------------------------------------------------------ against a fake node, over RPC

    /** A node that answers the three read-only calls the check makes (and nothing else). */
    private fun withNode(info: JSONObject, headers: Map<String, String>, tips: JSONArray, block: (Rpc, MutableList<String>) -> Unit) {
        val calls = mutableListOf<String>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val req = JSONObject(ex.requestBody.bufferedReader().readText())
            val method = req.getString("method"); calls += method
            val result: Any = when (method) {
                "getblockchaininfo" -> info
                "getblockheader" -> headers.getValue(req.getJSONArray("params").getString(0))
                "getchaintips" -> tips
                else -> error("unexpected call $method")
            }
            val body = JSONObject().put("result", result).put("error", JSONObject.NULL).put("id", "kilowallet").toString().toByteArray()
            ex.sendResponseHeaders(200, body.size.toLong()); ex.responseBody.use { it.write(body) }
        }
        server.start()
        try { block(Rpc("http://127.0.0.1:${server.address.port}/", "u", "p", null), calls) } finally { server.stop(0) }
    }

    private fun info(blocks: Int, headers: Int, best: String, chain: String = "main") =
        JSONObject().put("chain", chain).put("blocks", blocks).put("headers", headers).put("bestblockhash", best)

    @Test fun overRpcABlake2bNode() = withNode(info(977_688, 977_688, "aa"), mapOf("aa" to BLAKE2B), JSONArray()) { rpc, calls ->
        assertEquals(State.OK, ChainCheck.check(rpc).state)
        assertEquals(listOf("getblockchaininfo", "getblockheader"), calls)
    }

    @Test fun overRpcASha256Node() = withNode(info(971_834, 971_834, "bb"), mapOf("bb" to SHA256), JSONArray()) { rpc, _ ->
        assertEquals(State.WRONG_CHAIN, ChainCheck.check(rpc).state)
    }

    @Test fun overRpcASyncingNodeIsJudgedByItsBestHeader() {
        val tips = JSONArray()
            .put(JSONObject().put("height", 800_000).put("hash", "cc").put("status", "active"))
            .put(JSONObject().put("height", 977_688).put("hash", "dd").put("status", "headers-only"))
            .put(JSONObject().put("height", 977_700).put("hash", "ee").put("status", "invalid"))
        withNode(info(800_000, 977_688, "cc"), mapOf("cc" to PRE_FORK, "dd" to BLAKE2B), tips) { rpc, calls ->
            assertEquals(State.SYNCING, ChainCheck.check(rpc).state)
            assertEquals(listOf("getblockchaininfo", "getblockheader", "getchaintips", "getblockheader"), calls)
        }
        withNode(info(800_000, 971_834, "cc"), mapOf("cc" to PRE_FORK, "dd" to SHA256), tips.also { it.remove(2) }) { rpc, _ ->
            assertEquals(State.WRONG_CHAIN, ChainCheck.check(rpc).state)
        }
    }

    @Test fun overRpcARegtestNodeOnMainnetSettingsIsRefused() = withNode(info(101, 101, "ff", "regtest"), emptyMap(), JSONArray()) { rpc, _ ->
        assertEquals(State.WRONG_NETWORK, ChainCheck.check(rpc).state)
    }
}
