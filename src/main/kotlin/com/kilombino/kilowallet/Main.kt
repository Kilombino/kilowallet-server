package com.kilombino.kilowallet

import java.io.File

/**
 * Kilowallet for a home node: the app's wallet, reading the chain from the node itself (no
 * Electrum server). Configuration from the environment, filled in by the StartOS package:
 *   KILOWALLET_DATA    data directory (default /data)
 *   KILOWALLET_PORT    web port (default 8080)
 *   BITCOIN_RPC_URL    e.g. http://bitcoind.startos:8332/
 *   BITCOIN_RPC_USER / BITCOIN_RPC_PASS, or BITCOIN_RPC_COOKIE (path to .cookie)
 *   KILOWALLET_NETWORK coinjoin network name (default blake2b; tests use another, so their
 *                      pools never list on mainnet)
 */
fun main() {
    val env = System.getenv()
    env["KILOWALLET_NETWORK"]?.let { com.kilombino.pyblockwatch.coinjoin.Protocol.NETWORK = it }
    val dir = File(env["KILOWALLET_DATA"] ?: "/data").apply { mkdirs() }
    val rpc = Rpc(env["BITCOIN_RPC_URL"] ?: "http://127.0.0.1:8332/", env["BITCOIN_RPC_USER"], env["BITCOIN_RPC_PASS"], env["BITCOIN_RPC_COOKIE"])
    val port = (env["KILOWALLET_PORT"] ?: "8080").toInt()
    val web = Web(dir, rpc, port)
    web.coinjoin.onEvent = { e -> System.err.println("EVENT ${e.title}: ${e.text}") }
    web.start()
    System.err.println("Kilowallet listening on $port, node ${env["BITCOIN_RPC_URL"] ?: "http://127.0.0.1:8332/"}")
}
