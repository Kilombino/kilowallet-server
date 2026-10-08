package com.kilombino.kilowallet

import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * The seed words on disk: AES-256-GCM under a key derived from the owner's password
 * (PBKDF2-HMAC-SHA256, 600 000 rounds). Without the password the file is useless, so a stolen
 * disk or backup does not give the coins away. The words live in memory only while unlocked.
 */
class Vault(dir: File) {
    private val file = File(dir, "vault.json")
    private val rounds = 600_000

    class WrongPassword : Exception("Wrong password.")
    class Secret(val words: List<String>, val passphrase: String)

    fun exists(): Boolean = file.exists()

    private fun key(password: String, salt: ByteArray): SecretKeySpec {
        val spec = PBEKeySpec(password.toCharArray(), salt, rounds, 256)
        val raw = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
        spec.clearPassword()
        return SecretKeySpec(raw, "AES")
    }

    fun store(words: List<String>, passphrase: String, password: String) {
        require(password.length >= 8) { "Use a password of at least 8 characters." }
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key(password, salt)) }
        val plain = JSONObject().put("words", words.joinToString(" ")).put("passphrase", passphrase).toString()
        val ct = c.doFinal(plain.toByteArray())
        val b64 = Base64.getEncoder()
        val tmp = File(file.parentFile, "vault.json.tmp")
        tmp.writeText(JSONObject().put("v", 1).put("kdf", "pbkdf2-sha256").put("rounds", rounds)
            .put("salt", b64.encodeToString(salt)).put("iv", b64.encodeToString(c.iv))
            .put("ct", b64.encodeToString(ct)).toString())
        tmp.renameTo(file)
    }

    fun open(password: String): Secret {
        val o = JSONObject(file.readText())
        val b64 = Base64.getDecoder()
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(password, b64.decode(o.getString("salt"))), GCMParameterSpec(128, b64.decode(o.getString("iv"))))
        val plain = try { c.doFinal(b64.decode(o.getString("ct"))) } catch (e: AEADBadTagException) { throw WrongPassword() }
        val j = JSONObject(String(plain))
        return Secret(j.getString("words").split(" "), j.optString("passphrase", ""))
    }
}
