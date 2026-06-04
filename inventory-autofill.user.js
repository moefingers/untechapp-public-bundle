// ==UserScript==
// @name         untechapp
// @namespace    https://unbrinks.vercel.app/tools
// @homepageURL  https://unbrinks.vercel.app/tools/untechapp
// @supportURL   https://unbrinks.vercel.app/tools/untechapp
// @updateURL    https://raw.githubusercontent.com/moefingers/untechapp-public-bundle/main/inventory-autofill.user.js
// @downloadURL  https://raw.githubusercontent.com/moefingers/untechapp-public-bundle/main/inventory-autofill.user.js
// @version      3.10.0
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
// @connect      localhost
// @connect      127.0.0.1
// @resource     theme-default-logo https://unbrinks.vercel.app/assets/tools/unbrinks.png
// @resource     theme-2k-logo https://unbrinks.vercel.app/assets/tools/themes/2k/brinks-2klogo.webp
// @resource     theme-2k-kobe https://unbrinks.vercel.app/assets/tools/themes/2k/nba2k-kobe-bryant.webp
// @resource     theme-2k-mamba https://unbrinks.vercel.app/assets/tools/themes/2k/nba2k-black-mamba.webp
// @resource     theme-2k-25th https://unbrinks.vercel.app/assets/tools/themes/2k/nba2k-25th-anniversary.webp
// @tampermonkey-safari-promotion-code-request 964da2e8-5504-4b9b-a8ad-0c744decaa52
// ==/UserScript==

(function () {
  'use strict';

  // Capture location.pathname AT LOADER START — earliest moment we can
  // observe the URL the user requested. Vue's chunks load after the
  // userscript and run beforeEach guards that redirect unknown routes
  // to /404 BEFORE our bundle's IIFE evaluates (on cache-hot loads the
  // bundle injects synchronously, but on cold loads the bundle fetch
  // is async and Vue wins the race). The bundle reads this via
  // window.__untechappInitialPath and falls back to location.pathname
  // when missing (dev path / direct injection).
  //
  // unsafeWindow because the userscript runs in an isolated realm by
  // default; the bundle injected via document.createElement('script')
  // runs in the page realm and needs the property on the same window.
  try {
    unsafeWindow.__untechappInitialPath = location.pathname;
  } catch (_) {
    /* unsafeWindow unavailable in some browsers; bundle has fallback */
  }

  const LOADER_VERSION = '3.10.0';
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
    // The public-bundle GitHub raw is the canonical install/update URL —
    // matches @updateURL/@downloadURL above so manual "update now" from
    // inside untechapp's panel hits the same source Tampermonkey's
    // automatic update check uses. Don't point this at an unbrinks-hosted
    // copy: that lags Vercel deploys and was a source of divergence.
    loaderUrl: 'https://raw.githubusercontent.com/moefingers/untechapp-public-bundle/main/inventory-autofill.user.js',
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

  // ── GM cookie bridge ───────────────────────────────────────────────
  // Exposes GM_cookie.{list,set,delete} as window.__untechappCookie.*
  // so the bundle (which runs in page context, not userscript context)
  // can read AND write HttpOnly cookies. Required by the offline session
  // keep-alive flow:
  //   - list(): collect AppServiceAuthSession from techapp to push to
  //     unbrinks for server-side refresh
  //   - set(): write server-refreshed cookies BACK into the browser at
  //     boot so /.auth/refresh from the tab uses the latest Azure-rotated
  //     value instead of a stale one
  //   - delete(): wipe browser-side cookies on explicit sign-out so the
  //     cron's refreshed value isn't replayed by a leftover tab
  //
  // Requires Tampermonkey "Allow scripts to access cookies" in Advanced
  // settings + @grant GM_cookie in this header. All three return a
  // Promise — wrapping the callback-style API.
  try {
    if (typeof GM_cookie !== 'undefined' && GM_cookie && typeof GM_cookie.list === 'function') {
      const listCookies = function (details) {
        return new Promise(function (resolve) {
          try {
            GM_cookie.list(details || {}, function (cookies, error) {
              resolve({ cookies: cookies || [], error: error || null });
            });
          } catch (e) {
            resolve({ cookies: [], error: String(e) });
          }
        });
      };
      const setCookie = function (details) {
        return new Promise(function (resolve) {
          try {
            if (typeof GM_cookie.set !== 'function') {
              resolve({ ok: false, error: 'GM_cookie.set not available' });
              return;
            }
            GM_cookie.set(details || {}, function (error) {
              resolve({ ok: !error, error: error || null });
            });
          } catch (e) {
            resolve({ ok: false, error: String(e) });
          }
        });
      };
      const deleteCookie = function (details) {
        return new Promise(function (resolve) {
          try {
            if (typeof GM_cookie.delete !== 'function') {
              resolve({ ok: false, error: 'GM_cookie.delete not available' });
              return;
            }
            GM_cookie.delete(details || {}, function (error) {
              resolve({ ok: !error, error: error || null });
            });
          } catch (e) {
            resolve({ ok: false, error: String(e) });
          }
        });
      };
      const cookieBridge = { list: listCookies, set: setCookie, delete: deleteCookie };
      if (typeof exportFunction === 'function') {
        unsafeWindow.__untechappCookie = cloneInto({}, unsafeWindow);
        unsafeWindow.__untechappCookie.list = exportFunction(listCookies, unsafeWindow);
        unsafeWindow.__untechappCookie.set = exportFunction(setCookie, unsafeWindow);
        unsafeWindow.__untechappCookie.delete = exportFunction(deleteCookie, unsafeWindow);
      } else {
        unsafeWindow.__untechappCookie = cookieBridge;
      }
    }
  } catch (e) {
    console.warn('[untechapp loader] GM cookie bridge failed:', e);
  }

  // ── GM storage bridge ──────────────────────────────────────────────
  try {
    // Dev-server bridge (CSP-bypass remote channel). GM_xmlhttpRequest runs in
    // the EXTENSION context — exempt from the page's CSP — so the bundle can
    // reach the local dev-server on EVERY origin it runs on (techapp,
    // login.microsoftonline.com, the /.auth callback hops), even where a
    // page-context WebSocket is blocked. Scoped to localhost:9876 only.
    const devRequest = function (opts) {
      return new Promise(function (resolve) {
        try {
          const o = opts || {};
          const p = String(o.path || '/');
          const url =
            'http://localhost:9876' + (p.charAt(0) === '/' ? p : '/' + p);
          GM_xmlhttpRequest({
            method: o.method || 'GET',
            url: url,
            data: o.body != null ? o.body : undefined,
            headers: { 'Content-Type': 'application/json' },
            timeout: o.timeoutMs || 30000,
            onload: function (r) {
              resolve({ ok: true, status: r.status, body: r.responseText || '' });
            },
            onerror: function () {
              resolve({ ok: false, status: 0, body: '' });
            },
            ontimeout: function () {
              resolve({ ok: false, status: 0, body: '' });
            },
          });
        } catch (e) {
          resolve({ ok: false, status: 0, body: String(e) });
        }
      });
    };
    const storageBridge = {
      get: function (key, fallback) { return GM_getValue(key, fallback); },
      set: function (key, value) { GM_setValue(key, value); },
      getResource: function (name) {
        try { return GM_getResourceURL(name); }
        catch { return null; }
      },
      devRequest: devRequest,
    };
    if (typeof exportFunction === 'function') {
      unsafeWindow.__untechappStorage = cloneInto({}, unsafeWindow);
      unsafeWindow.__untechappStorage.get = exportFunction(storageBridge.get, unsafeWindow);
      unsafeWindow.__untechappStorage.set = exportFunction(storageBridge.set, unsafeWindow);
      unsafeWindow.__untechappStorage.getResource = exportFunction(storageBridge.getResource, unsafeWindow);
      unsafeWindow.__untechappStorage.devRequest = exportFunction(storageBridge.devRequest, unsafeWindow);
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
