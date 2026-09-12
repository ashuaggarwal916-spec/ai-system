import { randomUUID } from 'crypto';

export class WebSocketManager {
  constructor(io, { auth, brain, agents, tasks }) {
    this.io = io;
    this.auth = auth;
    this.brain = brain;
    this.agents = agents;
    this.tasks = tasks;
  }

  start() {
    this.io.on('connection', (socket) => {
      console.log(`Client connected: ${socket.id}`);

      socket.on('authenticate', (token) => {
        const decoded = this.auth.verifyToken(token);
        if (decoded) {
          socket.userId = decoded.userId;
          socket.join(`user:${decoded.userId}`);
          socket.emit('authenticated', { success: true });
        } else {
          socket.emit('authenticated', { success: false });
        }
      });

      socket.on('command', async (data) => {
        if (!socket.userId) return;
        const result = await this.brain.processCommand(socket.userId, data.command);
        socket.emit('command:result', result);
      });

      socket.on('chat', async (data) => {
        if (!socket.userId) return;
        const result = await this.brain.chat(socket.userId, data.message);
        socket.emit('chat:result', result);
      });

      socket.on('task:status', async (taskId) => {
        if (!socket.userId) return;
        const task = await this.brain.getTaskStatus(taskId);
        socket.emit('task:update', task);
      });

      socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
      });
    });
  }

  broadcast(event, data) {
    this.io.emit(event, data);
  }

  sendToUser(userId, event, data) {
    this.io.to(`user:${userId}`).emit(event, data);
  }
}
