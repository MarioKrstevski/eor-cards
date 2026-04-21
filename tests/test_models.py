from backend.models import RuleSet, Curriculum, Document, Chunk, Card, GenerationJob
from datetime import datetime

def test_ruleset_creation(db):
    rs = RuleSet(name="Default", content="# rules", is_default=True)
    db.add(rs)
    db.commit()
    assert db.query(RuleSet).count() == 1

def test_card_has_updated_at(db):
    curr = Curriculum(name="Root", level=0, path="Root")
    db.add(curr); db.flush()
    doc = Document(filename="test.docx", original_name="test.docx",
                   curriculum_id=curr.id, topic_path="Root")
    db.add(doc); db.flush()
    chunk = Chunk(document_id=doc.id, chunk_index=0, heading="Test",
                  content_type="paragraph", source_text="hello", source_html="<p>hello</p>")
    db.add(chunk); db.flush()
    card = Card(chunk_id=chunk.id, document_id=doc.id, card_number=1,
                front_html="<b>{{c1::test}}</b>", front_text="test", tags=["Root"])
    db.add(card); db.commit()
    assert card.updated_at is not None
