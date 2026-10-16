// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
//
// Spike 0.3: a document-start, main-world patch shaped like the planned USB camera patch
// (docs/mobile.md, section 4.2, step 5). enumerateDevices gains a "Multicord test camera" videoinput;
// getUserMedia for that deviceId returns a generated moving test pattern (MediaStreamTrackGenerator, or
// canvas.captureStream where that is missing) and passes everything else through untouched. It touches
// only browser APIs, never the page's own code or data, and reports through the origin-restricted
// "multicordSpike" listener.
(function () {
  'use strict';
  var media = navigator.mediaDevices;
  if (!media || typeof media.getUserMedia !== 'function' || media.getUserMedia.__multicord) return;

  var DEVICE_ID = 'multicord-test-camera';
  var GROUP_ID = 'multicord-test-group';
  var LABEL = 'Multicord test camera';
  var originalGetUserMedia = media.getUserMedia;
  var originalEnumerate = media.enumerateDevices;
  var listedOnce = false;

  function report(text) {
    try {
      if (window.multicordSpike) window.multicordSpike.postMessage('test camera: ' + text);
    } catch (e) {
      // Reporting is best effort.
    }
  }

  var generatorKind = typeof window.MediaStreamTrackGenerator === 'function' && typeof window.VideoFrame === 'function'
    ? 'MediaStreamTrackGenerator'
    : 'canvas.captureStream';

  /** A device entry that passes `instanceof InputDeviceInfo` and serialises like a real one. */
  function deviceInfo() {
    var proto = window.InputDeviceInfo ? InputDeviceInfo.prototype : MediaDeviceInfo.prototype;
    var info = Object.create(proto);
    var values = { deviceId: DEVICE_ID, kind: 'videoinput', label: LABEL, groupId: GROUP_ID };
    Object.keys(values).forEach(function (key) {
      Object.defineProperty(info, key, { value: values[key], enumerable: true });
    });
    Object.defineProperty(info, 'toJSON', { value: function () { return Object.assign({}, values); } });
    Object.defineProperty(info, 'getCapabilities', { value: function () { return capabilities(1280, 720, 30); } });
    return info;
  }

  function capabilities(width, height, fps) {
    return {
      deviceId: DEVICE_ID,
      groupId: GROUP_ID,
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
      ctx.fillText(LABEL + '  ' + new Date().toISOString().slice(11, 23) + '  frame ' + frame, height / 24, height - height / 12);
      return frame;
    };
  }

  /** A video track of the moving test pattern, with settings and capabilities that look like a camera. */
  function makeTrack(format) {
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
          report('writing a frame failed: ' + (e && e.name ? e.name + ': ' + e.message : e));
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

    var constraints = {};
    var baseSettings = track.getSettings.bind(track);
    var stop = track.stop.bind(track);
    var settings = {
      deviceId: DEVICE_ID,
      groupId: GROUP_ID,
      width: width,
      height: height,
      frameRate: format.fps,
      aspectRatio: width / height,
      resizeMode: 'none',
    };
    Object.defineProperty(track, 'label', { get: function () { return LABEL; } });
    track.getSettings = function () { return Object.assign({}, baseSettings(), settings); };
    track.getCapabilities = function () { return capabilities(width, height, format.fps); };
    track.getConstraints = function () { return Object.assign({}, constraints); };
    track.applyConstraints = function (next) {
      constraints = next || {};
      report('applyConstraints ' + JSON.stringify(constraints));
      return Promise.resolve();
    };
    track.stop = function () {
      clearInterval(timer);
      var seconds = (performance.now() - started) / 1000;
      report('stopped after ' + frames + ' frames in ' + seconds.toFixed(1) + ' s (' + (frames / seconds).toFixed(1) + ' fps drawn)');
      stop();
    };
    track.addEventListener('ended', function () { clearInterval(timer); });
    return track;
  }

  var getUserMedia = async function (constraints) {
    var video = constraints && constraints.video;
    if (!video || typeof video !== 'object' || ids(video.deviceId).indexOf(DEVICE_ID) < 0) {
      return originalGetUserMedia.apply(this, arguments);
    }
    var stream = constraints.audio
      ? await originalGetUserMedia.call(this, { audio: constraints.audio })
      : new MediaStream();
    var format = chooseFormat(video);
    stream.addTrack(makeTrack(format));
    report('opened ' + format.width + 'x' + format.height + ' @ ' + format.fps + ' fps through ' + generatorKind +
      (constraints.audio ? ', with the real microphone' : '') + '; asked ' + JSON.stringify(video));
    return stream;
  };

  var enumerateDevices = async function () {
    var devices = Array.prototype.slice.call(await originalEnumerate.apply(this, arguments));
    // Last, so it never becomes the page's default camera.
    devices.push(deviceInfo());
    if (!listedOnce) {
      listedOnce = true;
      report('listed by enumerateDevices next to ' + (devices.length - 1) + ' real device(s)');
    }
    return devices;
  };

  getUserMedia.__multicord = true;
  enumerateDevices.__multicord = true;
  media.getUserMedia = getUserMedia;
  media.enumerateDevices = enumerateDevices;
  report('patch installed in ' + location.origin + ' (' + generatorKind + ')');
})();
