import { randomUUID } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

/**
 * Brain — the central AI System orchestrator
 * Uses agent-skills workflows for all phases of execution
 */
export class Brain {
  constructor(db, agents, models, tasks, memory, registry) {
    this.db = db;
    this.agents = agents;
    this.models = models;
    this.tasks = tasks;
    this.memory = memory;
    this.registry = registry;
    this.skills = new Map();
    this.agentsDir = join(process.cwd(), '..', 'agents');
    this.skillsDir = join(process.cwd(), '..', 'skills');
    this.referencesDir = join(process.cwd(), '..', 'references');
  }

  /**
   * Load all skills from the skills directory
   */
  async loadSkills() {
    try {
      const skillDirs = await readdir(this.skillsDir, { withFileTypes: true });
      for (const dir of skillDirs) {
        if (dir.isDirectory()) {
          try {
            const skillPath = join(this.skillsDir, dir.name, 'SKILL.md');
            const content = await readFile(skillPath, 'utf-8');
            this.skills.set(dir.name, {
              name: dir.name,
              path: skillPath,
              content
            });
            
            // Register in resource registry
            this.registry.register({
              name: dir.name,
              type: 'skill',
              status: 'active',
              capabilities: ['workflow', dir.name],
              config: { path: skillPath }
            });
          } catch {
            // No SKILL.md in this directory
          }
        }
      }
      console.log(`   📚 Skills loaded: ${this.skills.size} workflows`);
    } catch (err) {
      console.warn('Skills directory not found:', err.message);
    }
  }

  /**
   * Get a skill by name
   */
  getSkill(name) {
    return this.skills.get(name);
  }

  /**
   * List all available skills
   */
  listSkills() {
    return Array.from(this.skills.keys());
  }

  /**
   * Process a user command through the full Brain pipeline
   * Uses skills: spec-driven-development, planning-and-task-breakdown, etc.
   */
  async processCommand(userId, command, options = {}) {
    const taskId = randomUUID();
    
    // Phase 1: UNDERSTAND (using interview-me / idea-refine skills)
    const intent = await this.understandIntent(command);
    
    // Phase 2: CHECK AMBIGUITIES (using spec-driven-development skill)
    const ambiguities = this.detectAmbiguities(intent);
    if (ambiguities.length > 0 && !options.skipClarification) {
      return {
        type: 'clarification_needed',
        taskId,
        questions: ambiguities
      };
    }

    // Phase 3: CREATE TASK
    const task = await this.tasks.create({
      id: taskId,
      userId,
      title: intent.title,
      description: command,
      context: JSON.stringify({ intent, options }),
      status: 'planning'
    });

    // Phase 4: PLAN (using planning-and-task-breakdown skill)
    const plan = await this.planTask(task, intent);
    
    // Phase 5: SELECT AGENTS
    const selectedAgents = await this.agents.selectForTask(plan);
    
    // Phase 6: EXECUTE asynchronously (using incremental-implementation skill)
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

  /**
   * Understand user intent using skill workflows
   */
  async understandIntent(command) {
    const lower = command.toLowerCase();
    const intent = {
      title: command.substring(0, 100),
      category: 'general',
      requirements: [],
      confidence: 0.8
    };

    // Use skill-based categorization
    if (lower.includes('build') || lower.includes('create') || lower.includes('make')) {
      intent.category = 'coding';
      intent.requirements.push('coding-agent', 'testing-agent');
      intent.skill = 'incremental-implementation';
    }
    if (lower.includes('research') || lower.includes('search') || lower.includes('find')) {
      intent.category = 'research';
      intent.requirements.push('research-agent', 'browser-agent');
      intent.skill = 'source-driven-development';
    }
    if (lower.includes('video') || lower.includes('youtube') || lower.includes('clip')) {
      intent.category = 'video';
      intent.requirements.push('video-agent', 'voice-agent');
    }
    if (lower.includes('deploy') || lower.includes('publish') || lower.includes('server')) {
      intent.category = 'devops';
      intent.requirements.push('devops-agent', 'testing-agent');
      intent.skill = 'shipping-and-launch';
    }
    if (lower.includes('design') || lower.includes('ui') || lower.includes('ux')) {
      intent.category = 'design';
      intent.requirements.push('ui-agent');
      intent.skill = 'frontend-ui-engineering';
    }
    if (lower.includes('review') || lower.includes('check') || lower.includes('audit')) {
      intent.category = 'review';
      intent.requirements.push('review-agent');
      intent.skill = 'code-review-and-quality';
    }
    if (lower.includes('simplify') || lower.includes('clean') || lower.includes('refactor')) {
      intent.category = 'simplify';
      intent.requirements.push('coding-agent');
      intent.skill = 'code-simplification';
    }
    if (lower.includes('secure') || lower.includes('security') || lower.includes('vulnerability')) {
      intent.category = 'security';
      intent.requirements.push('security-agent');
      intent.skill = 'security-and-hardening';
    }
    if (lower.includes('test') || lower.includes('bug') || lower.includes('fix')) {
      intent.category = 'testing';
      intent.requirements.push('testing-agent');
      intent.skill = 'test-driven-development';
    }
    if (lower.includes('document') || lower.includes('readme') || lower.includes('docs')) {
      intent.category = 'documentation';
      intent.requirements.push('docs-agent');
      intent.skill = 'documentation-and-adrs';
    }
    if (lower.includes('optimize') || lower.includes('performance') || lower.includes('speed')) {
      intent.category = 'performance';
      intent.requirements.push('perf-agent');
      intent.skill = 'performance-optimization';
    }

    return intent;
  }

  detectAmbiguities(intent) {
    const questions = [];
    if (!intent.requirements.length) {
      questions.push('What type of task is this? (coding/research/video/deploy/design/review)');
    }
    return questions;
  }

  async planTask(task, intent) {
    const steps = [];
    
    // Use planning-and-task-breakdown skill principles
    if (intent.category === 'coding') {
      steps.push({ name: 'architecture', agent: 'architect-agent', order: 1 });
      steps.push({ name: 'backend', agent: 'backend-agent', order: 2 });
      steps.push({ name: 'frontend', agent: 'frontend-agent', order: 3 });
      steps.push({ name: 'testing', agent: 'testing-agent', order: 4 });
    } else if (intent.category === 'research') {
      steps.push({ name: 'search', agent: 'research-agent', order: 1 });
      steps.push({ name: 'analysis', agent: 'analysis-agent', order: 2 });
    } else if (intent.category === 'design') {
      steps.push({ name: 'wireframe', agent: 'ui-agent', order: 1 });
      steps.push({ name: 'implementation', agent: 'frontend-agent', order: 2 });
    } else {
      steps.push({ name: 'execute', agent: 'general-agent', order: 1 });
    }

    return {
      steps,
      models: ['auto'],
      parallelizable: steps.length > 1,
      skill: intent.skill || 'incremental-implementation'
    };
  }

  async getTaskStatus(taskId) {
    return this.tasks.get(taskId);
  }

  async listUserTasks(userId) {
    return this.tasks.listByUser(userId);
  }

  /**
   * Chat with the Brain using model gateway
   */
  async chat(userId, message, conversationId, skillName = null) {
    // Get skill content if specified
    let systemPrompt = this.getSystemPrompt();
    if (skillName) {
      const skill = this.getSkill(skillName);
      if (skill) {
        systemPrompt += `\n\n---\nActive Skill: ${skillName}\n${skill.content.substring(0, 2000)}`;
      }
    }

    const response = await this.models.chat({
      model: 'auto',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      stream: false
    });

    return {
      role: 'assistant',
      content: response.content,
      model: response.model,
      provider: response.provider,
      skill: skillName
    };
  }

  /**
   * System prompt that includes skill workflows
   */
  getSystemPrompt() {
    return `You are the AI System Brain, a multi-user AI agent operating system.

You have access to 30+ engineering skills that guide your workflow:
- spec-driven-development: Write specs before code
- planning-and-task-breakdown: Decompose tasks into small units
- incremental-implementation: Build in thin vertical slices
- test-driven-development: Red-Green-Refactor
- code-review-and-quality: Five-axis review before merge
- code-simplification: Reduce complexity, preserve behavior
- security-and-hardening: OWASP prevention, auth patterns
- frontend-ui-engineering: Component architecture, accessibility
- api-and-interface-design: Contract-first design
- performance-optimization: Measure-first optimization
- debugging-and-error-recovery: Five-step triage
- git-workflow-and-versioning: Trunk-based, atomic commits
- shipping-and-launch: Staged rollouts, feature flags
- And 18 more specialized skills...

Always:
1. Understand the real need (interview-me skill)
2. Plan before building (planning-and-task-breakdown skill)
3. Build incrementally (incremental-implementation skill)
4. Verify with evidence (test-driven-development skill)
5. Review before merging (code-review-and-quality skill)
6. Ship with confidence (shipping-and-launch skill)`;
  }
}
