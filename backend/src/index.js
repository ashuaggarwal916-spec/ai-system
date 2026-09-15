#!/usr/bin/env node
/**
 * AI System — Multi-User AI Agent Operating System
 * Main entry point
 */

import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { config } from 'dotenv';

import { AISystemDB } from './database/index.js';
import { AuthService } from './auth/index.js';
import { Brain } from './brain/index.js';
import { AgentManager } from './agents/index.js';
import { TaskEngine } from './queue/index.js';
import { MemoryManager } from './memory/index.js';
import { ModelGateway } from './models/index.js';
import { ResourceRegistry } from './resources/index.js';
import { WebSocketManager } from './websocket/index.js';
import { PluginManager } from './plugins/index.js';
import { apiRouter } from './api/index.js';

config();

const PORT = process.env.PORT || 3000;

async function main() {
  console.log('🚀 Starting AI System — Multi-User AI Agent Operating System');
  
  // Initialize core services
  const db = new AISystemDB(process.env.DATABASE_URL || './data/ai-system.db');
  await db.migrate();
  
  const auth = new AuthService(db);
  const memory = new MemoryManager(db);
  const models = new ModelGateway(db);
  const registry = new ResourceRegistry(db);
  const agents = new AgentManager(db, models, registry);
  const tasks = new TaskEngine(db, agents, memory);
  const brain = new Brain(db, agents, models, tasks, memory, registry);
  await brain.loadSkills();
  const plugins = new PluginManager(db);
  
  // Express setup
  const app = express();
  const server = http.createServer(app);
  
  // Middleware
  app.use(helmet());
  app.use(cors());
  app.use(compression());
  app.use(express.json());
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));
  
  // API routes
  app.use('/api', apiRouter({ auth, brain, agents, tasks, memory, registry, plugins }));
  
  // WebSocket
  const io = new Server(server, { cors: { origin: '*' } });
  const ws = new WebSocketManager(io, { auth, brain, agents, tasks });
  ws.start();
  
  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  
  // Serve frontend
  app.use(express.static('../frontend'));
  
  // Fallback to index.html for client-side routing
  app.get('*', (req, res) => {
    res.sendFile('index.html', { root: '../frontend' });
  });
  
  // Comment out production-only serving
  // if (process.env.NODE_ENV === 'production') {
  //   app.use(express.static('../frontend/dist'));
  // }
  
  server.listen(PORT, () => {
    console.log(`✅ AI System running on http://localhost:${PORT}`);
    console.log(`   🧠 Brain: ready`);
    console.log(`   🤖 Agents: ${agents.count()} registered`);
    console.log(`   📊 Database: ${db.name}`);
    console.log(`   🌐 Model Gateway: ${models.provider}`);
  });
  
  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await tasks.stop();
    server.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
