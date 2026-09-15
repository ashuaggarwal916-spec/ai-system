/**
 * Plugin Manager
 * Handles plugin registration, installation, and management
 * Supports both built-in and external user-added plugins
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const PLUGINS_DIR = join(process.cwd(), '../plugins');
const PLUGINS_FILE = join(process.cwd(), '../plugins.json');

export class PluginManager {
  constructor(db) {
    this.db = db;
    this.plugins = new Map();
    this.loadPlugins();
  }

  loadPlugins() {
    // Ensure plugins table exists
    this.db.prepare(`
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE,
        description TEXT,
        version TEXT,
        author TEXT,
        type TEXT DEFAULT 'capability',
        capabilities TEXT DEFAULT '[]',
        path TEXT,
        status TEXT DEFAULT 'active',
        isExternal INTEGER DEFAULT 0,
        installed_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // Load plugins from DB
    const rows = this.db.prepare('SELECT * FROM plugins').all();
    for (const row of rows) {
      this.plugins.set(row.id, { ...row, isExternal: !!row.isExternal });
    }

    // Register built-in capabilities as plugins
    this.registerBuiltInPlugins();
  }

  registerBuiltInPlugins() {
    const builtIn = [
      { id: 'chat-agent', name: 'Chat Agent', description: 'Conversational AI assistant', type: 'core', capabilities: ['chat', 'conversation'] },
      { id: 'code-agent', name: 'Code Agent', description: 'Write and debug code', type: 'core', capabilities: ['coding', 'debugging'] },
      { id: 'research-agent', name: 'Research Agent', description: 'Research and analyze information', type: 'core', capabilities: ['research', 'analysis'] },
      { id: 'video-agent', name: 'Video Agent', description: 'Generate and edit videos', type: 'capability', capabilities: ['video', 'editing'] },
      { id: 'image-agent', name: 'Image Agent', description: 'Generate and edit images', type: 'capability', capabilities: ['image', 'generation'] },
      { id: 'audio-agent', name: 'Audio Agent', description: 'Text-to-speech and audio processing', type: 'capability', capabilities: ['audio', 'tts', 'stt'] },
      { id: 'trading-agent', name: 'Trading Agent', description: 'Market analysis and trading', type: 'capability', capabilities: ['trading', 'forecasting'] },
      { id: 'social-agent', name: 'Social Media Agent', description: 'Manage social media accounts', type: 'capability', capabilities: ['social', 'scheduling'] },
      { id: 'security-agent', name: 'Security Agent', description: 'Pentesting and vulnerability scanning', type: 'capability', capabilities: ['security', 'pentesting'] },
      { id: 'design-agent', name: 'Design Agent', description: 'UI/UX design and prototyping', type: 'capability', capabilities: ['design', 'ui', 'ux'] },
    ];

    for (const plugin of builtIn) {
      if (!this.plugins.has(plugin.id)) {
        this.registerPlugin(plugin);
      }
    }
  }

  registerPlugin({ id, name, description, type = 'capability', capabilities = [], author = 'system', version = '1.0.0', path = null, isExternal = false }) {
    const plugin = {
      id,
      name,
      description,
      type,
      capabilities: JSON.stringify(capabilities),
      author,
      version,
      path,
      status: 'active',
      isExternal: isExternal ? 1 : 0,
      installed_at: new Date().toISOString()
    };

    this.db.prepare(`
      INSERT OR REPLACE INTO plugins (id, name, description, type, capabilities, author, version, path, status, isExternal, installed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(plugin.id, plugin.name, plugin.description, plugin.type, plugin.capabilities, plugin.author, plugin.version, plugin.path, plugin.status, plugin.isExternal, plugin.installed_at);

    this.plugins.set(id, { ...plugin, capabilities, isExternal: !!isExternal });
    return this.getPlugin(id);
  }

  installExternalPlugin({ name, description, repoUrl, capabilities = [], type = 'capability', author = 'user' }) {
    const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    
    // Clone repo to plugins dir
    const pluginDir = join(PLUGINS_DIR, id);
    if (!existsSync(PLUGINS_DIR)) {
      mkdirSync(PLUGINS_DIR, { recursive: true });
    }

    // Register as external plugin
    const plugin = this.registerPlugin({
      id,
      name,
      description,
      type,
      capabilities,
      author,
      version: '1.0.0',
      path: pluginDir,
      isExternal: true
    });

    return plugin;
  }

  uninstallPlugin(id) {
    const plugin = this.plugins.get(id);
    if (!plugin) return null;

    // Remove from DB
    this.db.prepare('DELETE FROM plugins WHERE id = ?').run(id);
    
    // Remove from memory
    this.plugins.delete(id);
    
    // Remove files if external
    if (plugin.isExternal && plugin.path) {
      try { require('fs').rmSync(plugin.path, { recursive: true }); } catch {}
    }
    
    return { success: true, id };
  }

  enablePlugin(id) {
    this.db.prepare('UPDATE plugins SET status = ? WHERE id = ?').run('active', id);
    const plugin = this.plugins.get(id);
    if (plugin) plugin.status = 'active';
    return this.getPlugin(id);
  }

  disablePlugin(id) {
    this.db.prepare('UPDATE plugins SET status = ? WHERE id = ?').run('disabled', id);
    const plugin = this.plugins.get(id);
    if (plugin) plugin.status = 'disabled';
    return this.getPlugin(id);
  }

  getPlugin(id) {
    const plugin = this.plugins.get(id);
    if (!plugin) return null;
    return {
      ...plugin,
      capabilities: typeof plugin.capabilities === 'string' ? JSON.parse(plugin.capabilities) : plugin.capabilities,
      isExternal: !!plugin.isExternal
    };
  }

  listPlugins(filter = {}) {
    let plugins = Array.from(this.plugins.values());
    
    if (filter.type) {
      plugins = plugins.filter(p => p.type === filter.type);
    }
    if (filter.status) {
      plugins = plugins.filter(p => p.status === filter.status);
    }
    if (filter.isExternal !== undefined) {
      plugins = plugins.filter(p => !!p.isExternal === filter.isExternal);
    }
    if (filter.capability) {
      plugins = plugins.filter(p => {
        const caps = typeof p.capabilities === 'string' ? JSON.parse(p.capabilities) : p.capabilities;
        return caps && caps.includes(filter.capability);
      });
    }
    
    return plugins.map(p => ({
      ...p,
      capabilities: typeof p.capabilities === 'string' ? JSON.parse(p.capabilities) : p.capabilities,
      isExternal: !!p.isExternal
    }));
  }

  getStats() {
    const total = this.plugins.size;
    const active = this.listPlugins({ status: 'active' }).length;
    const external = this.listPlugins({ isExternal: true }).length;
    const core = this.listPlugins({ type: 'core' }).length;
    
    return { total, active, external, core, capability: total - core };
  }
}
