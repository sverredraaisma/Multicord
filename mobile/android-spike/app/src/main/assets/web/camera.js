// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
//
// Spike 0.2: which cameras the WebView lists, and what each one delivers when opened.
(function () {
  'use strict';
  var log = spike.log;
  var md = navigator.mediaDevices;
  var preview = document.getElementById('preview');

  function short(id) {
    return id ? id.slice(0, 8) : '(empty)';
  }

  function range(r) {
    if (r === undefined) return '?';
    if (typeof r === 'object') return (r.min !== undefined ? r.min : '?') + '-' + (r.max !== undefined ? r.max : '?');
    return String(r);
  }

  async function list() {
    var devices = await md.enumerateDevices();
    log('enumerateDevices: ' + devices.length + ' device(s)');
    devices.forEach(function (d) {
      log('  ' + d.kind + ' "' + (d.label || '(no label before permission)') + '" id ' + short(d.deviceId) +
        ' group ' + short(d.groupId));
    });
    return devices;
  }

  async function permission() {
    var stream = await md.getUserMedia({ video: true, audio: true });
    log('permission granted: ' + stream.getTracks().map(function (t) { return t.kind + ' "' + t.label + '"'; }).join(', '));
    stream.getTracks().forEach(function (t) { t.stop(); });
  }

  /** Frames actually shown in `ms`, counted per video frame where the WebView supports it. */
  async function measureFps(video, ms) {
    if (typeof video.requestVideoFrameCallback === 'function') {
      var frames = 0;
      var counting = true;
      var tick = function () {
        frames++;
        if (counting) video.requestVideoFrameCallback(tick);
      };
      video.requestVideoFrameCallback(tick);
      await spike.sleep(ms);
      counting = false;
      return frames * 1000 / ms;
    }
    var before = video.getVideoPlaybackQuality().totalVideoFrames;
    await spike.sleep(ms);
    return (video.getVideoPlaybackQuality().totalVideoFrames - before) * 1000 / ms;
  }

  async function openOne(device, width, height) {
    var name = '"' + (device.label || short(device.deviceId)) + '"';
    var stream = await md.getUserMedia({
      video: { deviceId: { exact: device.deviceId }, width: { ideal: width }, height: { ideal: height } },
    });
    var track = stream.getVideoTracks()[0];
    try {
      preview.srcObject = stream;
      await preview.play().catch(function () {});
      await spike.sleep(500);
      var s = track.getSettings();
      var caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};
      var fps = await measureFps(preview, 3000);
      log(name + ' asked ' + width + 'x' + height + ': settings ' + s.width + 'x' + s.height + ' @ ' + s.frameRate +
        ' fps, facingMode ' + (s.facingMode || 'n/a') + '; measured ' + fps.toFixed(1) + ' fps at ' +
        preview.videoWidth + 'x' + preview.videoHeight + '; capabilities ' + range(caps.width) + ' x ' +
        range(caps.height) + ' @ ' + range(caps.frameRate) + ' fps');
    } finally {
      track.stop();
      preview.srcObject = null;
    }
  }

  async function openAll() {
    var size = document.getElementById('size').value.split('x').map(Number);
    var cameras = (await list()).filter(function (d) { return d.kind === 'videoinput'; });
    // Before permission the ids are empty and cannot be opened one by one: ask once, then list again.
    if (cameras.some(function (d) { return !d.deviceId; })) {
      var probe = await md.getUserMedia({ video: true });
      probe.getTracks().forEach(function (t) { t.stop(); });
      cameras = (await list()).filter(function (d) { return d.kind === 'videoinput'; });
    }
    if (cameras.length === 0) log('no videoinput devices');
    for (var i = 0; i < cameras.length; i++) {
      try {
        await openOne(cameras[i], size[0], size[1]);
      } catch (e) {
        log('"' + (cameras[i].label || short(cameras[i].deviceId)) + '" failed: ' + spike.describeError(e));
      }
    }
    log('done opening cameras');
  }

  spike.button('list', list);
  spike.button('permission', permission);
  spike.button('openAll', openAll);
  md.addEventListener('devicechange', function () {
    log('devicechange event');
    list().catch(function (e) { log('list failed: ' + spike.describeError(e)); });
  });
  list().catch(function (e) { log('list failed: ' + spike.describeError(e)); });
})();
