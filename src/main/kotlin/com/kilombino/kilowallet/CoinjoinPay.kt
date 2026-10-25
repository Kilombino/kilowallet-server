package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.coinjoin.CoinjoinTx
import com.kilombino.pyblockwatch.coinjoin.Protocol
import com.kilombino.pyblockwatch.crypto.Address
import com.kilombino.pyblockwatch.crypto.ScriptType

/**
 * Paying through a coinjoin from SEND, as the app since 1.2.7 (its `CoinjoinPayment`, whose
 * Android parts don't come here): when every recipient gets the same amount, a pool of equal
 * outputs whose outputs for us go straight to the recipients (Kilojoin v4, or v3 with one); with
 * different amounts (or by choice) a payment pool, Kilojoin v5: the others put in the same total
 * and get it back in equal outputs. Nothing is paid until the pool closes.
 *
 * The recipients' addresses are theirs: never derived, reserved or watched as this wallet's.
 */
object CoinjoinPay {
    /** One address type for every recipient: what a pool can never mix. */
    const val NEEDS = "Needs one address type (all bc1q or all bc1p)."

    /**
     * Whether the recipients fit a pool: [type] when they do. [ok]: all the same [amount], a pool of
     * equal outputs; [paymentOk]: a payment pool of their [amounts] (v5); else [reason] says why
     * neither (as shown).
     */
    class Check(val type: ScriptType?, val amount: Long, val scripts: List<ByteArray>, val reason: String?,
                val amounts: List<Long> = emptyList(), val paymentOk: Boolean = false) {
        val ok: Boolean get() = reason == null && amount > 0
        val any: Boolean get() = ok || paymentOk
    }

    /**
     * Whether [recipients] (address, sats: the first one and the extra ones of SEND) can be paid by
     * one pool: 1 to [Protocol.MAX_OUTPUTS] of them, all plain native SegWit (bc1q) or all Taproot
     * (bc1p), none twice; the same amount within the pool's limits, or (v5) any amounts above dust
     * adding up to a pool's. [taprootOk]: this wallet has a Taproot account.
     */
    fun check(recipients: List<Pair<String, Long>>, taprootOk: Boolean, minAmount: Long = Protocol.MIN_AMOUNT): Check {
        fun no(reason: String) = Check(null, 0, emptyList(), reason)
        if (recipients.isEmpty()) return no(NEEDS)
        if (recipients.size > Protocol.MAX_OUTPUTS) return no("A pool gives at most ${Protocol.MAX_OUTPUTS} outputs: ${Protocol.MAX_OUTPUTS} recipients at most.")
        val amount = recipients.first().second
        val scripts = recipients.map { (a, _) ->
            val t = a.trim()
            if (t.contains("@") || t.lowercase().startsWith("sp1")) return no("Only plain bc1q or bc1p addresses can be paid through a coinjoin.")
            runCatching { Address.decodeToScriptPubKey(t) }.getOrNull() ?: return no(NEEDS)
        }
        val type = when {
            scripts.all { CoinjoinTx.isType(it, ScriptType.P2WPKH) } -> ScriptType.P2WPKH
            scripts.all { CoinjoinTx.isType(it, ScriptType.P2TR) } -> ScriptType.P2TR
            else -> return no(NEEDS)
        }
        if (type == ScriptType.P2TR && !taprootOk) return no("Taproot recipients need a Taproot pool: unlock the wallet once to set up its Taproot account.")
        if (scripts.map { it.toList() }.toSet().size != scripts.size) return no("The same address twice: every output of a pool is a different address.")
        val amounts = recipients.map { it.second }
        val total = amounts.sum()
        // A payment pool (v5): any amounts above dust, all of them together within a pool's limits.
        val paymentOk = amounts.all { it >= Protocol.MIN_PAYMENT } && total in minAmount..Protocol.MAX_AMOUNT
        // The same amount to everyone (a v4 pool): each a pool's output, all of them together a person's minimum.
        val equal = amounts.all { it == amount } && amount in Protocol.TEST_MIN_AMOUNT..Protocol.MAX_AMOUNT && total >= minAmount
        // Short of a pool's minimum is the usual case, while the amounts are still being typed: say how short.
        if (!equal && !paymentOk && total < minAmount && amounts.all { it >= Protocol.MIN_PAYMENT }) return Check(type, 0, scripts,
            "Together they add up to $total sats: a pool needs at least $minAmount sats in all.", amounts, false)
        if (!equal && !paymentOk) return Check(type, 0, scripts,
            "Each payment must be at least ${Protocol.MIN_PAYMENT} sats, and all of them together $minAmount to ${Protocol.MAX_AMOUNT} sats.",
            amounts, false)
        return Check(type, if (equal) amount else 0, scripts, null, amounts, paymentOk)
    }
}
