// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
plugins {
    id("com.android.application")
}

android {
    namespace = "app.multicord.spike"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.multicord.spike"
        // API 28: WebView data directory suffixes and Camera2 LENS_FACING_EXTERNAL both exist from here.
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1-spike"
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

dependencies {
    // The only library: Profiles, document-start scripts, origin-restricted message listeners.
    implementation("androidx.webkit:webkit:1.17.1")
}
