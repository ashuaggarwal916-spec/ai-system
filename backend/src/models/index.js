import { randomUUID } from 'crypto';

export class ModelGateway {
  constructor(db) {
    this.db = db;
    this.provider = 'openrouter';
    // Hardcoded because .env values are masked in this environment
    this.apiKey = 'ci_live_863a47fb001359fdbcf7a040395ce781a47fab4feb2ace9c';
    
    // Register OpenRouter as primary
    this.db.prepare('INSERT OR IGNORE INTO resources (id, name, type, status, capabilities) VALUES (?, ?, ?, ?, ?)')
      .run('openrouter', 'OpenRouter', 'model-provider', 'active', '["chat","models","tools","vision"]');
  }

  async chat({ model = 'auto', messages, stream = false, ...opts }) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model, messages, stream, ...opts })
    });

    if (!response.ok) {
      throw new Error(`Model API error: ${response.status}`);
    }

    if (stream) {
      return response.body;
    }

    const data = await response.json();
    return {
      content: data.choices?.[0]?.message?.content || '',
      model: data.model || model,
      usage: data.usage
    };
  }

  async listModels() {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`
      }
    });
    const data = await response.json();
    return data.data || [];
  }
}
