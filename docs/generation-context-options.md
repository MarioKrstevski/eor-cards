# Generation Context Options

This document describes the two main strategies for providing broader topic context to the card generator, and when to switch between them.

---

## Option A — Sibling Context Enrichment (current implementation)

Each chunk is still generated individually, but sibling chunks under the same curriculum topic (`topic_id`) are appended to the prompt as read-only context. The AI uses this to understand the full scope of the topic without generating cards from the sibling content.

**How it works:**
- Chunks are grouped by `topic_id` before generation starts.
- For each chunk being generated, all other chunks sharing the same `topic_id` are collected as siblings.
- Siblings are appended after the primary source text, clearly labeled as context-only, capped at ~32,000 characters (~8,000 tokens) to avoid runaway context windows.
- Generation remains parallelized across 14 workers — one API call per chunk.

**Pros:**
- Minimal disruption to existing parallelism and job tracking.
- AI can avoid duplicating concepts already covered in sibling chunks (if told to do so via rules).
- Per-chunk token usage remains predictable and auditable.
- Prompt cache still benefits the rules block (shared cached prefix per worker lifetime).

**Cons:**
- Each chunk's call includes sibling text as uncached tokens, increasing cost per chunk when topics have many siblings.
- The AI still doesn't "know" what cards were generated for siblings — only their source text.
- Does not fully prevent duplicate cards across sibling chunks.

**When to stay with Option A:** Quality improves noticeably (anchor terms stop being clozed, related concepts are better contextualized) and duplicate rates are acceptable.

---

## Option B — Topic-Level Batching (fallback)

All chunks under the same leaf topic are concatenated and sent in a single API call. The AI generates cards for the entire topic in one pass.

**How it works:**
- Before generation, chunks are grouped by `topic_id`.
- For each topic group, all `source_text` values are joined in order and sent as one prompt.
- Output cards are bulk-parsed and attributed back to their source chunks by section heading markers inserted at concatenation boundaries.
- `ThreadPoolExecutor` is parallelized by topic group rather than individual chunk.

**Pros:**
- AI has complete topic awareness — no duplicates across chunks, consistent anchor usage, natural progression of card difficulty.
- Reduces total API calls when topics have many small chunks.

**Cons:**
- Larger prompts per call — topic groups with 10+ chunks may exceed 100K input tokens.
- Output parsing becomes more complex (must re-attribute cards to source chunks for DB storage).
- Job progress granularity drops from per-chunk to per-topic.
- Prompt cache is less effective — topic batch prompts are all unique.
- Harder to isolate which chunk caused a `NEEDS_REVIEW` flag.

**When to switch to Option B:** Option A is implemented and deployed but card quality is still insufficient — anchors are still inconsistently handled or sibling duplication remains problematic at scale. Switch only after measuring Option A's actual quality impact on a representative document batch.

---

## Decision Criteria

| Signal | Action |
|---|---|
| Anchor cloze rate drops to near zero after Option A | Stay with Option A |
| Duplicate card rate across siblings remains >10% | Consider Option B |
| Token cost increase from sibling context is acceptable | Stay with Option A |
| Topic groups are large (>8 chunks) and prompt costs spike | Consider Option B with chunk limits per batch |
