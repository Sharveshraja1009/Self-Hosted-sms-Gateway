/* SMS Gateway - public download page.
   Class-based DOM only, no inline handlers: the production CSP allows 'self'
   scripts and nothing else. */

(function () {
  'use strict';

  function $(id) {
    return document.getElementById(id);
  }

  /** "20 Jul 2026" plus a plain-English gap, because both are useful. */
  function describeDate(iso) {
    var when = new Date(iso);
    if (isNaN(when.getTime())) return '—';

    var absolute = when.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    var days = Math.floor((Date.now() - when.getTime()) / 86400000);

    if (days <= 0) return 'updated today · ' + absolute;
    if (days === 1) return 'updated yesterday · ' + absolute;
    if (days < 30) return 'updated ' + days + ' days ago · ' + absolute;

    return 'updated ' + absolute;
  }

  function render(data) {
    // The href is already correct in the HTML; this only re-points it if the
    // server ever publishes the artefact somewhere else.
    if (data.url) $('download-btn').setAttribute('href', data.url);
    if (data.filename) {
      $('download-btn').setAttribute('download', data.filename);
      document.querySelector('.file-name').textContent = data.filename;
    }

    var version = $('version');
    if (data.version) {
      version.textContent =
        'version ' + data.version + (data.versionCode ? ' (build ' + data.versionCode + ')' : '');
    } else {
      // No sidecar. Say nothing rather than inventing a version number - a wrong
      // one is worse than an absent one when someone is deciding whether to update.
      version.classList.add('hidden');
    }

    $('size').textContent = data.sizeLabel || '—';
    $('updated').textContent = describeDate(data.updatedAt);

    var status = $('status');
    if (data.minAndroid) {
      status.textContent = 'Requires Android ' + data.minAndroid + ' or newer.';
    } else {
      status.classList.add('hidden');
    }
  }

  function failed(message) {
    var status = $('status');
    status.textContent = message;
    status.classList.remove('muted');
    status.classList.add('warn');
  }

  function load() {
    fetch('/api/app/latest', { headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (response.status === 404) {
          throw new Error('No app has been published on this server yet.');
        }
        if (!response.ok) {
          throw new Error('Could not read the build details (HTTP ' + response.status + ').');
        }
        return response.json();
      })
      .then(function (body) {
        render(body.data || {});
      })
      .catch(function (error) {
        // The download button is a plain link and still works; only the details
        // are missing. Say which, so nobody assumes the app itself is broken.
        failed(error.message + ' The download button still works.');
      });
  }

  load();
})();
