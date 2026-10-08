import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.3.10"
}

group = "com.kilombino.kilowallet"
version = "0.1.0"

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
