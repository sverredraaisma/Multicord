// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
//
// Spikes 0.3 and 0.5: a document-start, main-world patch shaped like the planned USB camera patch
// (docs/mobile.md, section 4.2, step 5). enumerateDevices gains virtual videoinputs; getUserMedia for their
// deviceIds returns a generated track (MediaStreamTrackGenerator, or canvas.captureStream where that is
// missing) and passes everything else through untouched. Two virtual cameras, each switched on by the app:
// - "Multicord test camera" (0.3): a moving test pattern drawn in the page.
// - "USB camera (<name>)" (0.5): while the app streams a UVC camera, its MJPEG frames arrive as ArrayBuffers
//   on a MessagePort the app hands over (postWebMessage, restricted to this origin), are decoded with
//   ImageDecoder into VideoFrames and written to the track. getSettings reports the camera's real size and
//   rate, and devicechange fires when it comes and goes.
// It touches only browser APIs, never the page's own code or data, and reports through the origin-restricted
// "multicordSpike" listener.
(function () {
  'use strict';
  var media = navigator.mediaDevices;
  if (!media || typeof media.getUserMedia !== 'function' || media.getUserMedia.__multicord) return;

  // The app replaces this object (between the markers) with the switches for this WebView.
  var config = /*MULTICORD_CONFIG*/{ "testCamera": true, "usbCamera": false }/*END_MULTICORD_CONFIG*/;

  var TEST_ID = 'multicord-test-camera';
  var TEST_GROUP = 'multicord-test-group';
  var TEST_LABEL = 'Multicord test camera';
  var USB_ID = 'multicord-usb-0';
  var USB_GROUP = 'multicord-usb-group';
  var USB_HELLO = 'multicord-usb-camera';
  var MAX_JPEG = 4 * 1024 * 1024;
  var originalGetUserMedia = media.getUserMedia;
  var originalEnumerate = media.enumerateDevices;
  var listedOnce = false;

  function report(text) {
    try {
      if (window.multicordSpike) window.multicordSpike.postMessage(text);
    } catch (e) {
      // Reporting is best effort.
    }
  }

  function describeError(e) {
    return e && e.name ? e.name + ': ' + e.message : String(e);
  }

  var generatorKind = typeof window.MediaStreamTrackGenerator === 'function' && typeof window.VideoFrame === 'function'
    ? 'MediaStreamTrackGenerator'
    : 'canvas.captureStream';

  /** A device entry that passes `instanceof InputDeviceInfo` and serialises like a real one. */
  function deviceInfo(values, caps) {
    var proto = window.InputDeviceInfo ? InputDeviceInfo.prototype : MediaDeviceInfo.prototype;
    var info = Object.create(proto);
    Object.keys(values).forEach(function (key) {
      Object.defineProperty(info, key, { value: values[key], enumerable: true });
    });
    Object.defineProperty(info, 'toJSON', { value: function () { return Object.assign({}, values); } });
    Object.defineProperty(info, 'getCapabilities', { value: function () { return caps; } });
    return info;
  }

  function capabilities(deviceId, groupId, width, height, fps) {
    return {
      deviceId: deviceId,
      groupId: groupId,
      width: { min: 1, max: width },
      height: { min: 1, max: height },
      frameRate: { min: 1, max: fps },
      aspectRatio: { min: 1 / height, max: width },
      resizeMode: ['none'],
    };
  }

  /** deviceId constraints come as a string, an array, or {exact|ideal: either}. */
  function ids(constraint) {
    if (constraint === undefined || constraint === null) return [];
    if (typeof constraint === 'string') return [constraint];
    if (Array.isArray(constraint)) return constraint;
    return ids(constraint.exact).concat(ids(constraint.ideal));
  }

  function number(constraint) {
    if (typeof constraint === 'number') return constraint;
    if (constraint && typeof constraint === 'object') return constraint.exact || constraint.ideal || constraint.max;
    return undefined;
  }

  /**
   * Makes a generated track look like a camera: label, settings, capabilities, constraints. `settings` is a
   * function so a USB track can report the camera's current values; `onStop` runs once when it stops.
   */
  function dressTrack(track, label, settings, caps, onStop) {
    var constraints = {};
    var baseSettings = track.getSettings.bind(track);
    var stop = track.stop.bind(track);
    var stopped = false;
    Object.defineProperty(track, 'label', { get: function () { return label; } });
    track.getSettings = function () { return Object.assign({}, baseSettings(), settings()); };
    track.getCapabilities = function () { return caps(); };
    track.getConstraints = function () { return Object.assign({}, constraints); };
    track.applyConstraints = function (next) {
      constraints = next || {};
      report(label + ': applyConstraints ' + JSON.stringify(constraints));
      return Promise.resolve();
    };
    track.stop = function () {
      if (!stopped) {
        stopped = true;
        onStop();
      }
      stop();
    };
    track.addEventListener('ended', function () {
      if (!stopped) {
        stopped = true;
        onStop();
      }
    });
    return track;
  }

  // ---- 0.3: the test camera ------------------------------------------------------------------------------

  /** 640x360 when the page asks for 640 wide or less, else 1280x720; 15 or 30 fps likewise. */
  function chooseFormat(video) {
    var width = number(video.width);
    var fps = number(video.frameRate);
    var small = width !== undefined && width <= 640;
    return { width: small ? 640 : 1280, height: small ? 360 : 720, fps: fps !== undefined && fps <= 15 ? 15 : 30 };
  }

  function drawer(ctx, width, height) {
    var start = performance.now();
    var frame = 0;
    var colors = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    return function draw() {
      var t = (performance.now() - start) / 1000;
      frame++;
      var bar = width / colors.length;
      colors.forEach(function (color, i) {
        ctx.fillStyle = color;
        ctx.fillRect(i * bar, 0, bar + 1, height);
      });
      var size = height / 5;
      var x = (Math.sin(t * 1.3) * 0.5 + 0.5) * (width - size);
      var y = (Math.cos(t * 0.9) * 0.5 + 0.5) * (height - size);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, size, size);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.fillRect(0, height - height / 6, width, height / 6);
      ctx.fillStyle = '#ffffff';
      ctx.font = Math.round(height / 14) + 'px sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(TEST_LABEL + '  ' + new Date().toISOString().slice(11, 23) + '  frame ' + frame, height / 24, height - height / 12);
      return frame;
    };
  }

  /** A video track of the moving test pattern, with settings and capabilities that look like a camera. */
  function makeTestTrack(format) {
    var width = format.width;
    var height = format.height;
    var interval = 1000 / format.fps;
    var started = performance.now();
    var frames = 0;
    var timer;
    var track;

    if (generatorKind === 'MediaStreamTrackGenerator') {
      var canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      var draw = drawer(canvas.getContext('2d'), width, height);
      track = new MediaStreamTrackGenerator({ kind: 'video' });
      var writer = track.writable.getWriter();
      var writing = false;
      timer = setInterval(function () {
        if (writing) return; // The sink is behind: drop this frame rather than queue it.
        frames = draw();
        // The generator takes ownership of the frame and closes it.
        var videoFrame = new VideoFrame(canvas, { timestamp: Math.round((performance.now() - started) * 1000) });
        writing = true;
        writer.write(videoFrame).then(function () {
          writing = false;
        }, function (e) {
          clearInterval(timer);
          report('test camera: writing a frame failed: ' + describeError(e));
        });
      }, interval);
    } else {
      var element = document.createElement('canvas');
      element.width = width;
      element.height = height;
      var drawElement = drawer(element.getContext('2d'), width, height);
      drawElement();
      track = element.captureStream(format.fps).getVideoTracks()[0];
      timer = setInterval(function () { frames = drawElement(); }, interval);
    }

    var settings = {
      deviceId: TEST_ID,
      groupId: TEST_GROUP,
      width: width,
      height: height,
      frameRate: format.fps,
      aspectRatio: width / height,
      resizeMode: 'none',
    };
    return dressTrack(track, TEST_LABEL,
      function () { return settings; },
      function () { return capabilities(TEST_ID, TEST_GROUP, width, height, format.fps); },
      function () {
        clearInterval(timer);
        var seconds = (performance.now() - started) / 1000;
        report('test camera: stopped after ' + frames + ' frames in ' + seconds.toFixed(1) + ' s (' +
          (frames / seconds).toFixed(1) + ' fps drawn)');
      });
  }

  // ---- 0.5: the USB camera -------------------------------------------------------------------------------

  var usb = {
    port: null,
    /** {name, width, height, fps} while the app streams, else null. */
    status: null,
    /** Open tracks: {deliver(frame, timestamp), end()}. */
    sinks: [],
    pending: null,
    decoding: false,
    stats: null,
  };

  function newStats() {
    return { received: 0, decoded: 0, written: 0, busyDrops: 0, writeDrops: 0, invalid: 0, errors: 0, decodeMs: 0, started: performance.now() };
  }

  function usbLabel() {
    return 'USB camera (' + (usb.status ? usb.status.name : 'unplugged') + ')';
  }

  function usbSettings() {
    var s = usb.status || { width: 0, height: 0, fps: 0 };
    return {
      deviceId: USB_ID,
      groupId: USB_GROUP,
      width: s.width,
      height: s.height,
      frameRate: s.fps,
      aspectRatio: s.height ? s.width / s.height : 0,
      resizeMode: 'none',
    };
  }

  function usbCapabilities() {
    var s = usb.status || { width: 1280, height: 720, fps: 30 };
    return capabilities(USB_ID, USB_GROUP, s.width, s.height, s.fps);
  }

  function usbReport(prefix) {
    var st = usb.stats;
    if (!st) return;
    var seconds = (performance.now() - st.started) / 1000;
    report('usb camera: ' + prefix + ' ' + st.written + ' frames written in ' + seconds.toFixed(1) + ' s (' +
      (st.written / seconds).toFixed(1) + ' fps), ' + st.received + ' received, ' + st.decoded + ' decoded (' +
      (st.decoded ? (st.decodeMs / st.decoded).toFixed(1) : '-') + ' ms each), dropped ' + st.busyDrops +
      ' while decoding and ' + st.writeDrops + ' while writing, ' + st.invalid + ' invalid, ' + st.errors + ' decode errors');
  }

  /** Validates a status message from the app; the port is ours, but check anyway. */
  function parseStatus(text) {
    var message;
    try {
      message = JSON.parse(text);
    } catch (e) {
      return undefined;
    }
    if (!message || message.type !== 'status') return undefined;
    if (message.streaming !== true) return null;
    var ok = typeof message.name === 'string' && message.name.length <= 100 &&
      [message.width, message.height].every(function (v) { return Number.isInteger(v) && v > 0 && v <= 8192; }) &&
      Number.isInteger(message.fps) && message.fps > 0 && message.fps <= 240;
    return ok ? { name: message.name, width: message.width, height: message.height, fps: message.fps } : undefined;
  }

  function onStatus(status) {
    var was = usb.status;
    usb.status = status;
    if (status) {
      report('usb camera: streaming ' + status.width + 'x' + status.height + ' @ ' + status.fps + ' (' + status.name + ')');
    } else if (was) {
      report('usb camera: stream stopped; ending ' + usb.sinks.length + ' track(s)');
      // Like an unplugged camera: the tracks end and say so.
      usb.sinks.slice().forEach(function (sink) { sink.end(); });
    }
    if (!was !== !status) media.dispatchEvent(new Event('devicechange'));
  }

  function onPortMessage(event) {
    var data = event.data;
    if (typeof data === 'string') {
      var status = parseStatus(data);
      if (status !== undefined) onStatus(status);
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    var st = usb.stats || (usb.stats = newStats());
    st.received++;
    if (data.byteLength < 64 || data.byteLength > MAX_JPEG) {
      st.invalid++;
      return;
    }
    var head = new Uint8Array(data, 0, 2);
    if (head[0] !== 0xff || head[1] !== 0xd8) {
      st.invalid++;
      return;
    }
    if (usb.sinks.length === 0) return;
    if (usb.decoding) {
      // Keep only the newest frame waiting: a camera should lag by one frame at most.
      if (usb.pending) st.busyDrops++;
      usb.pending = data;
      return;
    }
    decode(data);
  }

  /** JPEG to one VideoFrame (ImageDecoder), or to an ImageBitmap where WebCodecs is missing. */
  function decodeImage(buffer) {
    if (typeof window.ImageDecoder === 'function') {
      var decoder = new ImageDecoder({ data: buffer, type: 'image/jpeg' });
      return decoder.decode().then(function (result) {
        decoder.close();
        return result.image;
      }, function (e) {
        decoder.close();
        throw e;
      });
    }
    return createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }));
  }

  function decode(buffer) {
    var st = usb.stats;
    usb.decoding = true;
    var began = performance.now();
    var timestamp = Math.round(began * 1000);
    decodeImage(buffer).then(function (image) {
      st.decoded++;
      st.decodeMs += performance.now() - began;
      try {
        usb.sinks.forEach(function (sink) { sink.deliver(image, timestamp); });
      } finally {
        image.close();
      }
    }).catch(function (e) {
      st.errors++;
      if (st.errors <= 3) report('usb camera: decode failed: ' + describeError(e));
    }).then(function () {
      usb.decoding = false;
      var next = usb.pending;
      usb.pending = null;
      if (next && usb.sinks.length > 0) decode(next);
    });
  }

  function attachPort(port) {
    if (usb.port) usb.port.close();
    usb.port = port;
    port.onmessage = onPortMessage;
    report('usb camera: channel from the app connected');
    if (usb.sinks.length > 0) port.postMessage('want');
  }

  /** A track fed by the USB camera's frames, as a camera would be. */
  function makeUsbTrack() {
    var status = usb.status;
    var track;
    var sink;
    if (generatorKind === 'MediaStreamTrackGenerator') {
      track = new MediaStreamTrackGenerator({ kind: 'video' });
      var writer = track.writable.getWriter();
      var writing = false;
      sink = {
        deliver: function (image, timestamp) {
          if (writing) {
            usb.stats.writeDrops++;
            return;
          }
          // The generator takes ownership of this frame and closes it.
          var frame = new VideoFrame(image, { timestamp: timestamp });
          writing = true;
          writer.write(frame).then(function () {
            writing = false;
            usb.stats.written++;
          }, function () {
            writing = false;
          });
        },
      };
    } else {
      var canvas = document.createElement('canvas');
      canvas.width = status.width;
      canvas.height = status.height;
      var ctx = canvas.getContext('2d');
      track = canvas.captureStream(status.fps).getVideoTracks()[0];
      sink = {
        deliver: function (image) {
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          usb.stats.written++;
        },
      };
    }
    var label = usbLabel();
    sink.end = function () {
      track.stop();
      track.dispatchEvent(new Event('ended'));
    };
    dressTrack(track, label, usbSettings, usbCapabilities, function () {
      var i = usb.sinks.indexOf(sink);
      if (i >= 0) usb.sinks.splice(i, 1);
      if (usb.sinks.length === 0) {
        usbReport('track stopped;');
        usb.pending = null;
        if (usb.port) usb.port.postMessage('idle');
      }
    });
    if (usb.sinks.length === 0) {
      usb.stats = newStats();
      if (usb.port) usb.port.postMessage('want');
    }
    usb.sinks.push(sink);
    return track;
  }

  if (config.usbCamera) {
    // The app's handover: a port posted to this origin only. Pages cannot fake it: their own postMessage
    // calls carry a source window, the app's carry none. The page's listeners never see it.
    window.addEventListener('message', function (event) {
      if (event.data !== USB_HELLO || event.source !== null || !event.ports || event.ports.length !== 1) return;
      event.stopImmediatePropagation();
      attachPort(event.ports[0]);
    }, true);
    setInterval(function () {
      if (usb.sinks.length > 0) usbReport('running:');
    }, 10000);
    report('usb-camera:hello');
  }

  // ---- The patch -----------------------------------------------------------------------------------------

  var getUserMedia = async function (constraints) {
    var video = constraints && constraints.video;
    var wanted = video && typeof video === 'object' ? ids(video.deviceId) : [];
    var test = config.testCamera && wanted.indexOf(TEST_ID) >= 0;
    var usbWanted = config.usbCamera && wanted.indexOf(USB_ID) >= 0;
    if (!test && !usbWanted) return originalGetUserMedia.apply(this, arguments);
    if (usbWanted && !usb.status) throw new DOMException('The USB camera is not streaming', 'NotFoundError');
    var stream = constraints.audio
      ? await originalGetUserMedia.call(this, { audio: constraints.audio })
      : new MediaStream();
    if (test) {
      var format = chooseFormat(video);
      stream.addTrack(makeTestTrack(format));
      report('test camera: opened ' + format.width + 'x' + format.height + ' @ ' + format.fps + ' fps through ' + generatorKind +
        (constraints.audio ? ', with the real microphone' : '') + '; asked ' + JSON.stringify(video));
    } else {
      stream.addTrack(makeUsbTrack());
      report('usb camera: opened ' + usb.status.width + 'x' + usb.status.height + ' @ ' + usb.status.fps + ' through ' +
        generatorKind + (constraints.audio ? ', with the real microphone' : '') + '; asked ' + JSON.stringify(video));
    }
    return stream;
  };

  var enumerateDevices = async function () {
    var devices = Array.prototype.slice.call(await originalEnumerate.apply(this, arguments));
    var real = devices.length;
    // Last, so they never become the page's default camera.
    if (config.testCamera) {
      devices.push(deviceInfo({ deviceId: TEST_ID, kind: 'videoinput', label: TEST_LABEL, groupId: TEST_GROUP },
        capabilities(TEST_ID, TEST_GROUP, 1280, 720, 30)));
    }
    if (config.usbCamera && usb.status) {
      devices.push(deviceInfo({ deviceId: USB_ID, kind: 'videoinput', label: usbLabel(), groupId: USB_GROUP }, usbCapabilities()));
    }
    if (!listedOnce) {
      listedOnce = true;
      report('virtual cameras: listed by enumerateDevices next to ' + real + ' real device(s)');
    }
    return devices;
  };

  getUserMedia.__multicord = true;
  enumerateDevices.__multicord = true;
  media.getUserMedia = getUserMedia;
  media.enumerateDevices = enumerateDevices;
  report('virtual cameras: patch installed in ' + location.origin + ' (' + generatorKind + '; test camera ' +
    (config.testCamera ? 'on' : 'off') + ', USB camera ' + (config.usbCamera ? 'on' : 'off') + ')');
})();
