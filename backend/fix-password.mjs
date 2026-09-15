import { AISystemDB } from './src/database/index.js';
import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';

const db = new AISystemDB('./data/ai-system.db');
await db.migrate();

// Check users
const users = db.prepare('SELECT id, email, role FROM users').all();
console.log('Current users:', JSON.stringify(users, null, 2));

// Generate new hash for admin123
const hash = await bcrypt.hash('admin123', 10);
console.log('New hash for admin123:', hash);

// Update user
const result = db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE email = ?').run(hash, 'admin', '<EMAIL>');
console.log('Updated rows:', result.changes);

const updated = db.prepare('SELECT id, email, role FROM users WHERE email = ?').get('<EMAIL>');
console.log('Updated user:', JSON.stringify(updated, null, 2));

// Also update any other users with known passwords
const testHash = await bcrypt.hash('test123', 10);
db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(testHash, '<EMAIL>');

console.log('Done');
