# tests/test_chunker.py
import pytest
from unittest.mock import patch, MagicMock
from backend.services.chunker import strip_images_for_storage, assemble_chunks

def test_assemble_chunks_basic():
    elements = [
        {"type": "heading", "text": "Intro", "html": "<b>Intro</b>", "level": 2,
         "bold_terms": ["Intro"], "images": [], "is_empty": False},
        {"type": "paragraph", "text": "Some content.", "html": "<p>Some content.</p>",
         "level": 0, "bold_terms": [], "images": [], "is_empty": False},
    ]
    claude_chunks = [
        {"chunk_index": 0, "element_range": [0, 1], "heading": "Intro",
         "content_type": "mixed-paragraph-bullets",
         "rule_subset": ["cloze_boundaries"], "rationale": "heading + content"}
    ]
    result = assemble_chunks(elements, claude_chunks)
    assert len(result) == 1
    assert result[0]["heading"] == "Intro"
    assert "Some content." in result[0]["source_text"]

def test_strip_images_for_storage():
    chunks = [{"source_html": '<img src="data:image/png;base64,ABC123" /><p>text</p>',
               "images": []}]
    result = strip_images_for_storage(chunks)
    assert "base64" not in result[0]["source_html"]
    assert "<p>text</p>" in result[0]["source_html"]
