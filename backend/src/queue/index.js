import { randomUUID } from 'crypto';

export class TaskEngine {
  constructor(db, agents, memory) {
    this.db = db;
    this.agents = agents;
    this.memory = memory;
    this.running = new Map();
  }

  async create({ id, userId, title, description, context, status = 'pending' }) {
    this.db.prepare('INSERT INTO tasks (id, user_id, title, description, context, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, title, description, context, status);

    this.logAudit(userId, 'task.create', 'task', { taskId: id, title });
    return { id, title, status };
  }

  async execute(task, plan, agents) {
    this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('running', task.id);
    this.running.set(task.id, { task, plan, agents, startTime: Date.now() });

    try {
      const results = [];
      for (const step of plan.steps || []) {
        // Execute step
        const result = await this.executeStep(step, task);
        results.push(result);
      }

      this.db.prepare('UPDATE tasks SET status = ?, result = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('completed', JSON.stringify(results), task.id);

      this.logAudit(task.user_id, 'task.complete', 'task', { taskId: task.id });
    } catch (err) {
      this.db.prepare('UPDATE tasks SET status = ?, error = ? WHERE id = ?')
        .run('failed', err.message, task.id);
      this.logAudit(task.user_id, 'task.fail', 'task', { taskId: task.id, error: err.message });
    } finally {
      this.running.delete(task.id);
    }
  }

  async executeStep(step, task) {
    // Simulated execution - in real system this would call the model
    return { step: step.name, status: 'done', agent: step.agent };
  }

  async get(taskId) {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  }

  async listByUser(userId) {
    return this.db.prepare('SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  }

  async listByStatus(status) {
    return this.db.prepare('SELECT * FROM tasks WHERE status = ?').all(status);
  }

  async cancel(taskId) {
    this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('cancelled', taskId);
  }

  async stop() {
    // Cleanup running tasks
    this.running.clear();
  }

  logAudit(userId, action, resource, details) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO audit_logs (id, user_id, action, resource, details) VALUES (?, ?, ?, ?, ?)')
      .run(id, userId, action, resource, JSON.stringify(details));
  }
}
