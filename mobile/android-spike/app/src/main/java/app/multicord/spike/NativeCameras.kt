// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
package app.multicord.spike

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Handler
import android.os.Looper

/**
 * Spike 0.2, native half: what Camera2 and the USB host stack see. A UVC camera that Camera2 lists with
 * LENS_FACING_EXTERNAL is Tier A (docs/mobile.md, section 4.1); one only in the USB list needs Tier B.
 */
object NativeCameras {
    private const val SECTION = "camera2"

    fun report(context: Context) {
        val pm = context.packageManager
        SpikeLog.add(SECTION, "feature camera.external: ${pm.hasSystemFeature(PackageManager.FEATURE_CAMERA_EXTERNAL)}, " +
            "usb.host: ${pm.hasSystemFeature(PackageManager.FEATURE_USB_HOST)}")
        reportCameras(context)
        reportUsb(context)
    }

    private fun reportCameras(context: Context) {
        val manager = context.getSystemService(CameraManager::class.java)
        val ids = try {
            manager.cameraIdList.toList()
        } catch (e: Exception) {
            SpikeLog.add(SECTION, "cameraIdList failed: ${e.javaClass.simpleName}")
            return
        }
        SpikeLog.add(SECTION, "${ids.size} camera id(s): ${ids.joinToString()}")
        for (id in ids) {
            try {
                SpikeLog.add(SECTION, "camera $id: ${describe(manager.getCameraCharacteristics(id))}")
            } catch (e: Exception) {
                SpikeLog.add(SECTION, "camera $id: characteristics failed: ${e.javaClass.simpleName}")
            }
        }
    }

    private fun describe(c: CameraCharacteristics): String {
        val facing = when (c.get(CameraCharacteristics.LENS_FACING)) {
            CameraCharacteristics.LENS_FACING_FRONT -> "FRONT"
            CameraCharacteristics.LENS_FACING_BACK -> "BACK"
            CameraCharacteristics.LENS_FACING_EXTERNAL -> "EXTERNAL"
            else -> "unknown"
        }
        val level = when (c.get(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)) {
            CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY -> "LEGACY"
            CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED -> "LIMITED"
            CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_FULL -> "FULL"
            CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_3 -> "LEVEL_3"
            CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL_EXTERNAL -> "EXTERNAL"
            else -> "unknown"
        }
        val map = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        val sizes = map?.getOutputSizes(ImageFormat.YUV_420_888)
            ?.sortedByDescending { it.width * it.height }?.take(4)?.joinToString { "${it.width}x${it.height}" }
        val fps = c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)?.joinToString { "${it.lower}-${it.upper}" }
        val physical = c.physicalCameraIds.takeIf { it.isNotEmpty() }?.let { ", physical ids: ${it.joinToString()}" } ?: ""
        return "facing $facing, hardware level $level, largest YUV sizes [$sizes], AE fps ranges [$fps]$physical"
    }

    private fun reportUsb(context: Context) {
        val manager = context.getSystemService(UsbManager::class.java)
        val devices = manager?.deviceList?.values.orEmpty()
        SpikeLog.add("usb", "${devices.size} USB device(s) attached")
        for (device in devices) SpikeLog.add("usb", describe(device))
    }

    private fun describe(d: UsbDevice): String {
        val video = (0 until d.interfaceCount).count { d.getInterface(it).interfaceClass == UsbConstants.USB_CLASS_VIDEO }
        // Names need the per-device USB permission on Android 10+; without it they read as null or throw.
        val name = try {
            listOfNotNull(d.manufacturerName, d.productName).joinToString(" ").ifEmpty { "(name needs USB permission)" }
        } catch (_: SecurityException) {
            "(name needs USB permission)"
        }
        return "vid %04x pid %04x, class %d, %d interface(s), %d video interface(s)%s, %s".format(
            d.vendorId, d.productId, d.deviceClass, d.interfaceCount, video,
            if (video > 0) " = UVC" else "", name,
        )
    }

    /** Logs cameras coming and going while the app runs, so plugging the UVC camera in shows up. */
    fun watch(context: Context): CameraManager.AvailabilityCallback {
        val callback = object : CameraManager.AvailabilityCallback() {
            override fun onCameraAvailable(cameraId: String) = SpikeLog.add(SECTION, "camera $cameraId available")
            override fun onCameraUnavailable(cameraId: String) = SpikeLog.add(SECTION, "camera $cameraId unavailable (in use or removed)")
        }
        context.getSystemService(CameraManager::class.java).registerAvailabilityCallback(callback, Handler(Looper.getMainLooper()))
        return callback
    }

    fun unwatch(context: Context, callback: CameraManager.AvailabilityCallback) {
        context.getSystemService(CameraManager::class.java).unregisterAvailabilityCallback(callback)
    }
}
