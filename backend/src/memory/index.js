import { randomUUID } from 'crypto';

export class MemoryManager {
  constructor(db) {
    this.db = db;
  }

  async store({ userId, orgId, projectId, taskId, type, content, metadata = {}, importance = 0.5 }) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO memory (id, user_id, org_id, project_id, task_id, type, content, metadata, importance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, userId, orgId, projectId, taskId, type, content, JSON.stringify(metadata), importance);
    return { id, type };
  }

  async recall({ userId, type, limit = 10, projectId }) {
    let sql = 'SELECT * FROM memory WHERE user_id = ?';
    const params = [userId];

    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    if (projectId) {
      sql += ' AND project_id = ?';
      params.push(projectId);
    }

    sql += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
    params.push(limit);

    return this.db.prepare(sql).all(...params);
  }

  async search(query, userId) {
    return this.db.prepare('SELECT * FROM memory WHERE user_id = ? AND content LIKE ? ORDER BY importance DESC LIMIT 20')
      .all(userId, `%${query}%`);
  }

  async forget(memoryId) {
    this.db.prepare('DELETE FROM memory WHERE id = ?').run(memoryId);
  }

  async updateImportance(memoryId, importance) {
    this.db.prepare('UPDATE memory SET importance = ? WHERE id = ?').run(importance, memoryId);
  }

  async getProjectMemory(projectId) {
    return this.db.prepare('SELECT * FROM memory WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
  }

  async cleanup(daysOld = 30) {
    const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare('DELETE FROM memory WHERE created_at < ? AND importance < 0.3').run(cutoff);
  }
}
