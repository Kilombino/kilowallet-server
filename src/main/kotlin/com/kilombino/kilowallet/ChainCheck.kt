package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.crypto.BlockHeader
import org.json.JSONArray
import org.json.JSONObject

/**
 * Which chain the node follows. The SHA-256 chain and the BLAKE2b chain share their history up to
 * block 961,639, so the same coins, addresses and balances show on both: a node on the wrong one
 * would make its coins look like XBT. From block 961,640 (the BLAKE2b fork) every block of the
 * BLAKE2b chain has a version-2 header of 164 bytes (bit 31 of its version set); the SHA-256
 * chain's are still the classic 80 bytes. Heights do not tell them apart (both chains are past
 * the fork), the header does.
 *
 * A node below the fork cannot be judged by its blocks yet: it is either still syncing, or stuck
 * on the last block before the fork because its Knots version does not know BLAKE2b (a node with
 * BIP-110 but without the proof-of-work change rejects the first 164-byte header and stops there).
 * While it syncs, its best header (getchaintips) may already be past the fork and tell.
 *
 * Mainnet only: regtest and testnet test runs skip it (KILOWALLET_NETWORK not "blake2b").
 */
object ChainCheck {
    /** The first BLAKE2b block on mainnet. */
    const val BLAKE2B_HEIGHT = 961_640
    /** Headers and blocks equal and this close to the fork, without passing it: stuck, not syncing. */
    const val STUCK_MARGIN = 144

    enum class State { OK, SYNCING, STUCK, WRONG_CHAIN, WRONG_NETWORK, UNKNOWN, UNREACHABLE, SKIPPED }

    /** A block the node knows: its height and its raw header (getblockheader <hash> false). */
    data class Tip(val height: Int, val headerHex: String)

    data class Result(val state: State, val height: Int = 0, val headers: Int = 0, val detail: String? = null) {
        /** Whether the wallet may use this node. */
        val ok get() = state == State.OK || state == State.SKIPPED

        fun title(): String = when (state) {
            State.OK -> "Node on the BLAKE2b chain"
            State.SKIPPED -> "Chain not checked (test network)"
            State.SYNCING -> "Your node is still syncing"
            State.STUCK -> "Your node stopped before the BLAKE2b fork"
            State.WRONG_CHAIN -> "This node follows the SHA-256 chain"
            State.WRONG_NETWORK -> "This node is not on mainnet"
            State.UNKNOWN -> "Cannot tell which chain your node follows"
            State.UNREACHABLE -> "Cannot reach your node"
        }

        fun message(): String = when (state) {
            State.OK -> "Block ${fmt(height)}."
            State.SKIPPED -> "KILOWALLET_NETWORK is not blake2b: a regtest or testnet node for tests."
            State.SYNCING -> "It is at block ${fmt(height)} of ${fmt(headers)} known so far. Kilowallet opens once the node " +
                "is past the BLAKE2b fork (block ${fmt(BLAKE2B_HEIGHT)}) and shows that it follows the BLAKE2b chain. " +
                "Nothing to do but wait; this page checks again by itself."
            State.STUCK -> "It is at block ${fmt(height)} and knows of no newer block, but the BLAKE2b chain goes on from " +
                "block ${fmt(BLAKE2B_HEIGHT)}: this node's Knots version does not follow the BLAKE2b chain. Choose a " +
                "Bitcoin Knots version with BLAKE2b in the Bitcoin Knots app, or use Knots (BLAKE2b) Companion. " +
                "If the node has only just started, wait a few minutes."
            State.WRONG_CHAIN -> "Its block ${fmt(height)} has a classic 80-byte header: the node follows the SHA-256 chain, " +
                "not Bitcoin BLAKE2b (XBT). Both chains share their history up to block ${fmt(BLAKE2B_HEIGHT - 1)}, so its " +
                "balances would look like yours without being XBT: Kilowallet does not show them and does not create, " +
                "scan or send anything on this node. It needs a node on the BLAKE2b chain: the Bitcoin Knots app " +
                "running a Knots version with BLAKE2b, or Knots (BLAKE2b) Companion."
            State.WRONG_NETWORK -> "The node runs on ${detail ?: "another network"}. Kilowallet needs a mainnet node on the " +
                "BLAKE2b chain: the Bitcoin Knots app running a Knots version with BLAKE2b, or Knots (BLAKE2b) Companion."
            State.UNKNOWN -> "The node answered with a header Kilowallet does not understand${detail?.let { " ($it)" } ?: ""}. " +
                "It needs a node on the BLAKE2b chain: the Bitcoin Knots app running a Knots version with BLAKE2b, or " +
                "Knots (BLAKE2b) Companion."
            State.UNREACHABLE -> "The node did not answer${detail?.let { ": $it" } ?: ""}. If it is starting, wait a few minutes; " +
                "this page checks again by itself."
        }

        fun json(): JSONObject = JSONObject().put("ok", ok).put("state", state.name.lowercase())
            .put("title", title()).put("message", message()).put("height", height).put("headers", headers)
    }

    /** "Chain" of a raw header: 80 bytes (SHA-256 era), 164 bytes (BLAKE2b), or null if neither. */
    fun headerSize(hex: String): Int? = runCatching { BlockHeader.parse(hex).raw.size }.getOrNull()

    /**
     * The verdict from what the node said. [chain]: getblockchaininfo's "chain"; [active]: its best
     * block; [bestHeader]: its best header when ahead of its blocks (null if none or not asked).
     */
    fun judge(chain: String, blocks: Int, headers: Int, active: Tip, bestHeader: Tip? = null): Result {
        if (chain != "main") return Result(State.WRONG_NETWORK, blocks, headers, chain)
        fun byHeader(t: Tip, onBlake2b: State): Result = when (headerSize(t.headerHex)) {
            164 -> Result(onBlake2b, blocks, headers)
            80 -> Result(State.WRONG_CHAIN, t.height, headers)
            else -> Result(State.UNKNOWN, blocks, headers, "${t.headerHex.length / 2} bytes at block ${fmt(t.height)}")
        }
        if (active.height >= BLAKE2B_HEIGHT) return byHeader(active, State.OK)
        if (bestHeader != null && bestHeader.height >= BLAKE2B_HEIGHT) return byHeader(bestHeader, State.SYNCING)
        if (headers <= blocks && blocks >= BLAKE2B_HEIGHT - STUCK_MARGIN) return Result(State.STUCK, blocks, headers)
        return Result(State.SYNCING, blocks, headers)
    }

    /** Ask the node (read-only calls only: getblockchaininfo, getblockheader, getchaintips). */
    fun check(rpc: Rpc): Result {
        val info = rpc.call("getblockchaininfo", timeoutMs = 30_000) as JSONObject
        val blocks = info.getInt("blocks"); val headers = info.optInt("headers", blocks)
        val chain = info.optString("chain", "main")
        if (chain != "main") return Result(State.WRONG_NETWORK, blocks, headers, chain)
        val active = Tip(blocks, header(rpc, info.getString("bestblockhash")))
        var best: Tip? = null
        if (blocks < BLAKE2B_HEIGHT && headers > blocks) {
            val tips = rpc.call("getchaintips", timeoutMs = 30_000) as JSONArray
            val t = (0 until tips.length()).map { tips.getJSONObject(it) }
                .filter { it.optString("status") in setOf("headers-only", "valid-headers", "active") }
                .maxByOrNull { it.getInt("height") }
            if (t != null && t.getInt("height") > blocks) best = Tip(t.getInt("height"), header(rpc, t.getString("hash")))
        }
        return judge(chain, blocks, headers, active, best)
    }

    private fun header(rpc: Rpc, hash: String): String = rpc.call("getblockheader", hash, false, timeoutMs = 30_000) as String

    private fun fmt(n: Int): String = String.format(java.util.Locale.US, "%,d", n)
}
