import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'ai-system-jwt-' + randomUUID();
const JWT_EXPIRY = '7d';

export class AuthService {
  constructor(db) {
    this.db = db;
  }

  authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = this.verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.user = decoded;
    next();
  };

  requireRole = (...roles) => {
    return (req, res, next) => {
      if (!req.user || !roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      next();
    };
  };

  async register(email, password, role = 'member') {
    const existing = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) throw new Error('Email already registered');

    const id = randomUUID();
    const password_hash = await bcrypt.hash(password, 10);
    this.db.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)')
      .run(id, email, password_hash, role);

    return { id, email, role };
  }

  async login(email, password) {
    const user = this.db.prepare('SELECT * FROM users WHERE email = ? AND status = ?').get(email, 'active');
    if (!user) throw new Error('Invalid credentials');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new Error('Invalid credentials');

    const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    this.db.prepare('INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, user.id, token, expiresAt);

    return { token, user: { id: user.id, email: user.email, role: user.role } };
  }

  verifyToken(token) {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch {
      return null;
    }
  }

  async logout(token) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  async getUser(userId) {
    return this.db.prepare('SELECT id, email, role, status, created_at FROM users WHERE id = ?').get(userId);
  }

  async listUsers() {
    return this.db.prepare('SELECT id, email, role, status FROM users').all();
  }

  async updateUserRole(userId, role) {
    this.db.prepare('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(role, userId);
  }

  async deleteUser(userId) {
    this.db.prepare('UPDATE users SET status = ? WHERE id = ?').run('deleted', userId);
  }

}
