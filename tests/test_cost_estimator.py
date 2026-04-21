from backend.services.cost_estimator import estimate_cost

def test_estimate_cost_returns_positive():
    chunks = [{"source_text": "Atrial fibrillation causes irregular rhythm."}]
    result = estimate_cost(chunks, rules_text="# rules\nDo stuff.", model="claude-sonnet-4-6")
    assert result["estimated_cost_usd"] > 0
    assert result["estimated_input_tokens"] > 0
    assert result["estimated_output_tokens"] > 0
    assert result["chunk_count"] == 1

def test_estimate_cost_multiple_chunks():
    chunks = [
        {"source_text": "Chunk one content."},
        {"source_text": "Chunk two content."},
    ]
    result = estimate_cost(chunks, rules_text="Rules.", model="claude-sonnet-4-6")
    assert result["chunk_count"] == 2
    assert result["estimated_output_tokens"] == 1600  # 2 * AVG_OUTPUT_TOKENS_PER_CHUNK (800)
