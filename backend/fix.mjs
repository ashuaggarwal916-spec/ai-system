import { AISystemDB } from './src/database/index.js';
import bcrypt from 'bcrypt';

const db = new AISystemDB('./data/ai-system.db');
await db.migrate();

const hash = await bcrypt.hash('admin123', 10);
db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE email = ?').run(hash, 'admin', '<EMAIL>');

console.log('Password updated for <EMAIL>');
