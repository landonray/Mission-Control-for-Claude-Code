const crypto = require('crypto');

function tokensMatch(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function requireAuth(req, res, next) {
  const AUTH_TOKEN = process.env.MC_AUTH_TOKEN;

  // No token configured — skip auth for local dev
  if (!AUTH_TOKEN) {
    return next();
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice('Bearer '.length);
  if (!tokensMatch(token, AUTH_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

module.exports = { requireAuth, tokensMatch };
