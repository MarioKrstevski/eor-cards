import re
from typing import Optional
import anthropic
from backend.config import DEFAULT_MODEL


def strip_card_html(card_text: str) -> str:
    """Strip HTML tags and reveal cloze terms to produce plain text."""
    text = re.sub(r'\{\{c\d+::([^}]+)\}\}', r'\1', card_text)
    return re.sub(r'<[^>]+>', '', text).strip()


def extract_cloze_terms(card_text: str) -> list[str]:
    """Extract cloze deletion terms from card HTML."""
    return re.findall(r'\{\{c\d+::([^}]+)\}\}', card_text)


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
            card_text = match.group(2).strip()
            cards.append({
                "card_number": int(match.group(1)),
                "front_html": card_text,
                "front_text": strip_card_html(card_text),
            })
    return cards, needs_review


def generate_cards_for_chunk(
    client: anthropic.Anthropic,
    chunk: dict,
    rules_text: str,
    model: str = DEFAULT_MODEL,
) -> tuple[list[dict], bool]:
    """Generate cards for a single chunk using Claude.

    Returns (cards, needs_review).
    cards is a list of dicts with: card_number, front_html, front_text
    """
    prompt = f"""{rules_text}

---

Now generate cards from the following study note content.

Section: {chunk.get('heading', '')}

Source text:
{chunk['source_text']}

Generate the cards following ALL the rules above. Output in the exact format:
number|cloze card text

If you cannot confidently generate quality cards for this content, output NEEDS_REVIEW on its own line at the end.
Remember: card N uses only cN for all clozes."""

    response = client.messages.create(
        model=model,
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    raw = response.content[0].text.strip()
    cards, needs_review = parse_card_output(raw)
    return cards, needs_review
