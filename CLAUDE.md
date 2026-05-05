# EOR Card Studio — CLAUDE.md

## Project Purpose
A tool for generating Anki-style cloze flashcards from medical study documents (.docx or pasted HTML). Built for a PA (Physician Assistant) exam prep client. Documents are uploaded or pasted, parsed into semantic chunks, AI detects which curriculum topic each chunk belongs to, and Claude generates cloze cards tagged with those topics. Cards can be exported to CSV for Anki import.

## Tech Stack
- **Backend**: FastAPI + SQLAlchemy 2.0 + SQLite + Anthropic Python SDK
- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS v4 + TanStack Table
- **AI**: Anthropic Claude — Sonnet 4.6 default for chunking, Haiku 4.5 for topic detection, Sonnet 4.6 default for card/vignette/teaching case generation (generation models configurable per-session via Settings popover, persisted in localStorage)
- **Dev**: Python 3.12 venv, Node 24, Vite dev server proxying `/api` to FastAPI on :8000

## Development Commands
```bash
# From /v3/
cd "/Users/mario/Documents/work/frex-solutions/client-projects/zhanna-related/eor-guide-to-cards/v3" && PYTHONPATH=. .venv/bin/uvicorn backend.main:app --reload  # backend on :8000
cd frontend && npm run dev   # frontend on :5173
```
The Makefile `make dev-backend` fails if the working directory path has spaces — use the chained cd command above instead.

## Repository Layout
```
v3/
├── backend/
│   ├── main.py           # FastAPI app, router mounts, seed data on startup
│   ├── models.py         # SQLAlchemy ORM models (see schema below)
│   ├── db.py             # Engine + SessionLocal + Base
│   ├── config.py         # ANTHROPIC_API_KEY, MODELS dict (add models here), DEFAULT_MODEL, DEFAULT_CHUNKING_MODEL
│   ├── routers/
│   │   ├── curriculum.py  # CRUD for curriculum tree
│   │   ├── documents.py   # Upload (.docx), paste (HTML clipboard), list, delete; accepts chunking_model param
│   │   ├── cards.py       # List, patch, reject, delete, regenerate cards; bulk review/delete
│   │   ├── generate.py    # Estimate cost, start job, poll job, background task; 3 workers + rate-limit retry
│   │   ├── rules.py       # Rule set CRUD + set-default
│   │   ├── chat.py        # Help chat: sessions CRUD, send message (Haiku), prompt caching, cost tracking
│   │   ├── requests.py    # Feature requests CRUD
│   │   └── export.py      # CSV export by doc or curriculum subtree
│   └── services/
│       ├── chunker.py     # parse_and_chunk_docx / parse_and_chunk_html → semantic chunks via Claude; model param threaded through
│       ├── generator.py   # generate_cards_for_chunk, regenerate_single_card; ANCHOR_INSTRUCTION + parse_card_output (4-part pipe format: number|card|extra|source:P1-P3)
│       ├── supplemental_generator.py  # generate vignette + teaching case per condition group
│       ├── topic_detector.py  # detect_chunk_topics — matches chunks to curriculum tree
│       └── cost_estimator.py  # Token count approximation × model pricing
├── frontend/src/
│   ├── App.tsx            # Router + nav bar
│   ├── context/
│   │   └── SettingsContext.tsx  # selectedModel, vignetteModel, teachingCaseModel, selectedRuleSetId, vignetteRuleSetId, teachingCaseRuleSetId — all persisted to localStorage
│   ├── pages/
│   │   ├── WorkspacePage.tsx   # Upload/paste, chunk view, card panel, generation
│   │   ├── CardsPanel.tsx      # TanStack table + card grid, inline edit/regen/delete; AlertModal on job failure
│   │   └── LibraryPage.tsx     # Curriculum tree editor + rule set CRUD (edit/create via full-screen modal)
│   ├── components/
│   │   ├── AlertModal.tsx      # Single-button notification dialog (OK only) — used for generation failures
│   │   ├── AnkifyModal.tsx     # Full-screen Anki-style card review with cloze reveal (blue underline on reveal)
│   │   ├── ConfirmModal.tsx    # Two-button confirm dialog (Cancel + action)
│   │   ├── CostFlash.tsx       # Cost animation: missiles fly from origin to header total counter
│   │   ├── CurriculumPicker.tsx
│   │   ├── HelpChat.tsx        # Floating chat panel (expand/collapse, sessions, discuss-cards context, Cmd+Enter to send)
│   │   ├── SettingsPopover.tsx # Chunking Model + Generation Model + Rule Set selectors
│   │   └── UsageModal.tsx
│   ├── api.ts             # Axios wrappers; uploadDocument/pasteDocument accept optional chunkingModel param
│   ├── types.ts           # TypeScript interfaces; Document includes total_cards field
│   └── utils.ts           # flattenTree, subtreeIds
├── data/
│   ├── curriculum.json    # Emergency Medicine curriculum — loaded on first boot
│   └── uploads/           # Uploaded .docx files stored here
└── tests/                 # pytest suite
```

## Database Schema (current)
- **rule_sets**: id, name, rule_type (generation/vignette/teaching_case), content, is_default (per rule_type), created_at. Unique on (name, rule_type).
- **curriculum**: id, parent_id (self-FK), name, level, path (full breadcrumb), children/parent rels
- **documents**: id, filename (uuid-prefixed), original_name, uploaded_at, chunk_count
- **chunks**: id, document_id (FK cascade), chunk_index, heading, content_type, source_text, source_html, ref_img (base64 data URI, nullable), rule_subset (JSON), card_count, topic_id (FK → curriculum, nullable), topic_path (string), topic_confirmed (bool)
- **cards**: id, chunk_id (FK cascade), document_id (FK cascade), card_number, front_html, front_text, tags (JSON), extra, vignette, teaching_case, ref_img, source_ref (paragraph range within chunk, e.g. "P3-P5"), ref_img_position (front/back), note_id (bigint, Anki-compatible ms timestamp), status (active/rejected), needs_review, is_reviewed, created_at, updated_at
- **generation_jobs**: id, document_id, job_type (cards/vignettes/teaching_cases), scope, chunk_ids (JSON), rule_set_id, model, status (pending/running/done/failed), total/processed_chunks, total_cards, estimated/actual tokens+cost, error_message, started_at, finished_at
- **ai_usage_log**: id, operation (chunking/topic_detection/card_generation/card_regen), model, input_tokens, output_tokens, cost_usd, document_id, chunk_id, card_id, job_id, created_at

## Key Conventions
- FastAPI routes have NO trailing slash — frontend api.ts must not append `/`
- Card generation output format: `number|card text|additional context (optional)|source:P1-P3` (pipe-delimited, one per line). Parser splits on `|` for card_number, front_html, extra, and source_ref fields. Source text is numbered with [P1], [P2] etc. markers before sending to AI.
- `parse_card_output()` in `generator.py` also runs `fix_markdown_bold()` (converts `**term**` → `<b>term</b>`) and `format_extra_as_list()` (normalizes `;` and `-` delimited lists to `<br>•` bullet format)
- Cloze format: `{{c1::term}}` — rendered with blue underline in Anki view (table + Ankify modal)
- All AI calls use `temperature=0` for consistent output across runs (chunking, topic detection, card generation, card regeneration)
- All AI calls go through the Anthropic SDK only (`anthropic.Anthropic`). OpenAI models are NOT supported without a client abstraction layer refactor.
- Background tasks use FastAPI `BackgroundTasks` with a new `SessionLocal()` (not the request session)
- SQLite JSON columns (tags, chunk_ids, rule_subset) use SQLAlchemy `JSON` type
- Tailwind v4 — no `tailwind.config.js`, config is in CSS via `@theme`
- Rules are NOT sent during chunking — only during card generation and regeneration
- Chunking model is passed from frontend settings → API query/body param → chunker service → Claude call
- `doc_to_dict()` always computes `total_cards` by summing chunk.card_count across all chunks
- Generation uses 3 concurrent workers with per-chunk rate-limit retry (20/40/80s exponential backoff, 4 attempts max)
- `ANCHOR_INSTRUCTION` in `generator.py` is a hardcoded system prompt prepended to all card generation calls — defines anchor rules, cloze-vs-bold decision logic, and the four-part output format (including source paragraph references). It is NOT a user-editable rule set.
- Card regeneration (`cards.py`) explicitly fetches `rule_type='generation'` default rule set (not just any `is_default=True`)

## Adding Models
Edit `backend/config.py` — the `MODELS` dict is the single source of truth. Add an entry:
```python
"claude-opus-4-6": {
    "display": "Claude Opus 4.6",
    "input_per_1m": 15.0,
    "output_per_1m": 75.0,
},
```
The frontend Settings popover reads from `GET /api/generate/models` which reflects this dict. Only Anthropic models work — OpenAI requires a separate SDK and client abstraction.

## Error Handling
- Generation job failures surface via `AlertModal` (prominent dialog, not just inline text)
- Specific Anthropic errors are caught in `_run_generation`: out-of-credits → clear message; rate limit → clear message; invalid key → clear message
- Document upload/paste errors show inline in the sidebar/modal

## AI Usage Cost Tracking
Every Claude API call logs to `ai_usage_log`:
- Chunking: `operation="chunking"` with document_id
- Topic detection: `operation="topic_detection"` with document_id
- Card generation: `operation="card_generation"` with job_id
- Vignette generation: `operation="vignette_generation"` with job_id
- Teaching case generation: `operation="teaching_case_generation"` with job_id
- Card regeneration: `operation="card_regen"` with card_id
Use `GET /api/usage/summary` to return total and per-operation spend.

## Environment
- `.env` at `/v3/.env` — requires `ANTHROPIC_API_KEY`
- SQLite DB at `./data/eor_cards.db` (relative to `/v3/`)
- Uploads stored in `./data/uploads/`
- DB can be deleted and will be recreated on next backend start (seed data re-runs)

## Notes for AI Assistants
- The client is a PA exam prep provider. Medical accuracy in card content matters.
- The curriculum JSON (`data/curriculum.json`) is the source of truth for topic structure — loaded once on first boot via `main.py` seed logic.
- `DocumentViewerModal.tsx` exists but is not used anywhere — safe to delete.
- When in doubt about a topic path format, it is `Parent > Child > Leaf` with ` > ` separators (e.g. `Emergency Medicine > Cardiovascular > Endocarditis`).
- Do not change card output format without updating both `generator.py` parsing logic and the frontend cloze renderer.
- Card output format is `number|card text|additional context (optional)|source:P1-P3`. The third part goes to the `extra` field, the fourth is the source paragraph reference stored in `source_ref`.
- `topic_path` is passed to card generation prompts as "Curriculum context (for reference only)" — it's guidance, not a constraint.
- Card generation injects `ANCHOR_INSTRUCTION` (hardcoded in `generator.py`) — defines anchor rules, cloze-vs-bold decision logic, and formatting rules (`**` is forbidden, use `<b>` HTML). This is prepended to the user's rules before each generation call.
- Card generation includes sibling chunks (same topic_id) as read-only context to give the AI broader topic awareness.
- Vignette/teaching case generation uses card front_text + tags + topic_path only (no chunk source text) to avoid parroting study notes.
- Help Chat (`chat.py`) uses Haiku 4.5, prompt-caches two system blocks (SYSTEM_PROMPT + rules), passes currently selected rule sets from Settings context, tracks cost per message.
- "Discuss in Chat" sends full card objects (front_html with cloze syntax, tags, extra, vignette, teaching_case) as pending context. Cards are not auto-sent — user types their question first.
- Chat input is a textarea: Enter = newline, Cmd/Ctrl+Enter = send.
- Chat panel has expand/collapse mode (fills viewport when expanded).
- The paste pipeline has debug output (saves raw HTML to `data/debug_paste.html` and prints element levels to stderr) — remove before production.
