import { Router } from 'express';

export function apiRouter({ auth, brain, agents, tasks, memory, registry, plugins }) {
  const router = Router();

  // Auth routes
  router.post('/auth/register', async (req, res) => {
    try {
      const { email, password } = req.body;
      const user = await auth.register(email, password);
      res.json({ success: true, user });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      const result = await auth.login(email, password);
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(401).json({ error: err.message });
    }
  });

  router.post('/auth/logout', auth.authMiddleware, (req, res) => {
    const token = req.headers.authorization.split(' ')[1];
    auth.logout(token);
    res.json({ success: true });
  });

  // Brain / Chat routes
  router.post('/chat', auth.authMiddleware, async (req, res) => {
    try {
      const { message, conversationId } = req.body;
      const result = await brain.chat(req.user.userId, message, conversationId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/command', auth.authMiddleware, async (req, res) => {
    try {
      const { command } = req.body;
      const result = await brain.processCommand(req.user.userId, command);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/tasks', auth.authMiddleware, async (req, res) => {
    const tasksList = await brain.listUserTasks(req.user.userId);
    res.json(tasksList);
  });

  router.get('/tasks/:id', auth.authMiddleware, async (req, res) => {
    const task = await brain.getTaskStatus(req.params.id);
    res.json(task || { error: 'Task not found' });
  });

  // Capability registry routes
  router.get('/capabilities', auth.authMiddleware, (req, res) => {
    try {
      const registry = JSON.parse(require('fs').readFileSync('../capability-registry.json', 'utf-8'));
      res.json(registry.capabilities);
    } catch {
      res.json([]);
    }
  });

  // Skills routes
  router.get('/skills', auth.authMiddleware, (req, res) => {
    res.json(brain.listSkills());
  });

  // Deploy using free tiers from free-for-dev
  router.get('/deploy/options', auth.authMiddleware, (req, res) => {
    try {
      const registry = JSON.parse(require('fs').readFileSync('../capability-registry.json', 'utf-8'));
      const deployCaps = registry.capabilities.filter(c => 
        c.capabilities.includes('free-cloud-tiers') || 
        c.capabilities.includes('free-hosting') ||
        c.capabilities.includes('free-databases')
      );
      res.json(deployCaps);
    } catch {
      res.json([]);
    }
  });

  // Agents routes
  router.get('/agents', auth.authMiddleware, async (req, res) => {
    const list = await agents.list();
    res.json(list);
  });

  // Resources routes
  router.get('/resources', auth.authMiddleware, (req, res) => {
    res.json(registry.list());
  });

  router.post('/resources', auth.authMiddleware, auth.requireRole('admin'), (req, res) => {
    const resource = registry.register(req.body);
    res.json(resource);
  });

  // Memory routes
  router.get('/memory', auth.authMiddleware, async (req, res) => {
    const { type, limit } = req.query;
    const results = await memory.recall({ userId: req.user.userId, type, limit: parseInt(limit) || 10 });
    res.json(results);
  });

  router.post('/memory', auth.authMiddleware, async (req, res) => {
    const result = await memory.store({ ...req.body, userId: req.user.userId });
    res.json(result);
  });

  // Models
  router.get('/models', auth.authMiddleware, async (req, res) => {
    try {
      const models = await brain.models.listModels();
      res.json(models);
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // Plugin routes
  router.get('/plugins', auth.authMiddleware, (req, res) => {
    const filter = {};
    if (req.query.type) filter.type = req.query.type;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.capability) filter.capability = req.query.capability;
    if (req.query.external) filter.isExternal = req.query.external === 'true';
    res.json(plugins.listPlugins(filter));
  });

  router.post('/plugins', auth.authMiddleware, auth.requireRole('admin'), (req, res) => {
    const { name, description, repoUrl, capabilities, type, author } = req.body;
    if (!name || !description) {
      return res.status(400).json({ error: 'Name and description required' });
    }
    const plugin = plugins.installExternalPlugin({ name, description, repoUrl, capabilities, type, author });
    res.json(plugin);
  });

  router.get('/plugins/stats', auth.authMiddleware, (req, res) => {
    res.json(plugins.getStats());
  });

  router.post('/plugins/:id/enable', auth.authMiddleware, auth.requireRole('admin'), (req, res) => {
    res.json(plugins.enablePlugin(req.params.id));
  });

  router.post('/plugins/:id/disable', auth.authMiddleware, auth.requireRole('admin'), (req, res) => {
    res.json(plugins.disablePlugin(req.params.id));
  });

  router.delete('/plugins/:id', auth.authMiddleware, auth.requireRole('admin'), (req, res) => {
    const result = plugins.uninstallPlugin(req.params.id);
    res.json(result);
  });

  return router;
}
