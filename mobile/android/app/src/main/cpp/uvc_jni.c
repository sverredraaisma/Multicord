// Multicord for Android. Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
//
// The USB camera's native half (docs/mobile.md, section 4.2, Tier B): a UVC camera that Android's USB host API opened, streamed as MJPEG with libuvc.
// Kotlin passes only the file descriptor of the device the user allowed; libusb never scans the bus.
// Complete frames go into a small ring of buffers allocated once per stream; when Kotlin falls behind the
// oldest frame is dropped and counted. Kotlin copies frames out into one direct ByteBuffer it reuses.

#include <errno.h>
#include <jni.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <android/log.h>

#include "libusb.h"
#include "libuvc/libuvc.h"

#define TAG "Multicord"
/** Largest JPEG passed on; the page enforces the same cap. */
#define MAX_FRAME_BYTES (4 * 1024 * 1024)
#define MIN_FRAME_BYTES 64
#define RING_SLOTS 4
#define LOG_LINES 32
#define LOG_LINE_BYTES 240

enum {
  STAT_RECEIVED,   // complete frames libuvc delivered
  STAT_TAKEN,      // frames Kotlin copied out
  STAT_DROPPED,    // oldest frames dropped because the ring was full
  STAT_INVALID,    // not a JPEG (no SOI) or too short
  STAT_OVERSIZE,   // larger than MAX_FRAME_BYTES
  STAT_BYTES,      // bytes of frames received
  STAT_NO_EOI,     // passed on, but without an EOI marker near the end
  STAT_LAST_BYTES, // size of the last frame received
  STAT_COUNT
};

typedef struct camera {
  uvc_context_t *uvc;
  uvc_device_handle_t *devh;
  uvc_stream_ctrl_t ctrl;
  int streaming;

  pthread_mutex_t lock;
  pthread_cond_t ready;
  uint8_t *slots[RING_SLOTS];
  size_t lengths[RING_SLOTS];
  size_t capacity;
  int head;
  int count;
  int stopping;
  int64_t stats[STAT_COUNT];
} camera;

// A short log Kotlin drains into the results log, so native messages reach "Copy results" too.
static pthread_mutex_t log_lock = PTHREAD_MUTEX_INITIALIZER;
static char log_lines[LOG_LINES][LOG_LINE_BYTES];
static int log_head = 0;
static int log_count = 0;
static int log_lost = 0;
static pthread_once_t libusb_once = PTHREAD_ONCE_INIT;

static void note(const char *format, ...) __attribute__((format(printf, 1, 2)));

static void note(const char *format, ...) {
  char line[LOG_LINE_BYTES];
  va_list args;
  va_start(args, format);
  vsnprintf(line, sizeof line, format, args);
  va_end(args);
  __android_log_print(ANDROID_LOG_INFO, TAG, "[uvc] %s", line);
  pthread_mutex_lock(&log_lock);
  if (log_count == LOG_LINES) {
    log_head = (log_head + 1) % LOG_LINES;
    log_count--;
    log_lost++;
  }
  memcpy(log_lines[(log_head + log_count) % LOG_LINES], line, sizeof line);
  log_count++;
  pthread_mutex_unlock(&log_lock);
}

static void libusb_log(libusb_context *ctx, enum libusb_log_level level, const char *text) {
  (void) ctx;
  if (level > LIBUSB_LOG_LEVEL_WARNING || text == NULL) return;
  char line[LOG_LINE_BYTES];
  snprintf(line, sizeof line, "%s", text);
  size_t n = strlen(line);
  while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = '\0';
  note("libusb %s: %s", level == LIBUSB_LOG_LEVEL_ERROR ? "error" : "warning", line);
}

/** Android: no bus scan (the app may not read /dev/bus/usb or sysfs), only devices it wraps. */
static void configure_libusb(void) {
  libusb_set_option(NULL, LIBUSB_OPTION_NO_DEVICE_DISCOVERY);
  libusb_set_option(NULL, LIBUSB_OPTION_LOG_CB, libusb_log);
  libusb_set_option(NULL, LIBUSB_OPTION_LOG_LEVEL, LIBUSB_LOG_LEVEL_WARNING);
}

static camera *from_handle(jlong handle) {
  return (camera *) (intptr_t) handle;
}

static const char *speed_name(int speed) {
  switch (speed) {
    case LIBUSB_SPEED_LOW: return "low (1.5 Mbit/s)";
    case LIBUSB_SPEED_FULL: return "full (12 Mbit/s)";
    case LIBUSB_SPEED_HIGH: return "high (480 Mbit/s)";
    case LIBUSB_SPEED_SUPER: return "super (5 Gbit/s)";
    case LIBUSB_SPEED_SUPER_PLUS: return "super+ (10 Gbit/s)";
    default: return "unknown";
  }
}

JNIEXPORT jlong JNICALL Java_app_multicord_camera_UvcNative_open(JNIEnv *env, jclass cls, jint fd) {
  (void) env;
  (void) cls;
  pthread_once(&libusb_once, configure_libusb);
  camera *cam = calloc(1, sizeof *cam);
  if (cam == NULL) return UVC_ERROR_NO_MEM;
  pthread_mutex_init(&cam->lock, NULL);
  pthread_cond_init(&cam->ready, NULL);

  // NULL: libuvc creates and owns the libusb context (with the options above) and runs its event thread.
  uvc_error_t res = uvc_init(&cam->uvc, NULL);
  if (res != UVC_SUCCESS) {
    note("uvc_init failed: %s (%d)", uvc_strerror(res), res);
    free(cam);
    return res;
  }
  res = uvc_wrap(fd, cam->uvc, &cam->devh);
  if (res != UVC_SUCCESS) {
    note("uvc_wrap failed: %s (%d)", uvc_strerror(res), res);
    uvc_exit(cam->uvc);
    free(cam);
    return res;
  }
  libusb_device *usb = libusb_get_device(uvc_get_libusb_handle(cam->devh));
  note("opened fd %d: UVC %x.%02x, USB speed %s", fd, uvc_get_spec_version(cam->devh) >> 8,
       uvc_get_spec_version(cam->devh) & 0xff, speed_name(libusb_get_device_speed(usb)));
  return (jlong) (intptr_t) cam;
}

static const char *format_name(const uvc_format_desc_t *format, char *fourcc) {
  switch (format->bDescriptorSubtype) {
    case UVC_VS_FORMAT_MJPEG: return "MJPEG";
    case UVC_VS_FORMAT_FRAME_BASED: return "FRAME_BASED";
    case UVC_VS_FORMAT_UNCOMPRESSED:
      for (int i = 0; i < 4; i++) {
        char c = (char) format->fourccFormat[i];
        fourcc[i] = (c >= 0x20 && c < 0x7f) ? c : '?';
      }
      fourcc[4] = '\0';
      return fourcc;
    default: return "OTHER";
  }
}

/** Appends "%.4g," to out for each frame rate of one frame descriptor (100 ns interval units). */
static void append_rates(char *out, size_t size, const uvc_frame_desc_t *frame) {
  size_t used = strlen(out);
  if (frame->intervals != NULL) {
    for (const uint32_t *interval = frame->intervals; *interval != 0 && used < size; interval++) {
      used += snprintf(out + used, size - used, "%s%.4g", interval == frame->intervals ? "" : ",", 1e7 / *interval);
    }
  } else if (frame->dwMinFrameInterval != 0 && frame->dwMaxFrameInterval != 0) {
    snprintf(out + used, size - used, "%.4g-%.4g", 1e7 / frame->dwMaxFrameInterval, 1e7 / frame->dwMinFrameInterval);
  }
}

/**
 * Every format and size the camera offers, one per line: "MJPEG 1280x720 fps=30,24,20 max=1843200".
 * Kotlin parses the MJPEG lines for the size choice and logs them all.
 */
JNIEXPORT jstring JNICALL Java_app_multicord_camera_UvcNative_formats(JNIEnv *env, jclass cls, jlong handle) {
  (void) cls;
  camera *cam = from_handle(handle);
  size_t size = 16384;
  char *out = calloc(1, size);
  if (cam == NULL || out == NULL) {
    free(out);
    return (*env)->NewStringUTF(env, "");
  }
  size_t used = 0;
  for (const uvc_format_desc_t *format = uvc_get_format_descs(cam->devh); format != NULL; format = format->next) {
    char fourcc[5];
    const char *name = format_name(format, fourcc);
    for (const uvc_frame_desc_t *frame = format->frame_descs; frame != NULL && used + 256 < size; frame = frame->next) {
      used += snprintf(out + used, size - used, "%s %ux%u fps=", name, frame->wWidth, frame->wHeight);
      append_rates(out, size, frame);
      used = strlen(out);
      used += snprintf(out + used, size - used, " max=%u\n", frame->dwMaxVideoFrameBufferSize);
    }
  }
  jstring result = (*env)->NewStringUTF(env, out);
  free(out);
  return result;
}

/** Runs on libuvc's callback thread: checks the frame, then copies it into the ring. */
static void on_frame(uvc_frame_t *frame, void *user) {
  camera *cam = user;
  const uint8_t *data = frame->data;
  size_t length = frame->data_bytes;
  pthread_mutex_lock(&cam->lock);
  cam->stats[STAT_RECEIVED]++;
  cam->stats[STAT_BYTES] += (int64_t) length;
  cam->stats[STAT_LAST_BYTES] = (int64_t) length;
  if (length > MAX_FRAME_BYTES || length > cam->capacity) {
    cam->stats[STAT_OVERSIZE]++;
  } else if (length < MIN_FRAME_BYTES || data[0] != 0xff || data[1] != 0xd8) {
    cam->stats[STAT_INVALID]++;
  } else {
    // Cameras may pad after EOI (FF D9); trim to it when it is near the end.
    size_t end = length;
    size_t floor = length > 4096 ? length - 4096 : 2;
    while (end > floor && !(data[end - 2] == 0xff && data[end - 1] == 0xd9)) end--;
    if (end <= floor) {
      cam->stats[STAT_NO_EOI]++;
      end = length;
    }
    if (cam->count == RING_SLOTS) {
      cam->head = (cam->head + 1) % RING_SLOTS;
      cam->count--;
      cam->stats[STAT_DROPPED]++;
    }
    int slot = (cam->head + cam->count) % RING_SLOTS;
    memcpy(cam->slots[slot], data, end);
    cam->lengths[slot] = end;
    cam->count++;
    pthread_cond_signal(&cam->ready);
  }
  pthread_mutex_unlock(&cam->lock);
}

static void free_slots(camera *cam) {
  for (int i = 0; i < RING_SLOTS; i++) {
    free(cam->slots[i]);
    cam->slots[i] = NULL;
  }
  cam->capacity = 0;
}

/**
 * Negotiates MJPEG at width x height and fps, and starts streaming. Returns 0, or a negative uvc_error_t.
 * The negotiated values are in describeStream().
 */
JNIEXPORT jint JNICALL Java_app_multicord_camera_UvcNative_start(JNIEnv *env, jclass cls, jlong handle, jint width,
                                                               jint height, jint fps) {
  (void) env;
  (void) cls;
  camera *cam = from_handle(handle);
  if (cam == NULL) return UVC_ERROR_INVALID_PARAM;
  if (cam->streaming) return UVC_ERROR_BUSY;
  uvc_error_t res = uvc_get_stream_ctrl_format_size(cam->devh, &cam->ctrl, UVC_FRAME_FORMAT_MJPEG, width, height, fps);
  if (res != UVC_SUCCESS) {
    note("no MJPEG %dx%d @ %d: %s (%d)", width, height, fps, uvc_strerror(res), res);
    return res;
  }
  // One buffer per slot, sized by what the camera says a frame can take, within the cap.
  size_t capacity = cam->ctrl.dwMaxVideoFrameSize;
  if (capacity < 512 * 1024) capacity = 512 * 1024;
  if (capacity > MAX_FRAME_BYTES) capacity = MAX_FRAME_BYTES;
  pthread_mutex_lock(&cam->lock);
  free_slots(cam);
  for (int i = 0; i < RING_SLOTS; i++) {
    cam->slots[i] = malloc(capacity);
    if (cam->slots[i] == NULL) {
      free_slots(cam);
      pthread_mutex_unlock(&cam->lock);
      return UVC_ERROR_NO_MEM;
    }
  }
  cam->capacity = capacity;
  cam->head = 0;
  cam->count = 0;
  cam->stopping = 0;
  memset(cam->stats, 0, sizeof cam->stats);
  pthread_mutex_unlock(&cam->lock);

  res = uvc_start_streaming(cam->devh, &cam->ctrl, on_frame, cam, 0);
  if (res != UVC_SUCCESS) {
    note("uvc_start_streaming failed: %s (%d)", uvc_strerror(res), res);
    return res;
  }
  cam->streaming = 1;
  note("streaming MJPEG %dx%d @ %d: format %u frame %u, interval %u (%.4g fps), max frame %u B, max payload %u B, "
       "%d slots of %zu B",
       width, height, fps, cam->ctrl.bFormatIndex, cam->ctrl.bFrameIndex, cam->ctrl.dwFrameInterval,
       cam->ctrl.dwFrameInterval ? 1e7 / cam->ctrl.dwFrameInterval : 0.0, cam->ctrl.dwMaxVideoFrameSize,
       cam->ctrl.dwMaxPayloadTransferSize, RING_SLOTS, capacity);
  return 0;
}

/**
 * Waits up to timeoutMs for a frame and copies the oldest one into dst (a direct ByteBuffer).
 * Returns its length, 0 on timeout, or -1 once the stream stops.
 */
JNIEXPORT jint JNICALL Java_app_multicord_camera_UvcNative_nextFrame(JNIEnv *env, jclass cls, jlong handle, jobject dst,
                                                                   jint timeout_ms) {
  (void) cls;
  camera *cam = from_handle(handle);
  uint8_t *out = dst ? (*env)->GetDirectBufferAddress(env, dst) : NULL;
  jlong room = dst ? (*env)->GetDirectBufferCapacity(env, dst) : -1;
  if (cam == NULL || out == NULL || room <= 0) return -1;

  struct timespec deadline;
  clock_gettime(CLOCK_REALTIME, &deadline);
  deadline.tv_sec += timeout_ms / 1000;
  deadline.tv_nsec += (long) (timeout_ms % 1000) * 1000000L;
  if (deadline.tv_nsec >= 1000000000L) {
    deadline.tv_sec++;
    deadline.tv_nsec -= 1000000000L;
  }

  pthread_mutex_lock(&cam->lock);
  while (cam->count == 0 && !cam->stopping) {
    if (pthread_cond_timedwait(&cam->ready, &cam->lock, &deadline) == ETIMEDOUT) break;
  }
  int result;
  if (cam->stopping) {
    result = -1;
  } else if (cam->count == 0) {
    result = 0;
  } else {
    size_t length = cam->lengths[cam->head];
    if ((jlong) length > room) {
      cam->stats[STAT_OVERSIZE]++;
      result = 0;
    } else {
      memcpy(out, cam->slots[cam->head], length);
      cam->stats[STAT_TAKEN]++;
      result = (int) length;
    }
    cam->head = (cam->head + 1) % RING_SLOTS;
    cam->count--;
  }
  pthread_mutex_unlock(&cam->lock);
  return result;
}

/** Copies the counters (see STAT_*) into out, which must hold STAT_COUNT longs. */
JNIEXPORT void JNICALL Java_app_multicord_camera_UvcNative_stats(JNIEnv *env, jclass cls, jlong handle, jlongArray out) {
  (void) cls;
  camera *cam = from_handle(handle);
  if (cam == NULL || out == NULL || (*env)->GetArrayLength(env, out) < STAT_COUNT) return;
  jlong copy[STAT_COUNT];
  pthread_mutex_lock(&cam->lock);
  for (int i = 0; i < STAT_COUNT; i++) copy[i] = cam->stats[i];
  pthread_mutex_unlock(&cam->lock);
  (*env)->SetLongArrayRegion(env, out, 0, STAT_COUNT, copy);
}

/** Wakes a waiting nextFrame for good (it returns -1). Safe from any thread; stop() still has to run. */
JNIEXPORT void JNICALL Java_app_multicord_camera_UvcNative_interrupt(JNIEnv *env, jclass cls, jlong handle) {
  (void) env;
  (void) cls;
  camera *cam = from_handle(handle);
  if (cam == NULL) return;
  pthread_mutex_lock(&cam->lock);
  cam->stopping = 1;
  pthread_cond_broadcast(&cam->ready);
  pthread_mutex_unlock(&cam->lock);
}

/** Stops streaming and frees the ring. Call only after the thread calling nextFrame has finished. */
JNIEXPORT void JNICALL Java_app_multicord_camera_UvcNative_stop(JNIEnv *env, jclass cls, jlong handle) {
  camera *cam = from_handle(handle);
  if (cam == NULL) return;
  Java_app_multicord_camera_UvcNative_interrupt(env, cls, handle);
  if (cam->streaming) {
    uvc_stop_streaming(cam->devh);
    cam->streaming = 0;
    note("stream stopped after %lld frames (%lld dropped, %lld invalid, %lld oversize)",
         (long long) cam->stats[STAT_RECEIVED], (long long) cam->stats[STAT_DROPPED],
         (long long) cam->stats[STAT_INVALID], (long long) cam->stats[STAT_OVERSIZE]);
  }
  pthread_mutex_lock(&cam->lock);
  free_slots(cam);
  cam->count = 0;
  pthread_mutex_unlock(&cam->lock);
}

/** Releases the interfaces and the libusb handle. Kotlin closes the file descriptor afterwards. */
JNIEXPORT void JNICALL Java_app_multicord_camera_UvcNative_close(JNIEnv *env, jclass cls, jlong handle) {
  camera *cam = from_handle(handle);
  if (cam == NULL) return;
  Java_app_multicord_camera_UvcNative_stop(env, cls, handle);
  uvc_close(cam->devh);
  uvc_exit(cam->uvc);
  pthread_cond_destroy(&cam->ready);
  pthread_mutex_destroy(&cam->lock);
  free(cam);
  note("device closed");
}

JNIEXPORT jstring JNICALL Java_app_multicord_camera_UvcNative_errorName(JNIEnv *env, jclass cls, jint code) {
  (void) cls;
  return (*env)->NewStringUTF(env, uvc_strerror((uvc_error_t) code));
}

/** The native log lines since the last call, joined by newlines, or null when there are none. */
JNIEXPORT jstring JNICALL Java_app_multicord_camera_UvcNative_drainLog(JNIEnv *env, jclass cls) {
  (void) cls;
  char out[LOG_LINES * LOG_LINE_BYTES + 64];
  size_t used = 0;
  out[0] = '\0';
  pthread_mutex_lock(&log_lock);
  if (log_lost > 0) used += snprintf(out, sizeof out, "(%d older native lines lost)\n", log_lost);
  for (int i = 0; i < log_count; i++) {
    used += snprintf(out + used, sizeof out - used, "%s\n", log_lines[(log_head + i) % LOG_LINES]);
  }
  int had = log_count + log_lost;
  log_count = 0;
  log_lost = 0;
  pthread_mutex_unlock(&log_lock);
  if (had == 0) return NULL;
  if (used > 0 && out[used - 1] == '\n') out[used - 1] = '\0';
  return (*env)->NewStringUTF(env, out);
}
