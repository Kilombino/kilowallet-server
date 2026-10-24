package com.kilombino.kilowallet

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** An open pool is told about once, however often its creator publishes it again. */
class CoinjoinNoticeTest {
    @Test fun eachPoolOnce() {
        val dir = Files.createTempDirectory("kwcj").toFile()
        val cj = Coinjoin(dir, Rpc("http://127.0.0.1:1/", null, null, null)) { emptyList() }
        val now = 2_000_000_000L
        assertTrue(cj.firstNotice("a", now))
        assertFalse(cj.firstNotice("a", now + 600))          // republished: someone joined
        assertTrue(cj.firstNotice("b", now + 600))
        // Survives a restart of the service.
        val again = Coinjoin(dir, Rpc("http://127.0.0.1:1/", null, null, null)) { emptyList() }
        assertFalse(again.firstNotice("a", now + 3600))
        // Forgotten after three days, longer than any pool stays open.
        assertTrue(again.firstNotice("a", now + 4 * 86400))
        dir.deleteRecursively()
    }
}
