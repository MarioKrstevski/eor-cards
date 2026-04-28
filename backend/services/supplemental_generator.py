"""Generate vignettes and teaching cases for existing cards."""
import anthropic
from backend.config import compute_cost

def generate_supplemental_for_card(
    client: anthropic.Anthropic,
    card: dict,
    rules_text: str,
    model: str,
    field_type: str,  # "vignette" or "teaching_case"
) -> tuple[str, dict]:
    """Generate a vignette or teaching case for a single card.

    Returns (text, usage_dict).
    """
    label = "vignette" if field_type == "vignette" else "teaching case"

    card_context = f"""Card front: {card["front_text"]}

Tags: {", ".join(card.get("tags", []))}
Topic: {card.get("topic_path", "Unknown")}

Generate a {label} for this card following the rules above."""

    response = client.messages.create(
        model=model,
        max_tokens=1024,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": rules_text, "cache_control": {"type": "ephemeral"}},
                    {"type": "text", "text": card_context},
                ],
            }
        ],
    )

    raw = response.content[0].text.strip()
    usage = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "cache_read_input_tokens": getattr(response.usage, "cache_read_input_tokens", 0),
        "cache_creation_input_tokens": getattr(response.usage, "cache_creation_input_tokens", 0),
    }
    return raw, usage
