import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from backend.db import Base
from backend import models  # noqa: ensure models registered

@pytest.fixture
def db():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()
    Base.metadata.drop_all(engine)

@pytest.fixture
def client(db):
    """TestClient with DB overridden to use in-memory test DB."""
    from backend.main import app
    from backend.db import get_db
    from fastapi.testclient import TestClient
    def override_db():
        try:
            yield db
        finally:
            pass
    app.dependency_overrides[get_db] = override_db
    yield TestClient(app)
    app.dependency_overrides.clear()

@pytest.fixture
def seeded_card(db):
    """Creates a minimal Document->Chunk->Card chain and returns the card as a dict."""
    from backend.models import Curriculum, Document, Chunk, Card
    curr = Curriculum(name="Root", level=0, path="Root")
    db.add(curr); db.flush()
    doc = Document(filename="test.docx", original_name="test.docx",
                   curriculum_id=curr.id, topic_path="Root")
    db.add(doc); db.flush()
    chunk = Chunk(document_id=doc.id, chunk_index=0, heading="Test",
                  content_type="paragraph", source_text="hello", source_html="<p>hello</p>")
    db.add(chunk); db.flush()
    card = Card(chunk_id=chunk.id, document_id=doc.id, card_number=1,
                front_html="<b>{{c1::AFib}}</b> causes tachycardia.",
                front_text="AFib causes tachycardia.", tags=["Root"])
    db.add(card); db.commit(); db.refresh(card)
    return {"id": card.id, "front_html": card.front_html}
