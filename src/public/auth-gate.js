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

  // Signed-in-as badge: mirrors the-dump-bin's auth-gate.js so tools hosted
  // directly off eod-api (dc-scan, trackers, email-outbox) show the same
  // "Signed in as <email> / Log out" bar. Decodes the email straight out of
  // the session JWT payload (display only — the server independently
  // verifies the token on every API call), so no extra network round trip.
  function decodeEmailFromToken(token) {
    try {
      var parts = String(token || '').split('.');
      if (parts.length < 2) return '';
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var binary = atob(b64);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      var json = new TextDecoder('utf-8').decode(bytes);
      var payload = JSON.parse(json);
      return (payload && payload.email) || '';
    } catch (_) {
      return '';
    }
  }

  function injectUserBadge(email) {
    if (!email || document.getElementById('__dumpbin_user_badge')) return;

    var bar = document.createElement('div');
    bar.id = '__dumpbin_user_badge';
    bar.setAttribute('style', [
      'display:flex', 'align-items:center', 'justify-content:flex-end',
      'flex-wrap:wrap', 'gap:10px', 'padding:6px 14px',
      'background:#141c27', 'border-bottom:1px solid #2f4562',
      'font-family:"Segoe UI",system-ui,-apple-system,sans-serif',
      'font-size:12px', 'line-height:1.4', 'color:#8fa3b8',
      'position:relative', 'z-index:1000',
    ].join(';'));

    var label = document.createElement('span');
    label.appendChild(document.createTextNode('Signed in as '));
    var emailEl = document.createElement('strong');
    emailEl.setAttribute('style', 'color:#e8ecf1;font-weight:600;word-break:break-all;');
    emailEl.textContent = email;
    label.appendChild(emailEl);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Log out';
    btn.setAttribute('style', [
      'padding:4px 12px', 'border-radius:6px', 'border:1px solid #2f4562',
      'background:#2a3a4e', 'color:#e8ecf1', 'font-size:12px',
      'font-weight:600', 'font-family:inherit', 'cursor:pointer',
    ].join(';'));
    btn.addEventListener('click', function () { signOut(); });

    bar.appendChild(label);
    bar.appendChild(btn);

    function place() {
      if (document.body.firstChild) {
        document.body.insertBefore(bar, document.body.firstChild);
      } else {
        document.body.appendChild(bar);
      }
    }
    if (document.body) place();
    else document.addEventListener('DOMContentLoaded', place);
  }

  function signOut() { clearSession(); bounceToSignIn('sign out'); }

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
    injectUserBadge(decodeEmailFromToken(getSession()));
    revealPage();
  })();

  window.dumpBinAuth = {
    API_BASE: API_BASE,
    getSession: getSession,
    setSession: setSession,
    clearSession: clearSession,
    signOut: signOut,
    fetch: authFetch,
    bounceToSignIn: bounceToSignIn,
    bootPromise: bootPromise,
  };
  window.dumpBinAuthFetch = authFetch;
  window.dumpBinSignOut = signOut;
  window.dumpBinAuthReady = bootPromise;
})();
