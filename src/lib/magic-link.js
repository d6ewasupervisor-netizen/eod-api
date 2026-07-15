// Build emailed magic-link URLs for the-dump-bin.com sign-in flow.
//
// Links land on /open-sign-in.html first so mobile mail apps (Gmail, Outlook,
// etc.) can prompt the user to open in Chrome or another full browser instead
// of an in-app WebView where sign-in often fails.

function hubBase() {
  return (process.env.FRONTEND_BASE_URL || 'https://the-dump-bin.com').replace(/\/+$/, '');
}

function district1HubBase() {
  return (process.env.DISTRICT1_FRONTEND_URL || 'https://d6ewasupervisor-netizen.github.io/district1').replace(/\/+$/, '');
}

function allowedReturnHosts() {
  const hosts = new Set();
  for (const entry of (process.env.MAGIC_LINK_RETURN_HOSTS || '').split(',')) {
    const h = entry.trim().toLowerCase();
    if (h) hosts.add(h);
  }
  for (const entry of (process.env.ALLOWED_ORIGINS || '').split(',')) {
    const raw = entry.trim();
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).host.toLowerCase());
    } catch (_) {
      /* ignore malformed origin entries */
    }
  }
  return hosts;
}

function isChecklanesPath(pathname) {
  const path = (pathname || '/').toLowerCase();
  return path === '/checklanes' || path === '/checklanes/' || path.startsWith('/checklanes/');
}

function isDcScanPath(pathname) {
  const path = (pathname || '/').toLowerCase();
  return path === '/dc-scan' || path === '/dc-scan/' || path.startsWith('/dc-scan/');
}

function isAllowedDestinationUrl(url) {
  const host = url.host.toLowerCase();
  if (allowedReturnHosts().has(host)) {
    return url.protocol === 'https:' || url.protocol === 'http:';
  }
  if (url.protocol !== 'https:') return false;
  if (url.host === 'checklanes.the-dump-bin.com') return true;
  // Central Pet Scheduler (and other hub tools) on Railway production.
  if (host === 'cpscheduler-production.up.railway.app' || host.endsWith('.up.railway.app')) {
    return true;
  }
  if (url.host === 'the-dump-bin.com') {
    const path = (url.pathname || '/').toLowerCase();
    if (path === '/' || path === '/index.html') return true;
    if (path === '/central-pet' || path === '/central-pet/' || path.startsWith('/central-pet/')) {
      return true;
    }
    return isChecklanesPath(path) || isDcScanPath(path);
  }
  if (url.host.endsWith('.github.io')) {
    const path = (url.pathname || '/').toLowerCase();
    return path.startsWith('/district1');
  }
  return false;
}

function buildDestinationUrl(token, returnTo) {
  if (returnTo) {
    try {
      const url = new URL(returnTo);
      if (!isAllowedDestinationUrl(url)) {
        return null;
      }
      url.searchParams.set('token', token);
      return url.toString();
    } catch (_) {
      return null;
    }
  }

  return `${hubBase()}/index.html?token=${encodeURIComponent(token)}`;
}

function wrapForExternalBrowser(destinationUrl) {
  try {
    const dest = new URL(destinationUrl);
    if (dest.host.endsWith('.github.io') && dest.pathname.toLowerCase().startsWith('/district1')) {
      const openUrl = new URL('/open-sign-in.html', `${district1HubBase()}/`);
      openUrl.searchParams.set('to', destinationUrl);
      return openUrl.toString();
    }
  } catch (_) {
    /* fall through to hub open-sign-in */
  }
  const openUrl = new URL('/open-sign-in.html', `${hubBase()}/`);
  openUrl.searchParams.set('to', destinationUrl);
  return openUrl.toString();
}

function buildMagicLink(token, returnTo) {
  const destination = buildDestinationUrl(token, returnTo);
  if (!destination) return null;
  return wrapForExternalBrowser(destination);
}

module.exports = {
  buildMagicLink,
  buildDestinationUrl,
  wrapForExternalBrowser,
  isAllowedDestinationUrl,
};
