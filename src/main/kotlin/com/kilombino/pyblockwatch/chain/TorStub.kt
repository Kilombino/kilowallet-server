package com.kilombino.pyblockwatch.chain

/**
 * This server has no Tor of its own: the shared relay code asks this stub and connects directly
 * (on StartOS the box's own network settings decide the route).
 */
internal object Tor {
    val running: Boolean = false
    fun proxy(waitMs: Long = 0): java.net.Proxy? = null
}
