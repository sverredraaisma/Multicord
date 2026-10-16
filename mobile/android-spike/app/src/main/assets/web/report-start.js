// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
//
// A document-start script (WebViewCompat.addDocumentStartJavaScript), registered only for the page's own
// origin. It reports that it ran and which media APIs the page sees, through the origin-restricted
// "multicordSpike" message listener. It reads nothing of the page: no storage, no cookies, no tokens.
(function () {
  'use strict';
  if (window.__multicordSpikeStart) return;
  window.__multicordSpikeStart = true;

  function has(object, name) {
    return !!object && typeof object[name] === 'function' ? 'yes' : 'no';
  }

  var md = navigator.mediaDevices;
  var report = [
    'document-start ran in the ' + (window.top === window ? 'top frame' : 'a subframe') + ' of ' + location.origin,
    'secure context: ' + window.isSecureContext,
    'navigator.mediaDevices: ' + (md ? 'yes' : 'no'),
    'getUserMedia: ' + has(md, 'getUserMedia'),
    'enumerateDevices: ' + has(md, 'enumerateDevices'),
    'getDisplayMedia: ' + has(md, 'getDisplayMedia'),
    'MediaStreamTrackGenerator: ' + typeof window.MediaStreamTrackGenerator,
    'VideoTrackGenerator: ' + typeof window.VideoTrackGenerator,
    'ImageDecoder: ' + typeof window.ImageDecoder,
    'Notification: ' + typeof window.Notification,
    'userAgentData.mobile: ' + (navigator.userAgentData ? navigator.userAgentData.mobile : 'n/a'),
  ].join('; ');

  function send(note) {
    if (!window.multicordSpike) return false;
    window.multicordSpike.postMessage(report + note);
    return true;
  }

  // The listener object should exist before document-start scripts run; if not, say so once it does.
  if (!send('')) {
    document.addEventListener('DOMContentLoaded', function () {
      if (!send(' (the listener object only appeared after DOMContentLoaded)')) {
        console.warn('multicordSpike listener missing');
      }
    });
  }
})();
