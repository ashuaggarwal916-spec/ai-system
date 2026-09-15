import { randomUUID } from 'crypto';

/**
 * Multi-Provider Model Gateway
 * Auto-switches between providers when one fails or hits limits
 * Primary: Kira AI → OpenRouter → FreeClaude → OmniRoute → FreeLLMAPI
 */
export class ModelGateway {
  constructor(db) {
    this.db = db;
    this.provider = 'kira-ai';
    
    // Provider chain - priority order
    this.providers = [
      {
        name: 'kira-ai',
        apiKey: 'kira_244519e2e29e2b30c104bb4b4fb8638a',
        baseUrl: process.env.KIRA_AI_URL || 'https://api.kira.ai/v1',
        priority: 1,
        status: 'active',
        lastError: null,
        errorCount: 0,
        free_tokens: 80000000,
        notes: '80M free tokens/month - PRIMARY'
      },
      {
        name: 'openrouter',
        apiKey: process.env.OPENROUTER_KEY || '',
        baseUrl: 'https://openrouter.ai/api/v1',
        priority: 2,
        status: process.env.OPENROUTER_KEY ? 'active' : 'standby',
        lastError: null,
        errorCount: 0,
        notes: 'sk-or-v1- keys required. ci_live_ keys are Claude, not OpenRouter.'
      },
      {
        name: 'free-claude-code',
        apiKey: process.env.FCC_KEY || '',
        baseUrl: process.env.FCC_URL || 'http://localhost:8080/v1',
        priority: 3,
        status: 'standby',
        lastError: null,
        errorCount: 0,
        free_tokens: 1300000000,
        notes: '1.3B free tokens/month, 50 providers'
      },
      {
        name: 'omniroute',
        apiKey: process.env.OMNIROUTE_KEY || '',
        baseUrl: process.env.OMNIROUTE_URL || 'http://localhost:20128/v1',
        priority: 4,
        status: 'standby',
        lastError: null,
        errorCount: 0
      },
      {
        name: 'freellmapi',
        apiKey: process.env.FREELLMAPI_KEY || '',
        baseUrl: process.env.FREELLMAPI_URL || 'http://localhost:3001/v1',
        priority: 5,
        status: 'standby',
        lastError: null,
        errorCount: 0
      }
    ];
    
    // Register all providers in DB
    for (const provider of this.providers) {
      this.db.prepare('INSERT OR IGNORE INTO resources (id, name, type, status, capabilities) VALUES (?, ?, ?, ?, ?)')
        .run(provider.name, provider.name, 'model-provider', provider.status, '["chat","models","tools"]');
    }
  }

  /**
   * Send chat completion with auto-failover
   * Tries providers in order until one succeeds
   */
  async chat({ model = 'auto', messages, stream = false, ...opts }) {
    const errors = [];
    
    // Sort by priority (lowest number = highest priority)
    const sortedProviders = [...this.providers].sort((a, b) => a.priority - b.priority);
    
    for (const provider of sortedProviders) {
      if (provider.status === 'disabled') continue;
      if (!provider.apiKey) continue; // Skip providers without keys
      
      try {
        const result = await this._callProvider(provider, { model, messages, stream, ...opts });
        
        // Success - reset error count
        if (provider.errorCount > 0) {
          provider.errorCount = 0;
          provider.status = 'active';
        }
        
        return {
          ...result,
          provider: provider.name
        };
      } catch (err) {
        // Failed - log error and try next provider
        provider.errorCount++;
        provider.lastError = err.message;
        
        // If too many errors, mark as standby
        if (provider.errorCount >= 3) {
          provider.status = 'standby';
        }
        
        errors.push({ provider: provider.name, error: err.message });
        
        // Continue to next provider (auto-switch, no user notification)
        continue;
      }
    }
    
    // All providers failed
    throw new Error(`All providers failed: ${errors.map(e => `${e.provider}: ${e.error}`).join('; ')}`);
  }

  async _callProvider(provider, { model, messages, stream, ...opts }) {
    const url = `${provider.baseUrl}/chat/completions`;
    
    const headers = {
      'Authorization': `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json'
    };
    
    // OpenRouter specific headers
    if (provider.name === 'openrouter') {
      headers['HTTP-Referer'] = 'http://localhost:3000';
      headers['X-Title'] = 'AI System';
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, stream, ...opts })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    if (stream) {
      return { body: response.body, model };
    }

    const data = await response.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      model: data.model || model,
      usage: data.usage
    };
  }

  async listModels() {
    const provider = this.providers.find(p => p.name === 'kira-ai');
    
    try {
      const response = await fetch(`${provider.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${provider.apiKey}` }
      });
      const data = await response.json();
      return data.data || [];
    } catch {
      return [];
    }
  }

  getStatus() {
    return this.providers.map(p => ({
      name: p.name,
      status: p.status,
      priority: p.priority,
      errorCount: p.errorCount,
      lastError: p.lastError
    }));
  }

  enableProvider(name) {
    const provider = this.providers.find(p => p.name === name);
    if (provider) {
      provider.status = 'active';
      provider.errorCount = 0;
    }
  }

  disableProvider(name) {
    const provider = this.providers.find(p => p.name === name);
    if (provider) {
      provider.status = 'disabled';
    }
  }
}
