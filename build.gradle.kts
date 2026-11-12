import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.3.10"
}

group = "com.kilombino.kilowallet"
version = "0.10.5"

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
            include("com/kilombino/pyblockwatch/chain/TorStub.kt") // no Tor here: the relay directly
            // Coinjoin: the app's own protocol code, so this server meets phones and Kilojoin nodes in the same pools.
            include("com/kilombino/pyblockwatch/coinjoin/BlindRsa.kt")
            include("com/kilombino/pyblockwatch/coinjoin/CoinjoinTx.kt")
            include("com/kilombino/pyblockwatch/coinjoin/Nip44.kt")
            include("com/kilombino/pyblockwatch/coinjoin/NostrEvent.kt")
            include("com/kilombino/pyblockwatch/coinjoin/PoolSession.kt")
            include("com/kilombino/pyblockwatch/coinjoin/Protocol.kt")
            include("com/kilombino/pyblockwatch/coinjoin/RelayClient.kt")
            include("com/kilombino/pyblockwatch/data/JoinMarket.kt")
        }
    }
    test {
        kotlin {
            srcDir("src/test/kotlin")
            // The app's own coinjoin tests that need nothing of Android: a local relay and the async rounds (Kilojoin v6).
            srcDir("kilowallet/app/src/test/java")
            include("com/kilombino/kilowallet/**")
            include("com/kilombino/pyblockwatch/coinjoin/TestRelay.kt")
            include("com/kilombino/pyblockwatch/coinjoin/TestChain.kt")
            include("com/kilombino/pyblockwatch/coinjoin/AsyncRoundsTest.kt")
            include("com/kilombino/pyblockwatch/coinjoin/AsyncRoundsE2ETest.kt")
        }
    }
}

dependencies {
    implementation("org.json:json:20240303")
    testImplementation(kotlin("test"))
    // The app's tests are JUnit 4; they run here on the JUnit Platform's vintage engine.
    testImplementation("junit:junit:4.13.2")
    testRuntimeOnly("org.junit.vintage:junit-vintage-engine:5.10.2")
}

tasks.test {
    useJUnitPlatform()
    testLogging { events("failed", "skipped"); exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL }
}

// The web page speaks the app's languages: its translation tables, straight from the Kilowallet submodule.
tasks.processResources { from("kilowallet/app/src/main/assets/i18n") { into("web/i18n") } }

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
