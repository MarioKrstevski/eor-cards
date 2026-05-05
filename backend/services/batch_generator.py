"""Batch generator — generates cards from large document batches in few API calls."""

import re
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
            sections.append(current_section)
            current_section = {"heading": elem["text"], "paragraphs": [], "token_estimate": 0}
            continue

        if elem["type"] == "heading" and not current_section["paragraphs"]:
            current_section["heading"] = elem["text"]
            continue

        text = elem["text"].strip()
        if text:
            para_counter += 1
            current_section["paragraphs"].append({
                "index": para_counter,
                "text": text,
            })
            current_section["token_estimate"] += estimate_tokens(text)

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

        remaining = parts[1:]
        non_special = []
        for p in remaining:
            p_stripped = p.strip()
            if p_stripped.startswith("source:"):
                source_ref = p_stripped[len("source:"):].strip() or None
            elif " > " in p_stripped or p_stripped == "Uncategorized":
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
