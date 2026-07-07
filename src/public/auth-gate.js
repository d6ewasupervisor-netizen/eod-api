/**
 * eod-api hosted tools — session gate (trackers, email outbox, etc.)
 * Sign-in redirects to the-dump-bin.com when not on that host.
 */
(function () {
  'use strict';

  var SESSION_KEY = 'dumpBinSession';
  var LEGACY_KEY = 'eodSession';
  var DUMP_BIN_SITE = 'https://the-dump-bin.com';

  var API_BASE = (function () {
    var hashApi = (location.hash.match(/api=([^&]+)/) || [])[1];
    if (hashApi) return decodeURIComponent(hashApi).replace(/\/+$/, '');
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      return 'http://localhost:3001';
    }
    return 'https://eod-api.the-dump-bin.com';
  })();

  function signInUrl() {
    var host = (location.hostname || '').toLowerCase();
    if (host === 'the-dump-bin.com' || host === 'www.the-dump-bin.com') {
      return '/signin.html';
    }
    if (host === 'localhost' || host === '127.0.0.1') {
      return DUMP_BIN_SITE + '/signin.html';
    }
    return DUMP_BIN_SITE + '/signin.html';
  }

  function getSession() {
    try {
      var v = localStorage.getItem(SESSION_KEY);
      if (v) return v;
      var legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        localStorage.setItem(SESSION_KEY, legacy);
        localStorage.removeItem(LEGACY_KEY);
        return legacy;
      }
    } catch (_) {}
    return '';
  }

  function setSession(v) { try { localStorage.setItem(SESSION_KEY, v); } catch (_) {} }
  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(LEGACY_KEY);
    } catch (_) {}
  }

  function bounceToSignIn(reason) {
    clearSession();
    try { console.warn('[auth-gate] redirect to signin:', reason || ''); } catch (_) {}
    var next = encodeURIComponent(location.href);
    var base = signInUrl();
    var join = base.indexOf('?') >= 0 ? '&' : '?';
    location.replace(base + join + 'next=' + next);
  }

  var _hideStyle = null;
  function hidePage() {
    if (_hideStyle) return;
    _hideStyle = document.createElement('style');
    _hideStyle.textContent = 'html, body { visibility: hidden !important; }';
    (document.head || document.documentElement).appendChild(_hideStyle);
  }
  function revealPage() {
    if (_hideStyle && _hideStyle.parentNode) _hideStyle.parentNode.removeChild(_hideStyle);
    _hideStyle = null;
  }

  async function exchangeLinkToken() {
    var qp = new URLSearchParams(location.search);
    var linkToken = qp.get('token');
    if (!linkToken) return !!getSession();
    hidePage();
    try {
      var res = await fetch(API_BASE + '/api/verify-token?token=' + encodeURIComponent(linkToken));
      var data = await res.json().catch(function () { return {}; });
      qp.delete('token');
      var newUrl = location.pathname + (qp.toString() ? ('?' + qp.toString()) : '') + location.hash;
      try { history.replaceState({}, '', newUrl); } catch (_) {}
      if (!res.ok || !data.ok || !data.token) return !!getSession();
      setSession(data.token);
      return true;
    } catch (_) {
      return !!getSession();
    }
  }

  async function authFetch(url, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    var tok = getSession();
    if (tok) headers.Authorization = 'Bearer ' + tok;
    var fullUrl = url;
    if (typeof url === 'string' && url.indexOf('/api/') === 0) fullUrl = API_BASE + url;
    var res = await fetch(fullUrl, Object.assign({}, opts, { headers }));
    if (res.status === 401 && !opts.noBounceOn401) bounceToSignIn('401');
    return res;
  }

  var bootPromise = (async function boot() {
    var qp = new URLSearchParams(location.search);
    var hasToken = !!qp.get('token');
    var hadSession = !!getSession();
    if (!hadSession && !hasToken) {
      hidePage();
      bounceToSignIn('no session');
      return;
    }
    if (hasToken) {
      hidePage();
      var ok = await exchangeLinkToken();
      if (!ok) {
        bounceToSignIn('verify-token failed');
        return;
      }
    }
    revealPage();
  })();

  window.dumpBinAuth = {
    API_BASE: API_BASE,
    getSession: getSession,
    setSession: setSession,
    clearSession: clearSession,
    signOut: function () { clearSession(); bounceToSignIn('sign out'); },
    fetch: authFetch,
    bounceToSignIn: bounceToSignIn,
    bootPromise: bootPromise,
  };
  window.dumpBinAuthFetch = authFetch;
  window.dumpBinAuthReady = bootPromise;
})();
