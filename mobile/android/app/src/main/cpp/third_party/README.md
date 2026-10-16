# Vendored native libraries (the USB camera)

Two libraries, copied as source from upstream with no changes, built by `../CMakeLists.txt`. Only the files the Android build needs are here; everything else upstream (build systems, examples, tests, other platforms' backends) is left out.

| Library | Version | Upstream | Licence |
|---|---|---|---|
| libusb | 1.0.29, tag `v1.0.29`, commit `15a7ebb4d426c5ce196684347d2b7cafad862626` | https://github.com/libusb/libusb | LGPL-2.1-or-later, see `libusb/COPYING` |
| libuvc | 0.0.8 plus two later commits, commit `d07de4fa23905ee8cac06f5d24b2a03d42a3b363` (master, 2026-09) | https://github.com/libuvc/libuvc | BSD-3-Clause, see `libuvc/LICENSE.txt` (`utlist.h`: BSD-1-Clause, uthash) |

libuvc is taken after 0.0.8 for `LIBUVC_PACKETS_PER_TRANSFER_MAX` (smaller isochronous transfers; some Android kernels refuse large ones with `ENOMEM`) and for `uvc_stream_start` failing when no transfer could be submitted.

## Files taken

- libusb: `COPYING`, `AUTHORS`, `android/config.h`, `libusb/{core,descriptor,hotplug,io,sync,strerror}.c`, `libusb/{libusb,libusbi,version,version_nano}.h`, `libusb/os/{linux_usbfs,events_posix,threads_posix,linux_netlink}.c` and their headers. This is the source list of upstream's `android/jni/libusb.mk`.
- libuvc: `LICENSE.txt`, `include/utlist.h`, `include/libuvc/{libuvc.h,libuvc_internal.h,libuvc_config.h.in}`, `src/{ctrl,ctrl-gen,device,diag,frame,init,misc,stream}.c`. Not `frame-mjpeg.c` (it needs libjpeg; the page decodes MJPEG). `libuvc_config.h` is generated from the `.in` file by our CMake build.

## How the app uses them

The app never lets libusb scan the bus: Android's USB host API opens the device after the user allows it, and the native code gets only that file descriptor. `LIBUSB_OPTION_NO_DEVICE_DISCOVERY` is set before the context exists, and `uvc_wrap` (libusb's `libusb_wrap_sys_device`) turns the descriptor into a device handle. libusb is built as its own shared library (`libusb1.0.so`), as upstream's Android build does, so it can be replaced on its own (LGPL-2.1, section 6).

## Updating

Clone the upstream tag or commit, copy the same files over, update the table above, and build. Keep the copies unchanged; build settings go in `../CMakeLists.txt`.
