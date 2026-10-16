// Multicord for Android. Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
import com.android.build.api.variant.HostTestBuilder

plugins {
    id("com.android.application")
}

/** The repository root: the desktop app's sources, tests and build output live there. */
val repoRoot: File = rootProject.projectDir.resolve("../..").canonicalFile

android {
    namespace = "app.multicord"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.multicord"
        // API 28: the lowest the spike was checked on; Profiles need a recent WebView, checked at start.
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-dev"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = true
    }
}

/**
 * The network policy's shared test cases (tests/fixtures/netpolicy-cases.json), copied from the repository
 * root at build time so the Kotlin tests run the very file the TypeScript tests run.
 */
abstract class CopyFixtures : DefaultTask() {
    @get:InputFiles
    abstract val fixtures: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val dir = outputDir.get().asFile.resolve("fixtures")
        dir.deleteRecursively()
        dir.mkdirs()
        for (file in fixtures.files) {
            if (!file.isFile) throw GradleException("Missing test fixture $file")
            file.copyTo(dir.resolve(file.name), overwrite = true)
        }
    }
}

val copyFixtures = tasks.register<CopyFixtures>("copyFixtures") {
    fixtures.from(repoRoot.resolve("tests/fixtures/netpolicy-cases.json"))
    outputDir.set(layout.buildDirectory.dir("generated/fixtures"))
}

androidComponents {
    onVariants { variant ->
        variant.hostTests[HostTestBuilder.UNIT_TEST_TYPE]?.sources?.resources?.addGeneratedSourceDirectory(copyFixtures, CopyFixtures::outputDir)
    }
}

dependencies {
    // JSON for the bridge's messages and validators (no compiler plugin: only the JsonElement tree is used).
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")

    testImplementation("junit:junit:4.13.2")
}
