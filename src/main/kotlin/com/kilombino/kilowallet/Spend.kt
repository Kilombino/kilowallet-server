package com.kilombino.kilowallet

import com.kilombino.pyblockwatch.crypto.Address
import com.kilombino.pyblockwatch.crypto.Bip32Priv
import com.kilombino.pyblockwatch.crypto.Bip39
import com.kilombino.pyblockwatch.crypto.Psbt
import com.kilombino.pyblockwatch.crypto.ScriptType
import com.kilombino.pyblockwatch.crypto.TxBuilder
import com.kilombino.pyblockwatch.crypto.TxParse
import kotlin.math.ceil

/**
 * Building and signing sends, with the app's own rules: fee sized for the real input type,
 * dust change folded into the fee, a second confirmation for a fee that looks like a slip, and
 * every signature with the unified sighash (0x21) so a spend cannot be replayed on SHA-256.
 */
object Spend {
    const val DUST = 546L

    /** A readable address for an output script (bc1q/bc1p/1/3), for the review. */
    fun addressOf(spk: ByteArray): String = when {
        spk.size == 22 && spk[0] == 0.toByte() -> com.kilombino.pyblockwatch.crypto.Bech32.encodeSegwit("bc", 0, spk.copyOfRange(2, 22))
        spk.size == 34 && spk[0] == 0.toByte() -> com.kilombino.pyblockwatch.crypto.Bech32.encodeSegwit("bc", 0, spk.copyOfRange(2, 34))
        spk.size == 34 && spk[0] == 0x51.toByte() -> com.kilombino.pyblockwatch.crypto.Bech32.encodeSegwit("bc", 1, spk.copyOfRange(2, 34))
        spk.size == 25 && spk[0] == 0x76.toByte() -> com.kilombino.pyblockwatch.crypto.Base58.encodeChecked(byteArrayOf(0) + spk.copyOfRange(3, 23))
        spk.size == 23 && spk[0] == 0xa9.toByte() -> com.kilombino.pyblockwatch.crypto.Base58.encodeChecked(byteArrayOf(5) + spk.copyOfRange(2, 22))
        else -> "(script)"
    }

    class Draft(
        val inputs: List<NodeWallet.Utxo>,
        val outputs: List<TxBuilder.Output>,
        val toAddress: String,
        val amount: Long,
        val fee: Long,
        val change: Long,
        val changeIndex: Int?,          // our change output's index on branch 1, if there is one
        val replaces: String? = null,   // RBF: the send this replaces
        val replacedFee: Long = 0,
        val cpfpParent: String? = null, // CPFP: the stuck transaction this child pulls along
        val packageRate: Double = 0.0,
        var psbt: ByteArray? = null,    // watch-only: the PSBT handed out, the only one taken back
        /** A cancellation (RBF): [replaces] goes back to this wallet instead of to its recipients. */
        val cancels: Boolean = false,
        /** A cancellation: the outputs of the payment it cancels (addresses), which will never exist. */
        val cancelled: List<String> = emptyList(),
        /** A send to several recipients: each (address, sats), the first being [toAddress]; empty for one. */
        val recipients: List<Pair<String, Long>> = emptyList(),
    ) {
        val id: String = java.util.UUID.randomUUID().toString()
        val vbytes: Double get() = vsize(inputs, outputs.map { it.scriptPubKey })
        /** The wallet's own type (a watch-only wallet's PSBT); each input signs with its own [NodeWallet.Utxo.type]. */
        var type: ScriptType = ScriptType.P2WPKH
        /** The account [changeIndex] belongs to (a hot wallet has a bc1q and a bc1p one). */
        var changeType: ScriptType = ScriptType.P2WPKH
    }

    private fun inputVbytes(t: ScriptType) = when (t) {
        ScriptType.P2WPKH -> 68.0; ScriptType.P2SH_P2WPKH -> 91.0; ScriptType.P2TR -> 57.75; ScriptType.P2PKH -> 148.0
    }

    fun vsize(nIn: Int, outs: List<ByteArray>, t: ScriptType): Double = 10.5 + inputVbytes(t) * nIn + outs.sumOf { 9.0 + it.size }

    /** Each input weighs what its own type does: bc1q and bc1p coins can go out together. */
    fun vsize(ins: List<NodeWallet.Utxo>, outs: List<ByteArray>): Double =
        10.5 + ins.sumOf { inputVbytes(it.type) } + outs.sumOf { 9.0 + it.size }

    private fun fee(ins: List<NodeWallet.Utxo>, outs: List<ByteArray>, rate: Double) = ceil(vsize(ins, outs) * rate).toLong()

    /**
     * Send [amount] (everything, less the fee, when null) to [to] at [rate] sat/vB from [chosen]
     * coins, or from the largest coins first when none are chosen.
     */
    /**
     * [changeTo]: the account the change goes to (the wallet's own, or the pool's for the payment
     * that makes a perfect coin, as the app since 1.2.5).
     */
    fun plan(w: NodeWallet, utxos: List<NodeWallet.Utxo>, chosen: Set<String>, to: String, amount: Long?, rate: Double,
             changeTo: NodeWallet = w,
             /** More recipients (address, sats) after [to], as the app's multi-recipient SEND: one transaction for all. */
             extra: List<Pair<String, Long>> = emptyList()): Draft =
        planRaw(w, utxos, chosen, to, amount, rate, changeTo, extra).also { it.changeType = changeTo.type }

    private fun recipientScript(to: String): ByteArray {
        val s = runCatching { Address.decodeToScriptPubKey(to.trim()) }.getOrElse { error("That is not a valid address: ${to.trim()}") }
        require(s.isNotEmpty() && s[0] != 0x6a.toByte()) { "That address can't receive." }
        return s
    }

    private fun planRaw(w: NodeWallet, utxos: List<NodeWallet.Utxo>, chosen: Set<String>, to: String, amount: Long?, rate: Double,
                        changeTo: NodeWallet, extra: List<Pair<String, Long>>): Draft {
        require(rate in 0.1..1000.0) { "The fee rate must be between 0.1 and 1000 sat/vB." }
        val toScript = recipientScript(to)
        require(amount != null || extra.isEmpty()) { "MAX sends everything to one recipient: remove the others, or type the amounts." }
        require(extra.size < 50) { "Too many recipients for one send." }
        val extraOuts = extra.map { (a, v) ->
            require(v > DUST) { "The amount for ${a.trim()} is too small to send." }
            TxBuilder.Output(recipientScript(a), v)
        }
        val scripts = listOf(toScript) + extraOuts.map { it.scriptPubKey }
        require(scripts.map { it.toList() }.toSet().size == scripts.size) { "The same address twice: put it once with the whole amount." }
        val recipients = if (extra.isEmpty()) emptyList() else listOf(to.trim() to (amount ?: 0L)) + extra.map { it.first.trim() to it.second }
        val pool = if (chosen.isEmpty()) utxos else utxos.filter { it.outpoint in chosen }
        require(pool.isNotEmpty()) { if (chosen.isEmpty()) "No coins to spend yet." else "Pick at least one coin." }
        val (changeIndex, changeScript) = changeTo.peekChange()
        if (amount == null) {
            val f = fee(pool, listOf(toScript), rate)
            val send = pool.sumOf { it.value } - f
            require(send > DUST) { "These coins do not cover the fee." }
            return Draft(pool, listOf(TxBuilder.Output(toScript, send)), to.trim(), send, f, 0, null).also { it.type = w.type }
        }
        require(amount > DUST) { "The amount is too small to send." }
        val total = amount + extraOuts.sumOf { it.value }
        val outs = listOf(TxBuilder.Output(toScript, amount)) + extraOuts
        val picked = if (chosen.isNotEmpty()) pool else {
            val acc = mutableListOf<NodeWallet.Utxo>(); var s = 0L
            for (u in pool) { acc += u; s += u.value; if (s >= total + fee(acc, scripts + listOf(changeScript), rate)) break }
            acc
        }
        val sum = picked.sumOf { it.value }
        val fWith = fee(picked, scripts + listOf(changeScript), rate)
        val change = sum - total - fWith
        if (change > DUST) return Draft(picked, outs + TxBuilder.Output(changeScript, change),
            to.trim(), total, fWith, change, changeIndex, recipients = recipients).also { it.type = w.type }
        val fNo = fee(picked, scripts, rate)
        require(sum - total >= fNo) { "Not enough funds for $total sats plus the fee." }
        return Draft(picked, outs, to.trim(), total, sum - total, 0, null, recipients = recipients).also { it.type = w.type }
    }

    /** RBF: the same inputs and recipients, the extra fee taken from our change. */
    fun bump(w: NodeWallet, txid: String, rate: Double, ours: Map<String, Pair<Int, Int>>, types: Map<String, ScriptType> = emptyMap()): Draft {
        val tx = TxParse.parse(w.rawTx(txid))
        val inputs = tx.inputs.map { i ->
            val prev = TxParse.parse(w.rawTx(i.txid)).outputs[i.vout]
            val h = com.kilombino.pyblockwatch.crypto.Hashes.run { prev.scriptPubKey.toHex() }
            val (b, idx) = ours[h]
                ?: error("This transaction spends coins that are not in this wallet: it can't be replaced from here.")
            NodeWallet.Utxo(i.txid, i.vout, prev.value, 0, b, idx, types[h] ?: w.type)
        }
        val outs = tx.outputs.map { TxBuilder.Output(it.scriptPubKey, it.value) }
        val hex = { o: TxBuilder.Output -> com.kilombino.pyblockwatch.crypto.Hashes.run { o.scriptPubKey.toHex() } }
        val changeAt = outs.indices.filter { ours[hex(outs[it])]?.first == 1 }.maxByOrNull { outs[it].value }
            ?: error("This send has no change output to pay a higher fee from.")
        val oldFee = inputs.sumOf { it.value } - outs.sumOf { it.value }
        val newFee = maxOf(fee(inputs, outs.map { it.scriptPubKey }, rate),
            oldFee + fee(inputs, outs.map { it.scriptPubKey }, 1.0) + 1)
        val change = outs[changeAt].value - (newFee - oldFee)
        require(change > DUST) { "The change (${outs[changeAt].value} sats) can't cover the new fee of $newFee sats." }
        val newOuts = outs.mapIndexed { n, o -> if (n == changeAt) o.copy(value = change) else o }
        val sent = newOuts.filterIndexed { n, _ -> n != changeAt }
        return Draft(inputs, newOuts, sent.firstOrNull()?.let { addressOf(it.scriptPubKey) } ?: "(replacement)",
            sent.sumOf { it.value }, newFee, change, ours[hex(outs[changeAt])]?.second,
            replaces = txid, replacedFee = oldFee).also { it.type = w.type; it.changeType = types[hex(outs[changeAt])] ?: w.type }
    }

    /**
     * Cancel unconfirmed send [txid] (RBF, as the app since 1.2.5): the same coins, all of them, to
     * one fresh change address of this wallet ([backTo]: the account of the first coin), so the
     * recipients get nothing. Like a speed-up it pays the old fee plus 1 sat/vB of its own size
     * (and at least [rate]). If the original confirms first, the node refuses the replacement.
     */
    fun cancel(w: NodeWallet, txid: String, rate: Double, ours: Map<String, Pair<Int, Int>>, types: Map<String, ScriptType>,
               backTo: (ScriptType) -> NodeWallet): Draft {
        val tx = TxParse.parse(w.rawTx(txid))
        val inputs = tx.inputs.map { i ->
            val prev = TxParse.parse(w.rawTx(i.txid)).outputs[i.vout]
            val h = com.kilombino.pyblockwatch.crypto.Hashes.run { prev.scriptPubKey.toHex() }
            val (b, idx) = ours[h]
                ?: error("This transaction spends coins that are not in this wallet: it can't be cancelled from here.")
            NodeWallet.Utxo(i.txid, i.vout, prev.value, 0, b, idx, types[h] ?: w.type)
        }
        val back = backTo(inputs.first().type)
        val (ci, to) = back.peekChange()
        val oldFee = inputs.sumOf { it.value } - tx.outputs.sumOf { it.value }
        val newFee = maxOf(fee(inputs, listOf(to), rate.coerceIn(0.1, 1000.0)), oldFee + fee(inputs, listOf(to), 1.0) + 1)
        val value = inputs.sumOf { it.value } - newFee
        require(value > DUST) { "The coins (${inputs.sumOf { it.value }} sats) can't cover a $newFee-sat fee." }
        return Draft(inputs, listOf(TxBuilder.Output(to, value)), addressOf(to), value, newFee, 0, ci,
            replaces = txid, replacedFee = oldFee, cancels = true, cancelled = tx.outputs.map { addressOf(it.scriptPubKey) })
            .also { it.type = w.type; it.changeType = back.type }
    }

    /** CPFP: spend our outputs of a stuck transaction back to ourselves so both pay [rate] together. */
    fun cpfp(w: NodeWallet, txid: String, rate: Double, utxos: List<NodeWallet.Utxo>): Draft {
        val raw = w.rawTx(txid)
        val tx = TxParse.parse(raw)
        val parentVsize = TxParse.vsize(raw)
        val parentFee = tx.inputs.sumOf { i -> TxParse.parse(w.rawTx(i.txid)).outputs[i.vout].value } - tx.outputs.sumOf { it.value }
        val ours = utxos.filter { it.txid == txid }
        require(ours.isNotEmpty()) { "This transaction has no unspent output of this wallet to speed it up with." }
        val (changeIndex, to) = w.peekChange()
        val childVsize = vsize(ours, listOf(to))
        val need = ceil(rate.coerceIn(1.0, 1000.0) * (parentVsize + childVsize)).toLong() - parentFee
        require(need > childVsize) {
            "It already pays ${"%.1f".format(java.util.Locale.ROOT, parentFee.toDouble() / parentVsize)} sat/vB: choose a higher rate than that."
        }
        val sum = ours.sumOf { it.value }
        require(sum - need > DUST) { "Your part of it ($sum sats) can't cover a $need-sat fee." }
        return Draft(ours, listOf(TxBuilder.Output(to, sum - need)), addressOf(to), sum - need, need, sum - need, changeIndex,
            cpfpParent = txid, packageRate = (parentFee + need) / (parentVsize + childVsize)).also { it.type = w.type; it.changeType = w.type }
    }

    /** A fee that looks like a slip (the app's rule): above 100 sat/vB, 100 000 sats, or 5% of the amount. */
    fun concern(d: Draft): String? {
        val rate = d.fee / d.vbytes
        val sent = if (d.cpfpParent != null) d.amount + d.fee else d.amount
        val reasons = buildList {
            if (rate > 100) add("%.0f sat/vB".format(java.util.Locale.ROOT, rate))
            if (d.fee > 100_000) add("${d.fee} sats")
            if (sent > 0 && d.fee * 100 > sent * 5) add("${d.fee * 100 / sent}% of the amount")
        }
        return if (reasons.isEmpty()) null else "This fee is high: " + reasons.joinToString(", ") + "."
    }

    private fun purpose(t: ScriptType) = when (t) { ScriptType.P2WPKH -> 84; ScriptType.P2SH_P2WPKH -> 49; ScriptType.P2TR -> 86; ScriptType.P2PKH -> 44 }

    fun master(secret: Vault.Secret) = Bip32Priv.fromSeed(Bip39.toSeed(secret.words, secret.passphrase))

    fun accountKey(secret: Vault.Secret, t: ScriptType) = Bip32Priv.accountXpub(master(secret), purpose = purpose(t), account = 0)

    /** Hot wallet: sign every input (unified sighash, Core's low-R grind) and give back the raw transaction. */
    fun sign(secret: Vault.Secret, d: Draft): TxBuilder.Signed {
        val m = master(secret)
        val inputs = d.inputs.map { u ->
            // Each coin with its own account's key: BIP-84, or BIP-86 for a Taproot one.
            val k = Bip32Priv.derivePath(m, "m/${purpose(u.type)}'/0'/0'/${u.branch}/${u.index}")
            TxBuilder.Input(u.txid, u.vout, u.value, k.key, k.publicKey(), 0xfffffffdL, u.type)
        }
        return TxBuilder.build(inputs, d.outputs, unified = true, grindLowR = true)
    }

    // ------------------------------------------------------------------ watch-only: PSBT

    private fun coins(w: NodeWallet, d: Draft, origin: Psbt.Origin?) = d.inputs.map { u ->
        Psbt.Coin(u.txid, u.vout, u.value, d.type, w.pubkey(u.branch, u.index), origin?.child(u.branch, u.index))
    }

    fun psbt(w: NodeWallet, d: Draft, originText: String): ByteArray {
        require(d.type != ScriptType.P2PKH) { "Signing elsewhere works for SegWit (bc1q), nested SegWit (3…) and Taproot (bc1p) wallets." }
        val o = Psbt.Origin.parse(originText)
        val change = d.changeIndex?.let { ci ->
            val n = d.outputs.indexOfFirst { it.scriptPubKey.contentEquals(w.script(1, ci)) }
            if (n < 0) emptyMap() else mapOf(n to Psbt.Change(w.pubkey(1, ci), d.type, o?.child(1, ci)))
        } ?: emptyMap()
        return Psbt.create(coins(w, d, o), d.outputs, change).also { d.psbt = it }
    }

    fun finishPsbt(w: NodeWallet, d: Draft, returned: ByteArray, originText: String): TxBuilder.Signed =
        Psbt.finish(d.psbt ?: error("Export the PSBT first."), returned, coins(w, d, Psbt.Origin.parse(originText)), d.outputs)
}
