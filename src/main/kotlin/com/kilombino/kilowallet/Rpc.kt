package com.kilombino.kilowallet

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64

/**
 * JSON-RPC to the node (Bitcoin Knots with BLAKE2b, the BTC chain). Credentials are either a
 * user/password pair or a cookie file, read again on every call because the node rewrites the
 * cookie each time it starts.
 */
class Rpc(private val url: String, private val user: String?, private val pass: String?, private val cookie: String?) {

    class RpcError(val code: Int, message: String) : Exception(message)

    private fun auth(): String {
        val pair = if (cookie != null) File(cookie).readText().trim() else "${user ?: ""}:${pass ?: ""}"
        return "Basic " + Base64.getEncoder().encodeToString(pair.toByteArray())
    }

    fun call(method: String, vararg params: Any?, timeoutMs: Int = 60_000, wallet: String? = null): Any? {
        val target = if (wallet == null) url else url.trimEnd('/') + "/wallet/" + java.net.URLEncoder.encode(wallet, "UTF-8")
        val c = URL(target).openConnection() as HttpURLConnection
        c.requestMethod = "POST"; c.doOutput = true
        c.connectTimeout = 15_000; c.readTimeout = timeoutMs
        c.setRequestProperty("Authorization", auth())
        c.setRequestProperty("Content-Type", "application/json")
        val body = JSONObject().put("jsonrpc", "1.0").put("id", "kilowallet").put("method", method)
            .put("params", JSONArray().also { a -> params.forEach { a.put(it ?: JSONObject.NULL) } })
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        val code = c.responseCode
        val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() }
            ?: throw RpcError(code, "HTTP $code from the node")
        c.disconnect()
        if (code == 401) throw RpcError(401, "the node refused the RPC credentials")
        val o = JSONObject(text)
        if (!o.isNull("error")) {
            val e = o.getJSONObject("error")
            throw RpcError(e.optInt("code"), e.optString("message"))
        }
        return o.opt("result")
    }

    fun height(): Int = (call("getblockcount") as Number).toInt()

    /** Fee estimate in sat/vB for confirmation within [blocks], at least 1. */
    fun feeRate(blocks: Int = 3): Double = runCatching {
        val r = call("estimatesmartfee", blocks) as JSONObject
        maxOf(1.0, r.getDouble("feerate") * 100_000.0)
    }.getOrDefault(2.0)

    /** The node's estimate in sat/vB for the next [blocks], or null when it has none (a quiet mempool). */
    fun feeEstimate(blocks: Int = 3): Double? = runCatching {
        val r = call("estimatesmartfee", blocks) as JSONObject
        if (r.has("feerate")) r.getDouble("feerate") * 100_000.0 else null
    }.getOrNull()

    /** The output, or null when it is spent or unknown (mempool included). */
    fun txOut(txid: String, vout: Int): JSONObject? = call("gettxout", txid, vout, true) as? JSONObject
}
