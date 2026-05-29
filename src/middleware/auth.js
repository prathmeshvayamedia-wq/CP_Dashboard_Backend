const jwt      = require('jsonwebtoken');
const supabase = require('../config/supabase');
const logger   = require('../config/logger');

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { data: admin, error } = await supabase
      .from('admins')
      .select('id, name, email, role')
      .eq('id', decoded.id)
      .single();

    if (error || !admin) return res.status(401).json({ error: 'Invalid token' });

    req.admin = admin;
    next();
  } catch (err) {
    logger.warn('Auth failed', { error: err.message });
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = authMiddleware;
