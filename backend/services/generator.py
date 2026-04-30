import re
import anthropic
from backend.config import DEFAULT_MODEL

ANCHOR_INSTRUCTION = """CRITICAL RULE — Anchor term: Every card must contain a visible, unclosed "anchor" \
that tells the student what topic/condition/concept they are being tested on. \
Determine the anchor from the topic path, section heading, and content context. \
The anchor is usually the disease, condition, or concept name. \
NEVER cloze the anchor — it must remain readable so the student knows what \
they are studying and can recall the associated facts.

CLOZE VS BOLD DECISION RULE:
- CLOZE ({{cN::term}}) = any independently testable clinical element: anatomical structures, \
physiological terms, condition modifiers, dysfunction types, drug names, lab values, time frames, \
mechanisms, findings. If a student could be tested on recalling it, it must be clozed.
- <b>bold HTML tag</b> = ONLY for structural orientation labels (section headers within a card) \
and explicit emphasis qualifiers already present in the source text. \
NEVER use bold as a substitute for clozing. If a term qualifies for both, it should be CLOZED, not bolded.

FORMATTING RULE — ABSOLUTE: Output plain text only. \
NEVER use markdown formatting. \
** characters are FORBIDDEN — outputting **term** is a formatting error. \
* characters are FORBIDDEN for emphasis. \
No #, no backticks, no markdown of any kind. \
For any emphasis, use only HTML tags: <b>term</b>. \
The output format is: number|card text"""


def strip_card_html(card_text: str) -> str:
    """Strip HTML tags and reveal cloze terms to produce plain text."""
    text = re.sub(r'\{\{c\d+::([^}]+)\}\}', r'\1', card_text)
    return re.sub(r'<[^>]+>', '', text).strip()


def extract_cloze_terms(card_text: str) -> list[str]:
    """Extract cloze deletion terms from card HTML."""
    return re.findall(r'\{\{c\d+::([^}]+)\}\}', card_text)


def fix_markdown_bold(text: str) -> str:
    """Convert any **term** markdown bold to <b>term</b> HTML bold."""
    return re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)


def parse_card_output(raw: str) -> tuple[list[dict], bool]:
    """Parse the numbered|card format output from Claude.

    Returns (cards, needs_review) where needs_review is True if NEEDS_REVIEW
    marker was present in the output.
    """
    cards = []
    needs_review = False
    for line in raw.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        if line == "NEEDS_REVIEW":
            needs_review = True
            continue
        match = re.match(r'^(\d+)\|(.+)$', line)
        if match:
            card_text = fix_markdown_bold(match.group(2).strip())
            cards.append({
                "card_number": int(match.group(1)),
                "front_html": card_text,
                "front_text": strip_card_html(card_text),
            })
    return cards, needs_review


def regenerate_single_card(
    client: anthropic.Anthropic,
    chunk: dict,
    existing_card_html: str,
    rules_text: str,
    extra_prompt: str | None = None,
    model: str = DEFAULT_MODEL,
) -> tuple[list[dict], bool, dict]:
    """Regenerate one card from the same chunk, optionally guided by extra_prompt."""
    topic = chunk.get('topic_path') or ''
    topic_line = f"Curriculum context (for reference only): {topic}\n" if topic else ''

    chunk_prompt = (
        f"You are regenerating a single flashcard from the source content below.\n\n"
        f"{topic_line}Section: {chunk.get('heading', '')}\n\n"
        f"Source text:\n{chunk.get('source_text', '')}\n\n"
        f"The existing card (improve or replace it):\n{existing_card_html}\n"
    )
    if extra_prompt:
        chunk_prompt += f"\nAdditional guidance: {extra_prompt}\n"
    chunk_prompt += "\nGenerate ONE improved replacement card. Output exactly:\n1|cloze card text"

    response = client.messages.create(
        model=model,
        max_tokens=512,
        temperature=0.2,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": rules_text + "\n\n---\n\n",
                    "cache_control": {"type": "ephemeral"},
                },
                {
                    "type": "text",
                    "text": chunk_prompt,
                },
            ],
        }],
    )
    raw = response.content[0].text.strip()
    cards, needs_review = parse_card_output(raw)
    usage = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "cache_read_input_tokens": getattr(response.usage, "cache_read_input_tokens", 0) or 0,
        "cache_creation_input_tokens": getattr(response.usage, "cache_creation_input_tokens", 0) or 0,
    }
    return cards, needs_review, usage


def generate_cards_for_chunk(
    client: anthropic.Anthropic,
    chunk: dict,
    rules_text: str,
    model: str = DEFAULT_MODEL,
    sibling_texts: list[dict] = None,
) -> tuple[list[dict], bool, dict]:
    """Generate cards for a single chunk using Claude.

    Returns (cards, needs_review, usage) where usage is
    {"input_tokens": int, "output_tokens": int}.
    Rules text is marked for prompt caching — repeated calls within 5 min
    reuse the cached prefix, cutting input token cost ~90% for the rules portion.
    sibling_texts: list of sibling chunk dicts (same topic_id) for context only.
    """
    topic = chunk.get('topic_path') or ''
    topic_line = f"Curriculum context (for reference only): {topic}\n" if topic else ''

    sibling_section = ""
    if sibling_texts:
        parts = []
        total_chars = 0
        for s in sibling_texts:
            if total_chars + len(s["source_text"]) > 32000:  # ~8000 token cap
                break
            parts.append(f'[Chunk "{s["heading"]}"]:' + "\n" + s["source_text"])
            total_chars += len(s["source_text"])
        if parts:
            sibling_section = "\n\n--- RELATED CONTENT (context only — do NOT generate cards from this) ---\n" + "\n\n".join(parts)

    chunk_prompt = (
        f"Now generate cards from the following study note content.\n\n"
        f"{topic_line}Section: {chunk.get('heading', '')}\n\n"
        f"Source text:\n{chunk.get('source_text', '')}"
        f"{sibling_section}\n\n"
        f"Generate the cards following ALL the rules above. Output in the exact format:\n"
        f"number|cloze card text\n\n"
        f"If you cannot confidently generate quality cards for this content, output NEEDS_REVIEW on its own line at the end.\n"
        f"Remember: card N uses only cN for all clozes."
    )

    response = client.messages.create(
        model=model,
        max_tokens=4096,
        temperature=0.2,
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": ANCHOR_INSTRUCTION + "\n\n" + rules_text + "\n\n---\n\n",
                    "cache_control": {"type": "ephemeral"},
                },
                {
                    "type": "text",
                    "text": chunk_prompt,
                },
            ],
        }],
    )
    raw = response.content[0].text.strip()
    cards, needs_review = parse_card_output(raw)
    usage = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "cache_read_input_tokens": getattr(response.usage, "cache_read_input_tokens", 0) or 0,
        "cache_creation_input_tokens": getattr(response.usage, "cache_creation_input_tokens", 0) or 0,
    }
    return cards, needs_review, usage
