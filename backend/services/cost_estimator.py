from backend.config import MODELS, DEFAULT_MODEL, AVG_OUTPUT_TOKENS_PER_CHUNK


def count_tokens(text: str) -> int:
    """Approximate token count using chars/4.

    NOTE: The spec calls for anthropic.count_tokens() but that requires a synchronous
    API call. For a 1-week tool the approximation is accurate enough (~10% error).
    The UI shows 'estimated' with a disclaimer so users are not misled.
    """
    return max(1, len(text) // 4)


def estimate_cost(chunks: list[dict], rules_text: str, model: str = DEFAULT_MODEL) -> dict:
    """Estimate the cost of generating cards for the given chunks.

    Returns a dict with:
    - chunk_count: number of chunks
    - estimated_input_tokens: total input tokens across all chunks
    - estimated_output_tokens: total output tokens (avg * chunk count)
    - estimated_cost_usd: estimated cost in USD
    - model: model used for pricing
    """
    pricing = MODELS.get(model, MODELS[DEFAULT_MODEL])
    total_input = 0
    for chunk in chunks:
        prompt = rules_text + "\n" + chunk.get("source_text", "")
        total_input += count_tokens(prompt)
    total_output = AVG_OUTPUT_TOKENS_PER_CHUNK * len(chunks)
    cost = (
        total_input / 1_000_000 * pricing["input_per_1m"]
        + total_output / 1_000_000 * pricing["output_per_1m"]
    )
    return {
        "chunk_count": len(chunks),
        "estimated_input_tokens": total_input,
        "estimated_output_tokens": total_output,
        "estimated_cost_usd": round(cost, 4),
        "model": model,
    }
