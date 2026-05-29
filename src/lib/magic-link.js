// Build emailed magic-link URLs for the-dump-bin.com sign-in flow.
//
// Links land on /open-sign-in.html first so mobile mail apps (Gmail, Outlook,
// etc.) can prompt the user to open in Chrome or another full browser instead
// of an in-app WebView where sign-in often fails.

function hubBase() {
  return (process.env.FRONTEND_BASE_URL || 'https://the-dump-bin.com').replace(/\/+$/, '');
}

function isChecklanesPath(pathname) {
  const path = (pathname || '/').toLowerCase();
  return path === '/checklanes' || path === '/checklanes/' || path.startsWith('/checklanes/');
}

function isAllowedDestinationUrl(url) {
  if (url.protocol !== 'https:') return false;
  if (url.host === 'checklanes.the-dump-bin.com') return true;
  if (url.host === 'the-dump-bin.com') {
    const path = (url.pathname || '/').toLowerCase();
    if (path === '/' || path === '/index.html') return true;
    return isChecklanesPath(path);
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
