// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
//
// Spike 0.4: what Tier B's page side costs (docs/mobile.md, section 4.2, steps 4 and 7): JPEG bytes to
// VideoFrame with ImageDecoder, then into a MediaStreamTrackGenerator at camera pace.
(function () {
  'use strict';
  var log = spike.log;
  var frames = null;

  function stats(times) {
    var sorted = times.slice().sort(function (a, b) { return a - b; });
    var sum = sorted.reduce(function (a, b) { return a + b; }, 0);
    return {
      mean: sum / sorted.length,
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      max: sorted[sorted.length - 1],
      sum: sum,
    };
  }

  async function load() {
    if (frames) return frames;
    if (typeof ImageDecoder !== 'function') throw new Error('ImageDecoder is not available in this WebView');
    var supported = await ImageDecoder.isTypeSupported('image/jpeg');
    if (!supported) throw new Error('ImageDecoder does not support image/jpeg here');
    var manifest = await (await fetch('frames/frames.json')).json();
    var list = [];
    var bytes = 0;
    for (var i = 0; i < manifest.count; i++) {
      var name = 'frames/frame' + String(i).padStart(2, '0') + '.jpg';
      var buffer = await (await fetch(name)).arrayBuffer();
      bytes += buffer.byteLength;
      list.push(buffer);
    }
    log('loaded ' + list.length + ' frames of ' + manifest.width + 'x' + manifest.height + ', ' +
      (bytes / list.length / 1024).toFixed(0) + ' KB each on average; ' + navigator.hardwareConcurrency + ' logical cores');
    frames = list;
    return frames;
  }

  async function decode(buffer) {
    var decoder = new ImageDecoder({ data: buffer, type: 'image/jpeg' });
    try {
      var result = await decoder.decode();
      return result.image;
    } finally {
      decoder.close();
    }
  }

  /** A: every frame three times, one after another, nothing else running. */
  async function fast() {
    var list = await load();
    var first = await decode(list[0]);
    log('A: ImageDecoder gives ' + first.constructor.name + ' ' + first.codedWidth + 'x' + first.codedHeight + ', format ' + first.format);
    first.close();
    var times = [];
    var start = performance.now();
    for (var pass = 0; pass < 3; pass++) {
      for (var i = 0; i < list.length; i++) {
        var t0 = performance.now();
        var frame = await decode(list[i]);
        times.push(performance.now() - t0);
        frame.close();
      }
    }
    var wall = performance.now() - start;
    var s = stats(times);
    log('A: ' + times.length + ' decodes in ' + (wall / 1000).toFixed(2) + ' s = ' + (times.length * 1000 / wall).toFixed(1) +
      ' fps; per frame mean ' + s.mean.toFixed(1) + ' ms, p95 ' + s.p95.toFixed(1) + ' ms, max ' + s.max.toFixed(1) +
      ' ms; at 30 fps that is ' + (s.mean / (1000 / 30) * 100).toFixed(0) + '% of the frame budget');
  }

  /** How late a 10 ms timer fires: the page's main thread being busy shows up here. */
  function lagMonitor() {
    var worst = 0;
    var total = 0;
    var samples = 0;
    var expected = performance.now() + 10;
    var timer = setInterval(function () {
      var now = performance.now();
      var lag = Math.max(0, now - expected);
      worst = Math.max(worst, lag);
      total += lag;
      samples++;
      expected = now + 10;
    }, 10);
    return function stop() {
      clearInterval(timer);
      return { worst: worst, mean: samples ? total / samples : 0 };
    };
  }

  /** B: decode at 30 fps and write into a generated track shown in the video element, for 10 s. */
  async function realtime() {
    var list = await load();
    if (typeof MediaStreamTrackGenerator !== 'function') {
      log('B: MediaStreamTrackGenerator is not available; skipping (Tier B would need canvas.captureStream)');
      return;
    }
    var generator = new MediaStreamTrackGenerator({ kind: 'video' });
    var writer = generator.writable.getWriter();
    var video = document.getElementById('preview');
    video.srcObject = new MediaStream([generator]);
    // Not awaited: play() only settles once the first frame arrives, and the frames come below.
    video.play().catch(function () {});

    var shown = 0;
    var canCount = typeof video.requestVideoFrameCallback === 'function';
    var counting = canCount;
    if (counting) {
      var tick = function () {
        shown++;
        if (counting) video.requestVideoFrameCallback(tick);
      };
      video.requestVideoFrameCallback(tick);
    }

    var stopLag = lagMonitor();
    var times = [];
    var skipped = 0;
    var busy = false;
    var index = 0;
    var start = performance.now();
    await new Promise(function (resolve) {
      var timer = setInterval(function () {
        if (performance.now() - start >= 10000) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (busy) {
          skipped++;
          return;
        }
        busy = true;
        var t0 = performance.now();
        decode(list[index++ % list.length]).then(function (frame) {
          return writer.write(frame); // The generator closes the frame.
        }).then(function () {
          times.push(performance.now() - t0);
          busy = false;
        }, function (e) {
          busy = false;
          log('B: frame failed: ' + spike.describeError(e));
        });
      }, 1000 / 30);
    });
    for (var waited = 0; busy && waited < 2000; waited += 5) await spike.sleep(5);
    if (busy) log('B: the last frame never finished writing');
    var wall = performance.now() - start;
    counting = false;
    var lag = stopLag();
    generator.stop();
    video.srcObject = null;

    var s = stats(times);
    log('B: ' + times.length + ' frames written in ' + (wall / 1000).toFixed(1) + ' s (' + (times.length * 1000 / wall).toFixed(1) +
      ' fps), ' + skipped + ' ticks skipped because the previous frame was not done; decode+write mean ' + s.mean.toFixed(1) +
      ' ms, p95 ' + s.p95.toFixed(1) + ' ms; busy ' + (s.sum / wall * 100).toFixed(0) + '% of the time; ' +
      (canCount ? (shown * 1000 / wall).toFixed(1) + ' fps shown; ' : '') +
      'main-thread lag mean ' + lag.mean.toFixed(1) + ' ms, worst ' + lag.worst.toFixed(1) + ' ms');
  }

  spike.button('fast', fast);
  spike.button('realtime', realtime);
  spike.button('both', async function () {
    await fast();
    await realtime();
  });
  log('decode page ready; ImageDecoder: ' + typeof window.ImageDecoder + ', MediaStreamTrackGenerator: ' +
    typeof window.MediaStreamTrackGenerator);
})();
