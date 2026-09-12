import { randomUUID } from 'crypto';

export class AgentManager {
  constructor(db, models, registry) {
    this.db = db;
    this.models = models;
    this.registry = registry;
    this.activeAgents = new Map();

    // Register default agents
    this.registerDefaults();
  }

  registerDefaults() {
    const defaults = [
      { name: 'architect', type: 'specialist', capabilities: ['architecture', 'design', 'planning'] },
      { name: 'backend', type: 'specialist', capabilities: ['coding', 'api', 'database'] },
      { name: 'frontend', type: 'specialist', capabilities: ['ui', 'react', 'css'] },
      { name: 'testing', type: 'specialist', capabilities: ['testing', 'qa', 'review'] },
      { name: 'research', type: 'specialist', capabilities: ['search', 'analysis', 'summarize'] },
      { name: 'devops', type: 'specialist', capabilities: ['deploy', 'docker', 'ci-cd'] },
      { name: 'video', type: 'specialist', capabilities: ['video', 'editing', 'youtube'] },
      { name: 'voice', type: 'specialist', capabilities: ['voice', 'audio', 'speech'] },
      { name: 'browser', type: 'specialist', capabilities: ['browser', 'scrape', 'interaction'] },
      { name: 'analysis', type: 'specialist', capabilities: ['analysis', 'insights', 'reporting'] },
      { name: 'general', type: 'general', capabilities: ['chat', 'help', 'general'] }
    ];

    for (const agent of defaults) {
      const id = randomUUID();
      this.db.prepare('INSERT OR IGNORE INTO agents (id, name, type, capabilities, status) VALUES (?, ?, ?, ?, ?)')
        .run(id, agent.name, agent.type, JSON.stringify(agent.capabilities), 'sleeping');
    }
  }

  async selectForTask(plan) {
    const selected = [];
    for (const step of plan.steps || []) {
      const agent = await this.findAgent(step.agent, step.name);
      if (agent) selected.push(agent);
    }
    return selected.length > 0 ? selected : [this.getGeneralAgent()];
  }

  async findAgent(name, fallbackName) {
    let agent = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
    if (!agent) agent = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(fallbackName);
    return agent ? { ...agent, capabilities: JSON.parse(agent.capabilities || '[]') } : null;
  }

  getGeneralAgent() {
    return { name: 'general', capabilities: ['chat', 'help', 'general'], status: 'active' };
  }

  async wake(agentName) {
    this.db.prepare('UPDATE agents SET status = ?, last_active = CURRENT_TIMESTAMP WHERE name = ?').run('active', agentName);
  }

  async sleep(agentName) {
    this.db.prepare('UPDATE agents SET status = ? WHERE name = ?').run('sleeping', agentName);
  }

  async count() {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM agents').get();
    return result.count;
  }

  async list() {
    return this.db.prepare('SELECT id, name, type, capabilities, status FROM agents').all();
  }

  async getByName(name) {
    return this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name);
  }
}
