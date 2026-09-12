import { randomUUID } from 'crypto';

export class ResourceRegistry {
  constructor(db) {
    this.db = db;
    this.cache = new Map();
    this.load();
  }

  async load() {
    const resources = this.db.prepare('SELECT * FROM resources').all();
    for (const r of resources) {
      this.cache.set(r.id, { ...r, capabilities: JSON.parse(r.config || '[]') });
    }
  }

  register({ name, type, status = 'registered', config = {}, capabilities = [] }) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO resources (id, name, type, status, config, capabilities) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, type, status, JSON.stringify(config), JSON.stringify(capabilities));
    this.cache.set(id, { id, name, type, status, capabilities });
    return { id, name, type };
  }

  list() {
    return Array.from(this.cache.values());
  }

  get(id) {
    return this.cache.get(id);
  }

  update(id, updates) {
    const fields = [];
    const values = [];
    for (const [k, v] of Object.entries(updates)) {
      fields.push(`${k} = ?`);
      values.push(typeof v === 'object' ? JSON.stringify(v) : v);
    }
    values.push(id);
    this.db.prepare(`UPDATE resources SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    this.cache.set(id, { ...this.cache.get(id), ...updates });
  }

  remove(id) {
    this.db.prepare('DELETE FROM resources WHERE id = ?').run(id);
    this.cache.delete(id);
  }
}
