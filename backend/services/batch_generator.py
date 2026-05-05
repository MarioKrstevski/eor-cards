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
# Keep batches small enough that each produces a reasonable number of cards
# ~10K input tokens ≈ 5-8 sections ≈ 50-100 cards output
MAX_BATCH_TOKENS = 10_000
# Only split on headings at level <= this threshold for chunking
MAJOR_HEADING_LEVEL = 2
# Minimum tokens for a chunk to stand alone (otherwise merge with next)
MIN_CHUNK_TOKENS = 200


def estimate_tokens(text: str) -> int:
    """Rough token estimate from character count."""
    return len(text) // CHARS_PER_TOKEN


def build_sections_from_elements(elements: list) -> list[dict]:
    """Split parsed elements into sections by MAJOR headings only (level <= 2).

    Sub-headings (level 3+) stay within their parent section.
    Returns list of sections: [{heading, paragraphs: [{index, text}], token_estimate, para_start, para_end}]
    """
    sections = []
    current_section = {"heading": "Introduction", "paragraphs": [], "token_estimate": 0}

    para_counter = 0
    for elem in elements:
        # Only split on major headings (level 1-2)
        is_major_heading = (
            elem["type"] == "heading"
            and elem.get("level", 99) <= MAJOR_HEADING_LEVEL
        )

        if is_major_heading and current_section["paragraphs"]:
            sections.append(current_section)
            current_section = {"heading": elem["text"], "paragraphs": [], "token_estimate": 0}
            continue

        if is_major_heading and not current_section["paragraphs"]:
            current_section["heading"] = elem["text"]
            continue

        # All other content (including sub-headings) becomes paragraph content
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

    # Add para_start/para_end for card-to-chunk mapping
    for section in sections:
        if section["paragraphs"]:
            section["para_start"] = section["paragraphs"][0]["index"]
            section["para_end"] = section["paragraphs"][-1]["index"]
        else:
            section["para_start"] = 0
            section["para_end"] = 0

    return sections


def build_chunks_from_sections(sections: list[dict], elements: list) -> list[dict]:
    """Build chunk dicts (for DB storage) from sections.

    Each section becomes one chunk. Uses the same structure as heuristic_chunk()
    but produces fewer, larger chunks aligned with major headings.
    """
    from backend.services.chunker import IMG_DATA_URI_RE

    chunks = []
    # We need to map sections back to element ranges
    # Sections are built from elements in order, splitting on major headings
    elem_idx = 0
    for section_idx, section in enumerate(sections):
        # Find the element range for this section
        # Walk elements to find where this section's content lives
        start_elem = None
        end_elem = None

        # Simple approach: scan elements for content matching this section's heading
        # Since sections are in order, we can track position
        pass

    # Alternative simpler approach: rebuild from elements directly using same logic
    chunk_boundaries = []
    current_start = 0

    for i, elem in enumerate(elements):
        is_major_heading = (
            elem["type"] == "heading"
            and elem.get("level", 99) <= MAJOR_HEADING_LEVEL
        )
        if is_major_heading and i > current_start:
            # Check if previous section has content
            has_content = any(
                e["text"].strip() for e in elements[current_start:i]
                if e["type"] != "heading"
            )
            if has_content:
                chunk_boundaries.append((current_start, i - 1))
                current_start = i

    # Last chunk
    if current_start < len(elements):
        chunk_boundaries.append((current_start, len(elements) - 1))

    # Merge tiny chunks
    merged_boundaries = []
    for start, end in chunk_boundaries:
        chunk_text = " ".join(e["text"] for e in elements[start:end+1] if e["text"].strip())
        tokens = estimate_tokens(chunk_text)
        if merged_boundaries and tokens < MIN_CHUNK_TOKENS:
            # Extend previous
            merged_boundaries[-1] = (merged_boundaries[-1][0], end)
        else:
            merged_boundaries.append((start, end))

    # Build chunk dicts
    for chunk_idx, (start, end) in enumerate(merged_boundaries):
        chunk_elements = elements[start:end + 1]
        source_text_parts = []
        source_html_parts = []
        all_bold_terms = []

        heading = "Section"
        for elem in chunk_elements:
            if elem["type"] == "heading" and heading == "Section":
                heading = elem["text"]

            source_text_parts.append(elem["text"])
            if elem["type"] == "heading":
                level = min(elem.get("level", 2), 4)
                source_html_parts.append(f"<h{level + 1}>{elem['html']}</h{level + 1}>")
            elif elem["type"] == "table":
                source_html_parts.append(elem["html"])
            elif elem["type"] == "bullet":
                source_html_parts.append(
                    f'<div class="bullet level-{elem.get("level", 3)}">{elem["html"]}</div>'
                )
            else:
                source_html_parts.append(f"<p>{elem['html']}</p>")
            all_bold_terms.extend(elem.get("bold_terms", []))
            for img in elem.get("images", []):
                source_html_parts.append(f'<img src="{img["data_uri"]}" class="doc-image" />')

        seen = set()
        unique_bold = []
        for t in all_bold_terms:
            if t not in seen:
                seen.add(t)
                unique_bold.append(t)

        # Determine content type
        has_bullets = any(e["type"] == "bullet" for e in chunk_elements)
        has_paragraphs = any(e["type"] == "paragraph" for e in chunk_elements)
        has_table = any(e["type"] == "table" for e in chunk_elements)
        if has_table:
            content_type = "table"
        elif has_bullets and has_paragraphs:
            content_type = "mixed-paragraph-bullets"
        elif has_bullets:
            content_type = "bullet-list"
        else:
            content_type = "paragraph"

        source_html = "\n".join(source_html_parts)
        img_match = IMG_DATA_URI_RE.search(source_html)

        chunks.append({
            "chunk_index": chunk_idx,
            "heading": heading,
            "content_type": content_type,
            "rule_subset": ["cloze_boundaries"],
            "source_text": "\n".join(source_text_parts),
            "source_html": source_html,
            "bold_terms": unique_bold,
            "element_range": [start, end],
            "ref_img": img_match.group(1) if img_match else None,
        })

    return chunks


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


def assign_card_to_chunk(card_data: dict, sections: list[dict], chunk_objs: list) -> object:
    """Map a card back to its chunk using the source_ref paragraph numbers.

    Returns the best matching chunk object.
    """
    source_ref = card_data.get("source_ref") or ""
    # Extract first paragraph number from source_ref (e.g., "P3-P5" → 3, "P3,P7" → 3)
    p_match = re.match(r'P(\d+)', source_ref)
    if not p_match:
        return chunk_objs[0] if chunk_objs else None

    card_para = int(p_match.group(1))

    # Find which section contains this paragraph number
    for i, section in enumerate(sections):
        if section["para_start"] <= card_para <= section["para_end"]:
            # Map section index to chunk — sections and chunks are 1:1 aligned
            if i < len(chunk_objs):
                return chunk_objs[i]
            break

    return chunk_objs[0] if chunk_objs else None


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
        max_tokens=16384,
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

    # Log if output was truncated (model hit max_tokens before finishing)
    if response.stop_reason == "max_tokens":
        logger.warning(
            "Batch generation hit max_tokens limit (%d cards parsed so far). "
            "Some content may not have been fully covered.",
            len(cards),
        )

    usage = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "cache_read_input_tokens": getattr(response.usage, "cache_read_input_tokens", 0) or 0,
        "cache_creation_input_tokens": getattr(response.usage, "cache_creation_input_tokens", 0) or 0,
    }

    return cards, usage
