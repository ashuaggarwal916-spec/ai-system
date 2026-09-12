import { randomUUID } from 'crypto';

/**
 * Multi-Provider Model Gateway
 * Auto-switches between providers when one fails or hits limits
 */
export class ModelGateway {
  constructor(db) {
    this.db = db;
    this.provider = 'openrouter';
    
    // Provider chain - priority order
    this.providers = [
      {
        name: 'openrouter',
        apiKey: process.env.OPENROUTER_KEY || '',
        baseUrl: 'https://openrouter.ai/api/v1',
        priority: 1,
        status: 'active',
        lastError: null,
        errorCount: 0
      },
      {
        name: 'omniroute',
        apiKey: process.env.OMNIROUTE_KEY || '',
        baseUrl: process.env.OMNIROUTE_URL || 'http://localhost:20128/v1',
        priority: 2,
        status: 'standby',
        lastError: null,
        errorCount: 0
      },
      {
        name: 'freellmapi',
        apiKey: process.env.FREELLMAPI_KEY || '',
        baseUrl: process.env.FREELLMAPI_URL || 'http://localhost:3001/v1',
        priority: 3,
        status: 'standby',
        lastError: null,
        errorCount: 0
      }
    ];
    
    // Register all providers
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
    
    // Try each provider in priority order
    const sortedProviders = [...this.providers].sort((a, b) => a.priority - b.priority);
    
    for (const provider of sortedProviders) {
      if (provider.status === 'disabled') continue;
      
      try {
        const result = await this._callProvider(provider, { model, messages, stream, ...opts });
        
        // Success - reset error count and return
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
    const provider = this.providers.find(p => p.name === 'openrouter');
    
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
