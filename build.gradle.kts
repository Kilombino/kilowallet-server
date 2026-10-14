import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.3.10"
}

group = "com.kilombino.kilowallet"
version = "0.4.2"

kotlin {
    jvmToolchain(17)
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

// The wallet's own code, from the Kilowallet submodule: one source of truth, so the server and
// the app derive the same addresses and sign the same way (unified sighash 0x21, PSBT checks).
sourceSets {
    main {
        kotlin {
            srcDir("src/main/kotlin")
            srcDir("kilowallet/app/src/main/java")
            include("com/kilombino/kilowallet/**")
            include("com/kilombino/pyblockwatch/crypto/**")
            include("com/kilombino/pyblockwatch/ark/ArkNativeStub.kt") // no Ark engine library here: Kotlin signing
            // Coinjoin: the app's own protocol code, so this server meets phones and Kilojoin nodes in the same pools.
            include("com/kilombino/pyblockwatch/coinjoin/CoinjoinTx.kt")
            include("com/kilombino/pyblockwatch/coinjoin/Nip44.kt")
            include("com/kilombino/pyblockwatch/coinjoin/NostrEvent.kt")
            include("com/kilombino/pyblockwatch/coinjoin/PoolSession.kt")
            include("com/kilombino/pyblockwatch/coinjoin/Protocol.kt")
            include("com/kilombino/pyblockwatch/coinjoin/RelayClient.kt")
        }
    }
}

dependencies {
    implementation("org.json:json:20240303")
    testImplementation(kotlin("test"))
}

tasks.test { useJUnitPlatform() }

// One self-contained jar for the container.
tasks.register<Jar>("fatJar") {
    archiveFileName.set("kilowallet-server.jar")
    manifest { attributes["Main-Class"] = "com.kilombino.kilowallet.MainKt" }
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(sourceSets.main.get().output)
    from(configurations.runtimeClasspath.get().map { if (it.isDirectory) it else zipTree(it) })
    isPreserveFileTimestamps = false
    isReproducibleFileOrder = true
}
