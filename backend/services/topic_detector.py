"""Topic detector — uses Claude to match each chunk to the best curriculum topic."""
import json
import logging
import re
from typing import Optional
import anthropic
from backend.config import DEFAULT_MODEL

logger = logging.getLogger(__name__)


def detect_chunk_topics(
    client: anthropic.Anthropic,
    chunks: list[dict],  # each: {id, heading, source_text}
    curriculum_nodes: list[dict],  # each: {id, path}
    model: str = DEFAULT_MODEL,
) -> tuple[list[dict], dict]:
    """
    For each chunk, find the best matching curriculum topic.
    Returns: (mappings, usage)
    mappings: list of {chunk_id, topic_id, topic_path} — topic_id/topic_path may be None
    usage: {input_tokens, output_tokens}
    """
    if not chunks or not curriculum_nodes:
        return [], {"input_tokens": 0, "output_tokens": 0}

    topic_lines = "\n".join(f"{n['id']}: {n['path']}" for n in curriculum_nodes)
    chunk_lines = "\n\n".join(
        f"CHUNK_ID={c['id']} heading={c.get('heading', 'N/A')}\n{c.get('source_text', '')[:350]}"
        for c in chunks
    )

    prompt = f"""You are a medical curriculum specialist. Match each study document chunk to the single most specific curriculum topic it belongs to.

CURRICULUM TOPICS (id: full path):
{topic_lines}

DOCUMENT CHUNKS (each starts with CHUNK_ID=):
{chunk_lines}

Rules:
- Pick the MOST SPECIFIC matching topic (deepest level that fits)
- If a chunk spans multiple topics, pick the primary one
- If no topic fits, use null for topic_id

Return ONLY a JSON array, no explanation:
[{{"chunk_id": <int>, "topic_id": <int or null>}}, ...]"""

    response = client.messages.create(
        model=model,
        max_tokens=1024,
        temperature=0.2,
        messages=[{"role": "user", "content": prompt}],
    )

    usage = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
    }

    text = response.content[0].text.strip()
    match = re.search(r"\[.*\]", text, re.DOTALL)
    if not match:
        logger.warning("Topic detector returned non-JSON: %s", text[:200])
        return [{"chunk_id": c["id"], "topic_id": None, "topic_path": None} for c in chunks], usage

    raw = json.loads(match.group(0))

    # Build lookup: topic_id -> path
    topic_path_map = {n["id"]: n["path"] for n in curriculum_nodes}

    mappings = []
    for item in raw:
        tid = item.get("topic_id")
        mappings.append({
            "chunk_id": item["chunk_id"],
            "topic_id": tid,
            "topic_path": topic_path_map.get(tid) if tid else None,
        })

    return mappings, usage
