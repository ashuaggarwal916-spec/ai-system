import { randomUUID } from 'crypto';

export class Brain {
  constructor(db, agents, models, tasks, memory, registry) {
    this.db = db;
    this.agents = agents;
    this.models = models;
    this.tasks = tasks;
    this.memory = memory;
    this.registry = registry;
  }

  async processCommand(userId, command, options = {}) {
    const taskId = randomUUID();
    
    // 1. Understand intent
    const intent = await this.understandIntent(command);
    
    // 2. Check for ambiguities
    const ambiguities = this.detectAmbiguities(intent);
    if (ambiguities.length > 0 && !options.skipClarification) {
      return {
        type: 'clarification_needed',
        taskId,
        questions: ambiguities
      };
    }

    // 3. Create task
    const task = await this.tasks.create({
      id: taskId,
      userId,
      title: intent.title,
      description: command,
      context: JSON.stringify({ intent, options }),
      status: 'planning'
    });

    // 4. Plan execution
    const plan = await this.planTask(task, intent);
    
    // 5. Select agents
    const selectedAgents = await this.agents.selectForTask(plan);
    
    // 6. Execute asynchronously
    this.tasks.execute(task, plan, selectedAgents).catch(err => {
      console.error(`Task ${taskId} failed:`, err);
    });

    return {
      type: 'task_created',
      taskId,
      title: intent.title,
      plan: {
        agents: selectedAgents.map(a => ({ id: a.id, name: a.name })),
        steps: plan.steps?.length || 1,
        estimatedModels: plan.models || ['auto']
      }
    };
  }

  async understandIntent(command) {
    const lower = command.toLowerCase();
    const intent = {
      title: command.substring(0, 100),
      category: 'general',
      requirements: []
    };

    if (lower.includes('build') || lower.includes('create') || lower.includes('make')) {
      intent.category = 'coding';
      intent.requirements.push('coding-agent', 'testing-agent');
    }
    if (lower.includes('research') || lower.includes('search') || lower.includes('find')) {
      intent.category = 'research';
      intent.requirements.push('research-agent', 'browser-agent');
    }
    if (lower.includes('video') || lower.includes('youtube') || lower.includes('clip')) {
      intent.category = 'video';
      intent.requirements.push('video-agent', 'voice-agent');
    }
    if (lower.includes('deploy') || lower.includes('publish') || lower.includes('server')) {
      intent.category = 'devops';
      intent.requirements.push('devops-agent', 'testing-agent');
    }

    return intent;
  }

  detectAmbiguities(intent) {
    const questions = [];
    if (!intent.requirements.length) {
      questions.push('What type of task is this? (coding/research/video/deploy)');
    }
    return questions;
  }

  async planTask(task, intent) {
    const steps = [];
    
    if (intent.category === 'coding') {
      steps.push({ name: 'architecture', agent: 'architect-agent', order: 1 });
      steps.push({ name: 'backend', agent: 'backend-agent', order: 2 });
      steps.push({ name: 'frontend', agent: 'frontend-agent', order: 3 });
      steps.push({ name: 'testing', agent: 'testing-agent', order: 4 });
    } else if (intent.category === 'research') {
      steps.push({ name: 'search', agent: 'research-agent', order: 1 });
      steps.push({ name: 'analysis', agent: 'analysis-agent', order: 2 });
    } else {
      steps.push({ name: 'execute', agent: 'general-agent', order: 1 });
    }

    return {
      steps,
      models: ['auto'],
      parallelizable: steps.length > 1
    };
  }

  async getTaskStatus(taskId) {
    return this.tasks.get(taskId);
  }

  async listUserTasks(userId) {
    return this.tasks.listByUser(userId);
  }

  async chat(userId, message, conversationId) {
    const response = await this.models.chat({
      model: 'auto',
      messages: [
        { role: 'system', content: 'You are the AI System Brain. Help the user accomplish their goals.' },
        { role: 'user', content: message }
      ],
      stream: false
    });

    return {
      role: 'assistant',
      content: response.content,
      model: response.model
    };
  }
}
