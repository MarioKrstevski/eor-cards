# EOR Card Studio

Generate Anki cloze flashcards from medical DOCX study guides using Claude.

## Quick Start (Docker)

```bash
cp .env.example .env
# edit .env and add your ANTHROPIC_API_KEY
docker-compose up --build
# open http://localhost:8000
```

## Development

```bash
# Backend
python -m venv .venv && .venv/bin/pip install -r requirements.txt
make dev-backend

# Frontend (separate terminal)
cd frontend && npm install
make dev-frontend
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `DATABASE_URL` | No | SQLite URL (default: `sqlite:///./data/app.db`) |

## Deploy to Railway

1. Push to GitHub
2. New Railway project → Deploy from GitHub repo
3. Add `ANTHROPIC_API_KEY` environment variable
4. Railway auto-detects `railway.toml` and deploys
