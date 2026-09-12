# AI System — Multi-User AI Agent Operating System

A complete, deployable multi-user AI agent operating system with central Brain/Orchestrator.

## Quick Start

```bash
# 1. Clone
git clone https://github.com/YOUR_USERNAME/ai-system.git
cd ai-system/backend

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# Edit .env with your OpenRouter API key

# 4. Run
npm run dev
```

Dashboard: http://localhost:3000

## Architecture

```
HUMAN OWNER → PLATFORM ADMIN → BRAIN/ORCHESTRATOR
  ├── Intent Engine → Planner → Capability Discovery
  ├── Agent Selector → Task Orchestrator → Verification
  ├── Model Gateway (OpenRouter → 352 providers)
  ├── Memory Manager (layered, scoped isolation)
  ├── Resource Manager (sleep/wake agents)
  └── Security/Policy Engine (RBAC, audit)
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/register | Create account |
| POST | /api/auth/login | Get JWT token |
| POST | /api/auth/logout | Invalidate token |
| POST | /api/chat | Chat with Brain |
| POST | /api/command | Execute command |
| GET | /api/tasks | List user tasks |
| GET | /api/agents | List agents |
| GET | /api/resources | List resources |
| POST | /api/resources | Register resource |
| GET | /api/memory | Recall memory |
| POST | /api/memory | Store memory |
| GET | /api/models | List available models |

## Deployment

### Free VPS (Oracle Cloud Always Free)
```bash
./infrastructure/deploy oracle
```

### AWS Free Tier
```bash
./infrastructure/deploy aws
```

### Docker
```bash
docker-compose up -d
```

## License

MIT
