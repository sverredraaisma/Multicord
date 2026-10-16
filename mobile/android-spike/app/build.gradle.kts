// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
import java.awt.Color
import java.awt.Font
import java.awt.RenderingHints
import java.awt.image.BufferedImage
import java.awt.image.DataBufferInt
import java.util.Random
import javax.imageio.IIOImage
import javax.imageio.ImageIO
import javax.imageio.ImageWriteParam
import javax.imageio.stream.FileImageOutputStream

plugins {
    id("com.android.application")
}

android {
    namespace = "app.multicord.spike"
    compileSdk = 36
    // Spike 0.5's native code (libusb, libuvc, JNI). One of the NDKs on GitHub's ubuntu-latest image; CI installs it if not.
    ndkVersion = "28.2.13676358"

    defaultConfig {
        applicationId = "app.multicord.spike"
        // API 28: WebView data directory suffixes and Camera2 LENS_FACING_EXTERNAL both exist from here.
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1-spike"
        ndk {
            // Phones, and the x86_64 emulator.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
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

    androidResources {
        // The test frames are JPEG already; compressing them again only slows the build.
        noCompress += "jpg"
    }
}

/**
 * Spike 0.4's input: a short 720p MJPEG-like sequence (one JPEG per frame), generated at build time so the
 * repository stays small. Gradients, moving shapes and sensor-like noise keep the frames near the size of a
 * real webcam's MJPEG frames (docs/mobile.md, section 4.2: 50-200 KB at 720p).
 */
abstract class GenerateTestFrames : DefaultTask() {
    @get:Input
    abstract val count: Property<Int>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun generate() {
        System.setProperty("java.awt.headless", "true")
        val width = 1280
        val height = 720
        val dir = outputDir.get().asFile.resolve("web/frames")
        dir.deleteRecursively()
        dir.mkdirs()
        val writer = ImageIO.getImageWritersByFormatName("jpeg").next()
        val param = writer.defaultWriteParam.apply {
            compressionMode = ImageWriteParam.MODE_EXPLICIT
            compressionQuality = 0.8f
        }
        val random = Random(42)
        val frames = count.get()
        for (i in 0 until frames) {
            val image = BufferedImage(width, height, BufferedImage.TYPE_INT_RGB)
            val pixels = (image.raster.dataBuffer as DataBufferInt).data
            val shift = i * 8
            for (y in 0 until height) {
                for (x in 0 until width) {
                    val noise = random.nextInt(13) - 6
                    val r = ((x + shift) * 255 / width + noise).coerceIn(0, 255)
                    val g = (y * 255 / height + noise).coerceIn(0, 255)
                    val b = ((x + y + shift) % 256 / 2 + 64 + noise).coerceIn(0, 255)
                    pixels[y * width + x] = (r shl 16) or (g shl 8) or b
                }
            }
            val g = image.createGraphics()
            g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            val t = i.toDouble() / frames * 2 * Math.PI
            g.color = Color.WHITE
            g.fillOval((640 + 400 * Math.cos(t)).toInt() - 90, (360 + 200 * Math.sin(t)).toInt() - 90, 180, 180)
            g.color = Color(30, 30, 30)
            g.fillRect((1100 - 900 * i / frames), 80, 120, 120)
            g.color = Color.WHITE
            g.font = Font(Font.SANS_SERIF, Font.BOLD, 48)
            g.drawString("Multicord MJPEG test frame %02d".format(i), 40, 680)
            g.dispose()
            FileImageOutputStream(dir.resolve("frame%02d.jpg".format(i))).use { out ->
                writer.output = out
                writer.write(null, IIOImage(image, null, null), param)
            }
        }
        writer.dispose()
        dir.resolve("frames.json").writeText("{\"count\":$frames,\"width\":$width,\"height\":$height}\n")
    }
}

val generateTestFrames = tasks.register<GenerateTestFrames>("generateTestFrames") {
    count.set(30)
    outputDir.set(layout.buildDirectory.dir("generated/testFrames"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(generateTestFrames, GenerateTestFrames::outputDir)
    }
}

dependencies {
    // The only library: Profiles, document-start scripts, origin-restricted message listeners.
    implementation("androidx.webkit:webkit:1.17.1")
}
