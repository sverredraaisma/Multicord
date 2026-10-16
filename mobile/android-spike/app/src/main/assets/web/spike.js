// Multicord Android spike (phase 0). Copyright (C) 2026 Multicord contributors.
// AGPL-3.0-or-later, see LICENSE at the repo root.
//
// Shared by the test pages: a log on the page that also goes to the app's results through the
// origin-restricted "multicordSpike" listener.
'use strict';

window.spike = (function () {
  var out = null;

  function log(text) {
    if (!out) out = document.getElementById('log');
    if (out) out.textContent += text + '\n';
    if (window.multicordSpike) window.multicordSpike.postMessage(String(text));
  }

  function describeError(e) {
    return e && e.name ? e.name + ': ' + e.message : String(e);
  }

  /** Runs an async action from a button, logging any failure instead of losing it. */
  function button(id, action) {
    var element = document.getElementById(id);
    element.addEventListener('click', function () {
      element.disabled = true;
      Promise.resolve()
        .then(action)
        .catch(function (e) { log(id + ' failed: ' + describeError(e)); })
        .then(function () { element.disabled = false; });
    });
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  return { log: log, describeError: describeError, button: button, sleep: sleep };
})();
