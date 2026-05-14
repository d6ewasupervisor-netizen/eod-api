// Shared GET handler for `/api/me` and `/api/whoami`.

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
  return res.json({
    ok: true,
    email: req.user?.email || null,
    roles: req.user?.roles || [],
    isReboticsAdmin,
    reboticsDistrictStoreIds: districts.length ? districts : null,
  });
}

module.exports = { identityHandler };
