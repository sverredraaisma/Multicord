# Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
# AGPL-3.0-or-later, see LICENSE at the repo root.
#
# Spike 0.5: libusb (shared, LGPL-2.1) and libuvc (static, BSD) from third_party, and the JNI layer.
cmake_minimum_required(VERSION 3.22.1)
project(multicord_uvc LANGUAGES C)

# The vendored sources live in the app (mobile/android), which the spike shares.
set(THIRD_PARTY ${CMAKE_CURRENT_SOURCE_DIR}/../../../../../android/app/src/main/cpp/third_party)
set(LIBUSB ${THIRD_PARTY}/libusb)
set(LIBUVC ${THIRD_PARTY}/libuvc)

# libusb, as upstream's android/jni/libusb.mk builds it.
add_library(usb1.0 SHARED
  ${LIBUSB}/libusb/core.c
  ${LIBUSB}/libusb/descriptor.c
  ${LIBUSB}/libusb/hotplug.c
  ${LIBUSB}/libusb/io.c
  ${LIBUSB}/libusb/sync.c
  ${LIBUSB}/libusb/strerror.c
  ${LIBUSB}/libusb/os/linux_usbfs.c
  ${LIBUSB}/libusb/os/events_posix.c
  ${LIBUSB}/libusb/os/threads_posix.c
  ${LIBUSB}/libusb/os/linux_netlink.c
)
target_include_directories(usb1.0
  PRIVATE ${LIBUSB}/android ${LIBUSB}/libusb/os
  PUBLIC ${LIBUSB}/libusb
)
target_compile_options(usb1.0 PRIVATE -fvisibility=hidden -pthread -w)
target_link_libraries(usb1.0 PRIVATE log)

# libuvc without libjpeg: the page decodes the MJPEG frames.
set(libuvc_VERSION_MAJOR 0)
set(libuvc_VERSION_MINOR 0)
set(libuvc_VERSION_PATCH 8)
set(libuvc_VERSION 0.0.8)
configure_file(${LIBUVC}/include/libuvc/libuvc_config.h.in ${CMAKE_CURRENT_BINARY_DIR}/generated/libuvc/libuvc_config.h)
add_library(uvc STATIC
  ${LIBUVC}/src/ctrl.c
  ${LIBUVC}/src/ctrl-gen.c
  ${LIBUVC}/src/device.c
  ${LIBUVC}/src/diag.c
  ${LIBUVC}/src/frame.c
  ${LIBUVC}/src/init.c
  ${LIBUVC}/src/misc.c
  ${LIBUVC}/src/stream.c
)
target_include_directories(uvc PUBLIC ${LIBUVC}/include ${CMAKE_CURRENT_BINARY_DIR}/generated)
# Smaller isochronous transfers than upstream's default: some Android kernels refuse large ones (ENOMEM).
target_compile_definitions(uvc PRIVATE LIBUVC_NUM_TRANSFER_BUFS=32 LIBUVC_PACKETS_PER_TRANSFER_MAX=8)
target_compile_options(uvc PRIVATE -w)
target_link_libraries(uvc PUBLIC usb1.0)

add_library(multicord_uvc SHARED uvc_jni.c)
target_compile_options(multicord_uvc PRIVATE -Wall -Wextra -Werror)
target_link_libraries(multicord_uvc PRIVATE uvc usb1.0 log)
