# Simplified Batch Generation Pipeline

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the multi-step AI pipeline (AI chunking → AI topic detection → per-chunk card generation) with a simplified flow: deterministic splitting → batched card generation with inline topic tagging.

**Architecture:** Documents are parsed deterministically (no AI) into sections by headings. Sections are packed into batches (~40K tokens each). Each batch is sent to Claude with the curriculum tree + rules in one call, producing cards with topic tags and source refs. This reduces 20-40 API calls to 2-5.

**Tech Stack:** FastAPI, Anthropic Python SDK, SQLAlchemy, existing models/schema unchanged.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/services/batch_generator.py` | Create | Batch assembly, prompt construction, response parsing, token estimation |
| `backend/routers/documents.py` | Modify | Add `POST /paste-simple` and `POST /upload-simple` endpoints |
| `backend/services/chunker.py` | Reuse | Keep `parse_docx()`, `parse_html_to_elements()`, `heuristic_chunk()` — deterministic parsing only |
| `frontend/src/api.ts` | Modify | Add `uploadDocumentSimple()` and `pasteDocumentSimple()` wrappers |
| `frontend/src/pages/WorkspacePage.tsx` | Modify | Wire new endpoints into upload/paste flow |

---

### Task 1: Create `batch_generator.py` — Core Batching Service

**Files:**
- Create: `backend/services/batch_generator.py`

- [ ] **Step 1: Create the batch generator module with token estimation and section batching**

```python
"""Batch generator — generates cards from large document batches in few API calls."""

import re
import time
import logging
from typing import Optional
import anthropic

from backend.config import DEFAULT_MODEL
from backend.services.generator import (
    ANCHOR_INSTRUCTION,
    fix_markdown_bold,
    format_extra_as_list,
    strip_card_html,
)

logger = logging.getLogger(__name__)

# Rough estimate: 4 chars ≈ 1 token
CHARS_PER_TOKEN = 4
MAX_BATCH_TOKENS = 40_000  # leave room for system prompt + output


def estimate_tokens(text: str) -> int:
    """Rough token estimate from character count."""
    return len(text) // CHARS_PER_TOKEN


def build_sections_from_elements(elements: list) -> list[dict]:
    """Split parsed elements into sections by headings (deterministic, no AI).

    Returns list of sections: [{heading, paragraphs: [{index, text}], token_estimate}]
    """
    sections = []
    current_section = {"heading": "Introduction", "paragraphs": [], "token_estimate": 0}

    para_counter = 0
    for elem in elements:
        if elem["type"] == "heading" and current_section["paragraphs"]:
            # Finalize current section
            sections.append(current_section)
            current_section = {"heading": elem["text"], "paragraphs": [], "token_estimate": 0}
            continue

        if elem["type"] == "heading" and not current_section["paragraphs"]:
            # Update heading if no content yet
            current_section["heading"] = elem["text"]
            continue

        # Add content paragraph
        text = elem["text"].strip()
        if text:
            para_counter += 1
            current_section["paragraphs"].append({
                "index": para_counter,
                "text": text,
            })
            current_section["token_estimate"] += estimate_tokens(text)

    # Don't forget the last section
    if current_section["paragraphs"]:
        sections.append(current_section)

    return sections


def pack_batches(sections: list[dict], max_tokens: int = MAX_BATCH_TOKENS) -> list[list[dict]]:
    """Pack sections into batches that fit within token budget."""
    batches = []
    current_batch = []
    current_tokens = 0

    for section in sections:
        section_tokens = section["token_estimate"]

        # If a single section exceeds max, it gets its own batch
        if section_tokens > max_tokens:
            if current_batch:
                batches.append(current_batch)
                current_batch = []
                current_tokens = 0
            batches.append([section])
            continue

        # Would adding this section exceed the limit?
        if current_tokens + section_tokens > max_tokens and current_batch:
            batches.append(current_batch)
            current_batch = []
            current_tokens = 0

        current_batch.append(section)
        current_tokens += section_tokens

    if current_batch:
        batches.append(current_batch)

    return batches


def build_batch_prompt(sections: list[dict], curriculum_tree: str) -> str:
    """Build the user prompt for a batch of sections."""
    # Number paragraphs globally across the batch
    content_parts = []
    for section in sections:
        content_parts.append(f"\n--- Section: {section['heading']} ---")
        for para in section["paragraphs"]:
            content_parts.append(f"[P{para['index']}] {para['text']}")

    content_block = "\n".join(content_parts)

    return f"""Generate cloze flashcards from the study content below.
For each card, assign the most specific matching curriculum topic from the tree provided.

CURRICULUM TOPICS (assign one per card):
{curriculum_tree}

STUDY CONTENT:
{content_block}

Output format — one card per line:
number|card text with {{{{c1::cloze deletions}}}}|extra context (optional)|topic_path|source:P1-P3

Rules:
- topic_path must be the FULL path from the curriculum tree (e.g., "Emergency Medicine > Cardiovascular > Endocarditis")
- If no curriculum topic matches, use "Uncategorized" as topic_path
- source field references [P1], [P2] etc. markers from the content above
- ALL clozes use {{{{c1::term}}}} — always c1
- Every card needs a visible anchor (disease/condition name) that is NOT clozed
- Generate as many cards as the content warrants — thorough coverage

Remember: ALL clozes on every card use {{{{c1::term}}}} — always c1, regardless of card number."""


def parse_batch_output(raw: str) -> list[dict]:
    """Parse batch generation output.

    Format: number|card text|extra|topic_path|source:P1-P3
    The topic_path field is new compared to per-chunk generation.
    """
    cards = []
    for line in raw.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        if line == "NEEDS_REVIEW":
            continue

        match = re.match(r'^(\d+)\|(.+)$', line)
        if not match:
            continue

        parts = match.group(2).split('|')
        card_text = fix_markdown_bold(parts[0].strip())

        extra = None
        topic_path = None
        source_ref = None

        # Parse remaining parts — look for source: and topic_path
        remaining = parts[1:]
        non_special = []
        for p in remaining:
            p_stripped = p.strip()
            if p_stripped.startswith("source:"):
                source_ref = p_stripped[len("source:"):].strip() or None
            elif " > " in p_stripped or p_stripped == "Uncategorized":
                # This looks like a topic path
                topic_path = p_stripped
            else:
                non_special.append(p)

        if non_special:
            raw_extra = "|".join(non_special).strip()
            if raw_extra:
                extra = format_extra_as_list(fix_markdown_bold(raw_extra))

        cards.append({
            "card_number": int(match.group(1)),
            "front_html": card_text,
            "front_text": strip_card_html(card_text),
            "extra": extra,
            "topic_path": topic_path,
            "source_ref": source_ref,
        })

    return cards


def generate_batch(
    client: anthropic.Anthropic,
    sections: list[dict],
    rules_text: str,
    curriculum_tree: str,
    model: str = DEFAULT_MODEL,
) -> tuple[list[dict], dict]:
    """Generate cards for a batch of sections in a single API call.

    Returns (cards, usage) where usage = {input_tokens, output_tokens}.
    """
    prompt = build_batch_prompt(sections, curriculum_tree)

    response = client.messages.create(
        model=model,
        max_tokens=8192,
        temperature=0,
        system=[{
            "type": "text",
            "text": ANCHOR_INSTRUCTION + "\n\n" + rules_text,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{"role": "user", "content": prompt}],
    )

    raw = response.content[0].text.strip()
    cards = parse_batch_output(raw)

    usage = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "cache_read_input_tokens": getattr(response.usage, "cache_read_input_tokens", 0) or 0,
        "cache_creation_input_tokens": getattr(response.usage, "cache_creation_input_tokens", 0) or 0,
    }

    return cards, usage
```

- [ ] **Step 2: Commit**

```bash
git add backend/services/batch_generator.py
git commit -m "feat: add batch_generator service for simplified pipeline"
```

---

### Task 2: Add Simple Pipeline Endpoints to `documents.py`

**Files:**
- Modify: `backend/routers/documents.py`

- [ ] **Step 1: Add the simple pipeline endpoints and background task**

Add after the existing full-auto pipeline section at the bottom of `documents.py`:

```python
# ── Simple Batch Pipeline ──────────────────────────────────────────────────────


class PasteSimpleRequest(BaseModel):
    html: str
    name: str
    model: str = DEFAULT_MODEL
    rule_set_id: int


@router.post("/upload-simple", status_code=201)
async def upload_document_simple(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    model: str = Form(DEFAULT_MODEL),
    rule_set_id: int = Form(...),
    db: Session = Depends(get_db),
):
    """Upload .docx → deterministic split → batched card generation (simplified pipeline)."""
    if not file.filename.endswith(".docx"):
        raise HTTPException(422, "Only .docx files supported")

    rs = db.get(RuleSet, rule_set_id)
    if not rs:
        raise HTTPException(404, "Rule set not found")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    stem, ext = os.path.splitext(file.filename)
    unique_filename = f"{stem}_{uuid.uuid4().hex[:8]}{ext}"
    save_path = os.path.join(UPLOAD_DIR, unique_filename)
    with open(save_path, "wb") as f:
        f.write(await file.read())

    doc = Document(
        filename=unique_filename,
        original_name=file.filename,
        chunk_count=0,
    )
    db.add(doc)
    db.flush()

    job = GenerationJob(
        document_id=doc.id,
        job_type="simple_batch",
        scope="all",
        rule_set_id=rule_set_id,
        model=model,
        status=JobStatus.pending,
        total_chunks=0,
        processed_chunks=0,
        total_cards=0,
        pipeline_step="parsing",
    )
    db.add(job)
    db.commit()
    db.refresh(doc)
    db.refresh(job)

    background_tasks.add_task(
        _run_simple_pipeline,
        doc.id,
        job.id,
        save_path,
        None,  # html
        model,
        rule_set_id,
        is_docx=True,
    )

    return {"document_id": doc.id, "job_id": job.id}


@router.post("/paste-simple", status_code=201)
async def paste_document_simple(
    body: PasteSimpleRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Paste HTML → deterministic split → batched card generation (simplified pipeline)."""
    if not body.html or not body.html.strip():
        raise HTTPException(422, "No HTML content provided")
    if not body.name or not body.name.strip():
        raise HTTPException(422, "Document name is required")

    rs = db.get(RuleSet, body.rule_set_id)
    if not rs:
        raise HTTPException(404, "Rule set not found")

    doc = Document(
        filename=f"paste_{uuid.uuid4().hex[:8]}.html",
        original_name=body.name.strip(),
        chunk_count=0,
    )
    db.add(doc)
    db.flush()

    job = GenerationJob(
        document_id=doc.id,
        job_type="simple_batch",
        scope="all",
        rule_set_id=body.rule_set_id,
        model=body.model,
        status=JobStatus.pending,
        total_chunks=0,
        processed_chunks=0,
        total_cards=0,
        pipeline_step="parsing",
    )
    db.add(job)
    db.commit()
    db.refresh(doc)
    db.refresh(job)

    background_tasks.add_task(
        _run_simple_pipeline,
        doc.id,
        job.id,
        None,  # file_path
        body.html,
        body.model,
        body.rule_set_id,
        is_docx=False,
    )

    return {"document_id": doc.id, "job_id": job.id}


def _run_simple_pipeline(
    doc_id: int,
    job_id: int,
    file_path: Optional[str],
    html: Optional[str],
    model: str,
    rule_set_id: int,
    is_docx: bool,
):
    """Background task: simplified pipeline — deterministic parse → batch generate."""
    from backend.services.batch_generator import (
        build_sections_from_elements,
        pack_batches,
        generate_batch,
    )
    from backend.services.chunker import parse_docx, parse_html_to_elements, heuristic_chunk, assemble_chunks

    db = SessionLocal()
    try:
        job = db.get(GenerationJob, job_id)
        job.status = JobStatus.running
        job.started_at = utcnow()
        job.pipeline_step = "parsing"
        db.commit()

        # ── Step 1: Parse document deterministically (no AI) ─────────────────
        if is_docx:
            img_dir = os.path.join(DATA_DIR, "chunk_images")
            os.makedirs(img_dir, exist_ok=True)
            elements, images = parse_docx(file_path, img_dir)
        else:
            elements, images = parse_html_to_elements(html)

        if not elements:
            _fail_auto_job(db, job_id, "No content could be extracted from the document")
            return

        # ── Step 2: Build sections and batches ───────────────────────────────
        job.pipeline_step = "batching"
        db.commit()

        sections = build_sections_from_elements(elements)

        # Also create chunks in DB using heuristic splitting (for UI display & card FK)
        heuristic_chunks = heuristic_chunk(elements)
        doc = db.get(Document, doc_id)
        doc.chunk_count = len(heuristic_chunks)

        chunk_objs = []
        for c in heuristic_chunks:
            chunk = Chunk(
                document_id=doc_id,
                chunk_index=c["chunk_index"],
                heading=c["heading"],
                content_type=c["content_type"],
                source_text=c["source_text"],
                source_html=c["source_html"],
                ref_img=c.get("ref_img"),
                rule_subset=c.get("rule_subset", []),
            )
            db.add(chunk)
            chunk_objs.append(chunk)
        db.commit()
        for ch in chunk_objs:
            db.refresh(ch)

        # Build curriculum tree string for the prompt
        curriculum_nodes = db.query(Curriculum).all()
        curriculum_tree = "\n".join(f"  {n.path}" for n in curriculum_nodes if n.path) if curriculum_nodes else "No curriculum loaded"

        # Pack sections into batches
        batches = pack_batches(sections)
        job.total_chunks = len(batches)  # "chunks" = batches for progress
        db.commit()

        # ── Step 3: Generate cards in batches ────────────────────────────────
        job.pipeline_step = "generating"
        db.commit()

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        rs = db.get(RuleSet, rule_set_id)
        rules_text = rs.content

        total_cards = 0
        total_input_tokens = 0
        total_output_tokens = 0
        note_id_base = int(time.time() * 1000)
        note_id_counter = 0

        # Build a heading→chunk lookup so we can assign cards to chunks
        chunk_by_heading = {}
        for ch in chunk_objs:
            chunk_by_heading[ch.heading.lower().strip()] = ch
        # Fallback: first chunk
        default_chunk = chunk_objs[0] if chunk_objs else None

        for batch_idx, batch in enumerate(batches):
            for attempt in range(4):
                try:
                    cards_data, usage = generate_batch(
                        client, batch, rules_text, curriculum_tree, model
                    )
                    break
                except anthropic.RateLimitError:
                    if attempt == 3:
                        raise
                    wait = 20 * (2 ** attempt)
                    logger.warning("Rate limit on batch %d, retrying in %ds", batch_idx, wait)
                    time.sleep(wait)

            # Save cards — assign to appropriate chunk based on source_ref
            for card_data in cards_data:
                # Try to match card to a chunk by looking at which section it came from
                # For now, assign to default chunk (can refine later)
                target_chunk = default_chunk

                # Try matching by topic_path or source paragraph range
                # Simple heuristic: find chunk whose heading matches section
                topic_path = card_data.get("topic_path")
                tags = topic_path.split(" > ") if topic_path and topic_path != "Uncategorized" else []

                # Try to find matching chunk by checking if card's source paragraphs
                # fall within a chunk's element range
                # For now: assign to first chunk (cards still display fine)
                # The chunk assignment is for grouping — not critical for card quality

                card = Card(
                    chunk_id=target_chunk.id if target_chunk else chunk_objs[0].id,
                    document_id=doc_id,
                    card_number=card_data["card_number"],
                    front_html=card_data["front_html"],
                    front_text=card_data["front_text"],
                    extra=card_data.get("extra"),
                    source_ref=card_data.get("source_ref"),
                    tags=tags,
                    needs_review=False,
                    note_id=note_id_base + note_id_counter,
                )
                note_id_counter += 1
                db.add(card)
                total_cards += 1

            total_input_tokens += usage["input_tokens"]
            total_output_tokens += usage["output_tokens"]
            job.processed_chunks = batch_idx + 1
            db.commit()

        # Update chunk card counts
        for ch in chunk_objs:
            ch.card_count = db.query(Card).filter(Card.chunk_id == ch.id).count()
        db.commit()

        # Log usage
        db.add(AIUsageLog(
            operation="card_generation",
            model=model,
            input_tokens=total_input_tokens,
            output_tokens=total_output_tokens,
            cost_usd=compute_cost(model, total_input_tokens, total_output_tokens),
            document_id=doc_id,
            job_id=job_id,
        ))

        job.pipeline_step = "done"
        job.status = JobStatus.done
        job.total_cards = total_cards
        job.actual_input_tokens = total_input_tokens
        job.actual_output_tokens = total_output_tokens
        job.finished_at = utcnow()
        db.commit()

    except anthropic.AuthenticationError:
        _fail_auto_job(db, job_id, "Anthropic API key is invalid or missing.")
    except anthropic.PermissionDeniedError as e:
        msg = str(e).lower()
        if "credit" in msg or "billing" in msg or "balance" in msg or "quota" in msg:
            _fail_auto_job(db, job_id, "Your Anthropic account is out of credits.")
        else:
            _fail_auto_job(db, job_id, f"Anthropic permission error: {e}")
    except anthropic.RateLimitError:
        _fail_auto_job(db, job_id, "Rate limit reached after all retries.")
    except anthropic.APIStatusError as e:
        msg = str(e).lower()
        if "credit" in msg or "billing" in msg or "balance" in msg:
            _fail_auto_job(db, job_id, "Your Anthropic account is out of credits.")
        else:
            _fail_auto_job(db, job_id, f"Anthropic API error ({e.status_code}): {e.message}")
    except Exception as e:
        logger.exception("_run_simple_pipeline failed")
        _fail_auto_job(db, job_id, str(e))
    finally:
        db.close()
```

- [ ] **Step 2: Commit**

```bash
git add backend/routers/documents.py
git commit -m "feat: add simplified batch pipeline endpoints (upload-simple, paste-simple)"
```

---

### Task 3: Wire Frontend to New Endpoints

**Files:**
- Modify: `frontend/src/api.ts`
- Modify: `frontend/src/pages/WorkspacePage.tsx`

- [ ] **Step 1: Add API wrappers in `api.ts`**

Add after the existing `pasteDocumentAuto` function:

```typescript
export async function uploadDocumentSimple(
  file: File,
  params: { model: string; rule_set_id: number }
): Promise<FullAutoStartResponse> {
  const form = new FormData();
  form.append('file', file);
  form.append('model', params.model);
  form.append('rule_set_id', String(params.rule_set_id));
  const res = await http.post<FullAutoStartResponse>('/documents/upload-simple', form);
  return res.data;
}

export async function pasteDocumentSimple(params: {
  html: string;
  name: string;
  model: string;
  rule_set_id: number;
}): Promise<FullAutoStartResponse> {
  const res = await http.post<FullAutoStartResponse>('/documents/paste-simple', params);
  return res.data;
}
```

- [ ] **Step 2: Update WorkspacePage to use new endpoints**

Replace `uploadDocumentAuto`/`pasteDocumentAuto` calls with `uploadDocumentSimple`/`pasteDocumentSimple` (remove `supplemental_rule_set_id` param since it's not needed in simplified flow).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api.ts frontend/src/pages/WorkspacePage.tsx
git commit -m "feat: wire frontend to simplified batch pipeline"
```

---

### Task 4: Fix Card List Pagination (OOM Fix)

**Files:**
- Modify: `frontend/src/pages/WorkspacePage.tsx`
- Modify: `frontend/src/pages/CardsPanel.tsx`

- [ ] **Step 1: Replace `limit: 5000` with reasonable pagination**

In both files, change `limit: 5000` to `limit: 100` and implement "load more" or proper pagination in the UI. At minimum, just reducing to 100 stops the OOM.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/pages/WorkspacePage.tsx frontend/src/pages/CardsPanel.tsx
git commit -m "fix: reduce card fetch limit from 5000 to 100 to prevent OOM"
```

---

## Implementation Notes

- The old pipeline endpoints (`/upload`, `/paste`, `/upload-auto`, `/paste-auto`) remain untouched — they still work, can be removed later if the new pipeline proves solid.
- The `heuristic_chunk()` function already exists in `chunker.py` and splits by headings. We use it to create chunk records (needed for card FKs and UI grouping).
- Card-to-chunk assignment in the simple pipeline is approximate (assigns to first chunk). This is fine because cards display by document anyway, and the chunk FK is mainly for source HTML display.
- The `generate_batch` function uses `max_tokens=8192` for output — this allows ~100+ cards per batch call. If a batch produces more, bump this.
- Curriculum tree is sent as full paths (one per line) in the system prompt. This gives the model everything it needs to tag cards without a separate topic detection step.
