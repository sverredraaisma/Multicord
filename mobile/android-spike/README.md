# Multicord Android spike (phase 0)

A throwaway app that answers the four phase-0 questions in [docs/mobile.md](../../docs/mobile.md#7-phased-plan) on a real phone. It is not Multicord for Android. It shares no code with the desktop app and will be replaced by the phase-2 host.

Kotlin, plain Android views, and one library: `androidx.webkit` (Profiles, document-start scripts, origin-restricted message listeners, `WebViewAssetLoader`). Spike 0.5 adds native code: libusb and libuvc, vendored as source in `app/src/main/cpp/third_party` (versions, commits and licences in its README and in [NOTICE](NOTICE)), and a small JNI layer. There are no Google Play Services, no local servers, and no cleartext traffic. Everything the app finds goes into one results log, which you can copy.

## Build

You need JDK 17 or newer and the Android SDK (platform 36, build-tools, NDK 28.2.13676358 and CMake 3.22.1 from the SDK manager). Point Gradle at the SDK with `ANDROID_HOME`, or with a `local.properties` file in this folder (git ignores it):

```
sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk
```

Then, in this folder:

```
./gradlew assembleDebug        # Windows: gradlew.bat assembleDebug
```

The APK is `app/build/outputs/apk/debug/app-debug.apk` (about 7 MB, most of it the generated test frames; native code for arm64-v8a and x86_64). The build generates the 30 JPEG frames for spike 0.4 itself (`generateTestFrames` in `app/build.gradle.kts`), so the repository holds no binaries apart from the Gradle wrapper.

## Install

1. On the phone, enable Developer options and USB debugging, then connect it.
2. `adb install -r app/build/outputs/apk/debug/app-debug.apk` (`adb` is in the SDK's `platform-tools`).
3. Open "Multicord spike". The debug build's id is `app.multicord.spike.debug`. Remove it with `adb uninstall app.multicord.spike.debug`.

Instead of adb, you can copy the APK to the phone and open it there, after allowing installs from that app.

## What each screen tests

The main screen starts by logging the device, the WebView package and version, and whether the WebView supports `MULTI_PROFILE`, `DOCUMENT_START_SCRIPT`, `WEB_MESSAGE_LISTENER`, `WEB_MESSAGE_ARRAY_BUFFER`, `CREATE_WEB_MESSAGE_CHANNEL`, `POST_WEB_MESSAGE` and `JS_INJECTION_IN_FRAME_AND_WORLD`. Press **Grant camera + mic** once first. The WebViews only get the camera and microphone after the app holds those permissions.

| Button | Spike | What happens |
|---|---|---|
| **0.1 Discord** | Does Discord run in a WebView? | Opens `https://discord.com/app` in a WebView with its own Profile (`spike-discord`, which keeps its own login). **Desktop user agent** (on by default) sends a desktop Chrome user agent and desktop client hints. A document-start script, registered only for `https://discord.com`, reports that it ran and which media APIs the page has. Camera and microphone are granted only to `https://discord.com`, and only as camera or microphone. The app never reads Discord's storage or tokens and automates nothing. Links to other sites open in your browser. The **Log** button shows the results while Discord is open. |
| **0.2 Camera page** | Does a USB (UVC) camera appear in the WebView? | A bundled page on `https://appassets.androidplatform.net` (served from the APK, not the network) lists `enumerateDevices`, with names once you allow the camera. **Open each camera** opens every camera at the chosen size and logs its settings, capabilities and the frame rate actually shown. |
| **Camera2 + USB** | Does the phone itself expose the UVC camera? | Logs every Camera2 camera (id, facing `FRONT`/`BACK`/`EXTERNAL`, hardware level, largest sizes, fps ranges), whether the phone declares `camera.external` and `usb.host`, and every USB device with its video interfaces. The log also shows cameras appearing and disappearing while the app is open. |
| **0.3/0.5 Camera page + virtual cameras** / **Test camera in Discord** | Does a generated video track work as a camera? | A document-start patch adds a "Multicord test camera" to `enumerateDevices`. Opening it gives a moving test pattern (colour bars, a moving square, a clock and a frame counter) made with `MediaStreamTrackGenerator`, or with `canvas.captureStream` if that is missing. Other cameras pass through. On the camera page it is always on. For Discord, tick **Test camera in Discord** before pressing **0.1 Discord**. Then pick "Multicord test camera" in Discord's video settings and turn the camera on in a call. |
| **0.5 USB camera** section, **0.3/0.5 Camera page + virtual cameras**, **USB camera in Discord** | Tier B: can the app drive a UVC camera itself, and the page use it as a camera? | The section lists USB video devices (class, interfaces, power, whether the app may use them). **Allow** shows Android's own prompt for the first one. **Start** opens it through the USB host API, hands only its file descriptor to libuvc, and streams MJPEG at the chosen size (1280x720 or 1920x1080 at 30 fps); the line below shows fps, drops and KB/s. **Stop** releases it, as does unplugging. While it streams, pages with the patch list "USB camera (<name>)": each JPEG goes over a MessagePort (restricted to the page's origin) as an ArrayBuffer, is decoded with `ImageDecoder` and written to a generated track. **Replay test frames** plays the 0.4 frames as if a camera sent them, to check that path without one. **USB devices** logs the full `[usb]` dump. |
| **0.4 Decode cost** | What does decoding MJPEG in the page cost? | Decodes 30 bundled 720p JPEG frames (about 100 KB each, like a webcam's MJPEG) with `ImageDecoder` into `VideoFrame`s. **A** decodes as fast as it can. **B** decodes at 30 fps into a `MediaStreamTrackGenerator` shown on screen for 10 seconds. |

## What to send back

Press **Copy results** on the main screen after the steps below and paste the whole log. It holds no account data: page addresses are cut to the site and the first path segment, and Discord's console is not recorded. Also add these notes, which the app cannot see:

1. **Phone**: model, and the USB camera's make and model, and whether you used a USB-C hub or an adapter.
2. **Start**: the feature lines that the app logs when it opens (they are already in the log).
3. **Discord (0.1)**, with the desktop user agent on, and once with it off:
   - What loads: the app, a "download the app" page, a login page, or an error? Does a captcha appear, and can you solve it?
   - Can you log in, read and send messages?
   - Voice: join a voice channel. Can others hear you, and can you hear them?
   - Camera: turn on the phone's own camera in a call. Does a second client (a PC, for example) see it?
   - Is there a "document-start ran in the top frame of https://discord.com" line in the log?
   - Portrait and landscape: is it usable? A tablet, if you have one.
4. **Test camera in Discord (0.3)**: tick it, open Discord, and choose "Multicord test camera" as the camera in a call.
   - Does Discord list it?
   - Does the second client see the moving test pattern? Is the clock on it running smoothly, and at what quality?
   - The "test camera: opened … / stopped after …" lines are in the log.
5. **Camera page (0.2)**, with the UVC camera plugged in:
   - Press **Open each camera** at 1280x720, then again at 1920x1080.
   - Press **Camera2 + USB**.
   - Plug the camera out and in again while the main screen is open.
   - If you can, also open `https://webcamtests.com` or a similar page in Chrome on the phone and note whether Chrome lists the USB camera.
6. **Camera page + virtual cameras (0.3)**: **Open each camera**, then look at the preview. Does the test pattern move?
7. **Decode cost (0.4)**: **Run A then B**, twice. Keep the screen on, and note whether the phone is in a battery-saver mode.
8. **0.5 USB camera**, with the StreamCam plugged into the phone (adb over USB cannot run at the same time unless you use a hub or wireless debugging; it is not needed):
   - Plug the camera in. If Android offers to open "Multicord spike", say yes (that also allows the device). Press **USB devices**. The `[usb]` lines should show `046d:0893` with its interfaces and power.
   - Press **Allow** and accept Android's prompt, then **Start** with 1280x720 @ 30. Note the numbers under the section after ten seconds (fps, KB/s, drops), and whether the camera's light comes on. Then **Stop**, choose 1920x1080 @ 30, **Start** again. If either fails, the `[uvc]` lines say why; send them all.
   - With 1280x720 streaming, open **0.3/0.5 Camera page + virtual cameras** and press **Open each camera**. Is "USB camera (…)" listed, does the preview show the camera's picture, and at what measured fps? Look at the "usb camera: … frames written … decoded (… ms each), dropped …" line.
   - Press **Stop** on the main screen while the camera page is open, then **Start** again, and press **List devices**: the USB camera should disappear and come back (a "devicechange event" line each time).
   - Discord: tick **USB camera in Discord (0.5)**, start the stream, open **0.1 Discord**, join a call and choose "USB camera (…)" in the video settings. Does a second client see the StreamCam's picture, smoothly, and at what quality? Unplug the camera during the call and note what Discord does.
   - Optional, without the camera: **Replay test frames** then the camera page or Discord, as above.

## Security notes

Even as a spike, it keeps to the rules of the real design (docs/mobile.md, sections 2 and 5):
- Each WebView has its own Profile: `spike-discord` for Discord, `spike-pages` for the test pages.
- Scripts and the `multicordSpike` listener are restricted to one origin, and the native side checks the origin again.
- Camera and microphone are granted only to that origin, only as `VIDEO_CAPTURE`/`AUDIO_CAPTURE`, and only once the app holds the Android permissions.
- File and content access are off, and mixed content is blocked.
- The bundled pages carry a CSP and load nothing from the network.
- The test pages are served by `WebViewAssetLoader` from inside the app. There is no localhost server.
- USB: Android asks the user per device; the permission PendingIntent is explicit and immutable, and the receiver is not exported. libusb never scans the bus: native code only gets the file descriptor of the device the user allowed, and the device is released on Stop, on unplugging and when a new stream starts.
- The USB camera's MessagePort is posted only to the page's origin, frames are sent only while the page has a USB track open, and JPEGs over 4 MB or without a JPEG header are dropped in native code and again in the page.

## License

AGPL-3.0-or-later, as the rest of Multicord (see [LICENSE](../../LICENSE)).
