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
    // Get skill guidance for this step
    const skillName = step.skill || this.inferSkill(step.name);
    const skillContent = this.loadSkillContent(skillName);
    
    // Execute with skill workflow applied
    const result = await this.executeWithSkill(step, task, skillContent);
    
    // Verify using skill's verification criteria
    if (skillContent && !this.verifyStep(result, skillContent)) {
      throw new Error(`Step ${step.name} failed skill verification: ${skillName}`);
    }
    
    return { ...result, skill: skillName };
  }

  inferSkill(stepName) {
    const skillMap = {
      'architecture': 'spec-driven-development',
      'backend': 'incremental-implementation',
      'frontend': 'frontend-ui-engineering',
      'testing': 'test-driven-development',
      'research': 'source-driven-development',
      'deploy': 'shipping-and-launch',
      'review': 'code-review-and-quality',
      'simplify': 'code-simplification',
      'security': 'security-and-hardening',
      'performance': 'performance-optimization',
      'documentation': 'documentation-and-adrs'
    };
    return skillMap[stepName] || 'incremental-implementation';
  }

  loadSkillContent(skillName) {
    const skill = this.db.prepare('SELECT * FROM resources WHERE name = ? AND type = "skill"').get(skillName);
    return skill ? skill.capabilities : null;
  }

  verifyStep(result, skillContent) {
    // Apply skill's verification criteria
    // For now, basic verification: result exists and has expected fields
    return result && result.status === 'done';
  }

  async executeWithSkill(step, task, skillContent) {
    // Build system prompt from skill content
    const systemPrompt = skillContent 
      ? `Follow this workflow: ${skillContent}`
      : 'Execute the task efficiently and verify the result.';
    
    // In production, this would call the model with the skill prompt
    // For now, mark as done with skill reference
    return { step: step.name, status: 'done', agent: step.agent, verified: !!skillContent };
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
