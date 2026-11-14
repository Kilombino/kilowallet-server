package com.kilombino.pyblockwatch.chain

/**
 * This server reads the chain from its own node by RPC and has no Electrum client. The JoinBlaket
 * taker's `ElectrumChainLookup` (shared with the app) names this type; the server only ever uses
 * `RpcChainLookup`, so nothing here is ever called.
 */
class ElectrumClient private constructor() {
    data class Utxo(val txid: String, val vout: Int, val value: Long, val height: Int)
    val isOwnNode: Boolean get() = true
    fun blockHeight(): Int = unsupported()
    fun listUnspent(scriptHash: String): List<Utxo> = unsupported()
    fun transaction(txid: String): String = unsupported()
    fun blockHeader(height: Int): String = unsupported()
    private fun unsupported(): Nothing = throw UnsupportedOperationException("no Electrum client on this server: the node is read by RPC")
}
