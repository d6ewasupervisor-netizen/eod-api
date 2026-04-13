const { supabase } = require('./supabase');

async function requireAuth(req, res, next) {
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

    // Attach user info to the request for downstream use
    req.user = {
      id: user.id,
      email: user.email,
      role: user.user_metadata?.role || 'rep',
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Auth verification failed' });
  }
}

module.exports = { requireAuth };