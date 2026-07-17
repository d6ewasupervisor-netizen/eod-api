// Shared GET handler for `/api/me` and `/api/whoami`.

// Lazily required to dodge any accidental circular-require ordering issues
// between route modules — this file loads early (mounted directly in
// index.js) while welcome-letter.js pulls in its own set of deps.
const { WELCOME_LETTER_ALLOWED_EMAILS } = require('./welcome-letter');

function identityHandler(req, res) {
  const raw = process.env.KOMPASS_ADMIN_USERNAMES || 'Tyson.Gauthier';
  const admins = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const email = (req.user?.email || '').trim().toLowerCase();
  const local = email.includes('@') ? email.slice(0, email.indexOf('@')) : email;
  const isReboticsAdmin = admins.some((a) => a === email || a === local);
  const districts = (process.env.KOMPASS_D8_REBOTICS_STORES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Single source of truth for Welcome Letter access — front-ends should
  // check this instead of keeping their own copy of the allowlist, which is
  // exactly the class of bug that kept these getting out of sync.
  const hasWelcomeLetterAccess = WELCOME_LETTER_ALLOWED_EMAILS.has(email);
  return res.json({
    ok: true,
    email: req.user?.email || null,
    roles: req.user?.roles || [],
    isReboticsAdmin,
    reboticsDistrictStoreIds: districts.length ? districts : null,
    hasWelcomeLetterAccess,
  });
}

module.exports = { identityHandler };
