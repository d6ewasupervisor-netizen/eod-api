const { supabase } = require('./supabase');

const PUBLIC_PATHS = new Set([
  '/rebotics-auth-update',
  '/rebotics-token-internal',
]);

async function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) {
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No auth token provided' });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      roles: user.user_metadata?.roles || [],
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Auth verification failed' });
  }
}

function requireRole(...allowed) {
  return (req, res, next) => {
    const userRoles = req.user?.roles || [];
    if (!allowed.some(r => userRoles.includes(r))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };