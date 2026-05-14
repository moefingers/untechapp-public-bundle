// ==UserScript==
// @name         untechapp
// @namespace    https://unbrinks.vercel.app/tools
// @homepageURL  https://unbrinks.vercel.app/tools/untechapp
// @supportURL   https://unbrinks.vercel.app/tools/untechapp
// @updateURL    https://raw.githubusercontent.com/moefingers/untechapp-public-bundle/main/inventory-autofill.user.js
// @downloadURL  https://raw.githubusercontent.com/moefingers/untechapp-public-bundle/main/inventory-autofill.user.js
// @version      3.7.0
// @description  Live loader for untechapp. Caches the bundle in extension storage, injects at document-start, checks for updates via API.
// @author       moefingers
// @match        https://techapp.brinkshome.com/*
// @match        https://login.microsoftonline.com/*
// @match        https://unbrinks.vercel.app/tools/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_getResourceURL
// @grant        GM_cookie
// @grant        unsafeWindow
// @connect      unbrinks.vercel.app
// @connect      login.microsoftonline.com
// @resource     theme-default-logo https://unbrinks.vercel.app/assets/tools/unbrinks.png
// @resource     theme-2k-logo https://unbrinks.vercel.app/assets/tools/themes/2k/brinks-2klogo.webp
// @resource     theme-2k-kobe https://unbrinks.vercel.app/assets/tools/themes/2k/nba2k-kobe-bryant.webp
// @resource     theme-2k-mamba https://unbrinks.vercel.app/assets/tools/themes/2k/nba2k-black-mamba.webp
// @resource     theme-2k-25th https://unbrinks.vercel.app/assets/tools/themes/2k/nba2k-25th-anniversary.webp
// @tampermonkey-safari-promotion-code-request 964da2e8-5504-4b9b-a8ad-0c744decaa52
// ==/UserScript==

(function () {
  'use strict';

  const LOADER_VERSION = '3.7.0';
  const BUNDLE_API = 'https://unbrinks.vercel.app/api/tools/userscript/bundle';
  const CONNECT_API = 'https://unbrinks.vercel.app/api/tools/userscript/connect';
  // Bundle-side counterparts live in untechapp/src/config.ts +
  // untechapp/src/prefs.ts. Renaming either side without the other
  // breaks the connect handshake — Reconnect writes one key and the
  // bundle reads another, panel stays NOT CONNECTED.
  const LS_API_KEY = 'untechapp:auth:api-key';
  const GM_API_KEY = 'untechapp:auth:api-key';

  const K_BUNDLE = 'untechapp:loader:bundle';
  const K_VERSION = 'untechapp:loader:version';
  const K_PENDING_BUNDLE = 'untechapp:loader:pending-bundle';
  const K_PENDING_VERSION = 'untechapp:loader:pending-version';
  const GM_USER_EMAIL = 'untechapp:auth:user-email';

  const isUnbrinks = location.hostname === 'unbrinks.vercel.app';

  function parseVersion(source) {
    const m = source.match(/@version\s+(\S+)/);
    return m ? m[1] : null;
  }

  function isNewer(remote, current) {
    if (!remote || !current) return false;
    const rp = remote.split('.').map(Number);
    const cp = current.split('.').map(Number);
    for (let i = 0; i < Math.max(rp.length, cp.length); i++) {
      const rv = rp[i] || 0, cv = cp[i] || 0;
      if (rv > cv) return true;
      if (rv < cv) return false;
    }
    return false;
  }

  function getApiKey() {
    const gm = GM_getValue(GM_API_KEY, '');
    if (gm) return gm;
    try { return unsafeWindow.localStorage.getItem(LS_API_KEY) || ''; }
    catch { return ''; }
  }

  // ── Expose loader metadata ────────────────────────────────────────
  const loaderMeta = {
    loaderVersion: LOADER_VERSION,
    loaderUrl: 'https://unbrinks.vercel.app/assets/tools/inventory-autofill.user.js',
    bundleVersion: GM_getValue(K_VERSION, '') || null,
    updateAvailable: null,
  };

  try {
    if (typeof cloneInto === 'function') {
      unsafeWindow.__untechappLoader = cloneInto(loaderMeta, unsafeWindow);
    } else {
      unsafeWindow.__untechappLoader = loaderMeta;
    }
  } catch (e) {
    unsafeWindow.__untechappLoader = loaderMeta;
  }

  // ── GM storage bridge ──────────────────────────────────────────────
  try {
    const storageBridge = {
      get: function (key, fallback) { return GM_getValue(key, fallback); },
      set: function (key, value) { GM_setValue(key, value); },
      getResource: function (name) {
        try { return GM_getResourceURL(name); }
        catch { return null; }
      },
    };
    if (typeof exportFunction === 'function') {
      unsafeWindow.__untechappStorage = cloneInto({}, unsafeWindow);
      unsafeWindow.__untechappStorage.get = exportFunction(storageBridge.get, unsafeWindow);
      unsafeWindow.__untechappStorage.set = exportFunction(storageBridge.set, unsafeWindow);
      unsafeWindow.__untechappStorage.getResource = exportFunction(storageBridge.getResource, unsafeWindow);
    } else {
      unsafeWindow.__untechappStorage = storageBridge;
    }
  } catch (e) {
    console.warn('[untechapp loader] GM storage bridge failed:', e);
  }

  // ── Unbrinks domain: auto-connect, no bundle injection ────────────
  if (isUnbrinks) {
    var existingToken = GM_getValue(GM_API_KEY, '');
    if (existingToken) {
      signalAuth({ status: 'connected' });
    } else {
      signalAuth({ status: 'connecting' });
      fetch(CONNECT_API, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      }).then(function (res) {
        if (res.status === 200) {
          return res.json().then(function (data) {
            GM_setValue(GM_API_KEY, data.token);
            if (data.email) GM_setValue(GM_USER_EMAIL, data.email);
            signalAuth({ status: 'connected', label: data.label, email: data.email });
          });
        } else if (res.status === 401) {
          signalAuth({ status: 'unauthenticated' });
        } else {
          signalAuth({ status: 'error', message: 'HTTP ' + res.status });
        }
      }).catch(function (err) {
        signalAuth({ status: 'error', message: err.message || 'Network error' });
      });
    }
    return; // don't inject bundle or check updates on unbrinks
  }

  // ── Promote pending bundle ────────────────────────────────────────
  var pendingVersion = GM_getValue(K_PENDING_VERSION, '');
  var cachedVersion = GM_getValue(K_VERSION, '');

  if (pendingVersion && isNewer(pendingVersion, cachedVersion)) {
    var pendingBundle = GM_getValue(K_PENDING_BUNDLE, '');
    if (pendingBundle) {
      GM_setValue(K_BUNDLE, pendingBundle);
      GM_setValue(K_VERSION, pendingVersion);
      GM_setValue(K_PENDING_BUNDLE, '');
      GM_setValue(K_PENDING_VERSION, '');
      cachedVersion = pendingVersion;
      console.info('[untechapp loader] promoted pending v' + pendingVersion);
    }
  }

  // ── Read cached bundle ────────────────────────────────────────────
  var bundle = GM_getValue(K_BUNDLE, '');
  var version = GM_getValue(K_VERSION, '');

  // ── Inject bundle into the page realm ─────────────────────────────
  function inject(code) {
    var el = document.createElement('script');
    var existingScript = document.querySelector('script[nonce]');
    if (existingScript) {
      el.nonce = existingScript.nonce || existingScript.getAttribute('nonce') || '';
    }
    el.textContent = code;
    el.dataset.untechappLoader = 'live';
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  }

  if (bundle) {
    inject(bundle);
    console.info('[untechapp loader] injected cached v' + version + ' (' + (bundle.length / 1024).toFixed(0) + ' KB)');
  } else {
    console.info('[untechapp loader] no cache, fetching bundle...');
    fetchBundle(function (code, ver) {
      GM_setValue(K_BUNDLE, code);
      GM_setValue(K_VERSION, ver);
      try { unsafeWindow.__untechappLoader.bundleVersion = ver; } catch (e) {}
      inject(code);
      console.info('[untechapp loader] cold start complete, cached v' + ver);
    });
    setupCommandListener();
    return;
  }

  // ── Background update check ───────────────────────────────────────
  checkBundleUpdate();
  setupCommandListener();

  function setupCommandListener() {
    document.addEventListener('__untechapp_loader_cmd', function (e) {
      var data;
      try { data = JSON.parse(e.detail); } catch { return; }
      if (data.action === 'checkBundleUpdate') checkBundleUpdate();
      if (data.action === 'applyUpdate') location.reload();
    });
  }

  // ── Fetch full bundle from API ────────────────────────────────────
  function fetchBundle(callback) {
    var apiKey = getApiKey();
    if (!apiKey) {
      console.warn('[untechapp loader] no API key \u2014 cannot fetch bundle');
      return;
    }
    GM_xmlhttpRequest({
      method: 'GET',
      url: BUNDLE_API,
      headers: { Authorization: 'Bearer ' + apiKey },
      timeout: 30000,
      onload: function (res) {
        if (res.status === 401) {
          console.warn('[untechapp loader] API key rejected (401)');
          return;
        }
        if (res.status !== 200 || !res.responseText) return;
        var code = res.responseText;
        var ver = parseVersion(code) || 'unknown';
        callback(code, ver);
      },
      onerror: function () { console.error('[untechapp loader] fetch error'); },
      ontimeout: function () { console.error('[untechapp loader] fetch timeout'); },
    });
  }

  // ── Check for bundle update via API ───────────────────────────────
  function checkBundleUpdate() {
    var apiKey = getApiKey();
    var currentVersion = GM_getValue(K_VERSION, '');
    if (!apiKey) {
      signal('bundle', { version: currentVersion, update: false });
      return;
    }

    var versionSignaled = false;

    GM_xmlhttpRequest({
      method: 'GET',
      url: BUNDLE_API + '?v=' + encodeURIComponent(currentVersion),
      headers: { Authorization: 'Bearer ' + apiKey },
      timeout: 15000,
      onprogress: function (res) {
        if (versionSignaled) return;
        var text = res.responseText || '';
        if (text.length > 2 && text.trimStart().startsWith('{')) {
          versionSignaled = true;
          return;
        }
        if (text.length < 100) return;
        var remoteVersion = parseVersion(text);
        if (!remoteVersion) return;
        versionSignaled = true;
        if (isNewer(remoteVersion, currentVersion)) {
          signal('bundle', { version: remoteVersion, update: true, stage: 'downloading' });
        }
      },
      onload: function (res) {
        if (res.status === 401) {
          signal('bundle', { version: currentVersion, update: false, error: 'auth' });
          return;
        }
        if (res.status !== 200 || !res.responseText) {
          signal('bundle', { version: currentVersion, update: false, error: 'http' });
          return;
        }

        var text = res.responseText.trim();
        if (text.startsWith('{')) {
          try {
            var data = JSON.parse(text);
            signal('bundle', { version: data.version || currentVersion, update: false });
          } catch (e) {
            signal('bundle', { version: currentVersion, update: false });
          }
          return;
        }

        var remoteVersion = parseVersion(text);
        if (!remoteVersion || !isNewer(remoteVersion, currentVersion)) {
          signal('bundle', { version: currentVersion, update: false });
          return;
        }
        GM_setValue(K_PENDING_BUNDLE, text);
        GM_setValue(K_PENDING_VERSION, remoteVersion);
        signal('bundle', { version: remoteVersion, update: true, stage: 'ready' });
      },
      onerror: function () { signal('bundle', { update: false, error: 'network' }); },
      ontimeout: function () { signal('bundle', { update: false, error: 'timeout' }); },
    });
  }

  // ── Signal the running bundle ─────────────────────────────────────
  function signal(type, data) {
    data.type = type;
    try {
      var key = type === 'bundle' ? 'bundleCheckResult' : 'loaderCheckResult';
      unsafeWindow.__untechappLoader[key] = data;
      if (data.update && data.version) {
        unsafeWindow.__untechappLoader.updateAvailable = data.version;
      }
    } catch (e) {}
    try {
      document.dispatchEvent(new CustomEvent('__untechapp_loader_update', {
        detail: JSON.stringify(data),
      }));
    } catch (e) {}
  }

  // ── Signal the setup wizard on unbrinks ───────────────────────────
  function signalAuth(data) {
    try {
      unsafeWindow.__untechappAuth = data;
    } catch (e) {}
    try {
      document.dispatchEvent(new CustomEvent('__untechapp_auth', {
        detail: JSON.stringify(data),
      }));
    } catch (e) {}
  }
})();
