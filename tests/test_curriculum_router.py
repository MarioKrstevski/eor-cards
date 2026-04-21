# tests/test_curriculum_router.py
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from backend.db import Base, get_db
from backend.main import app
from backend import models


@pytest.fixture
def client():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)

    def override_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_get_curriculum_empty(client):
    r = client.get("/api/curriculum")
    assert r.status_code == 200
    assert r.json() == []


def test_create_curriculum_node(client):
    r = client.post("/api/curriculum", json={"name": "Emergency Medicine", "parent_id": None})
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == "Emergency Medicine"
    assert data["level"] == 0
    assert data["path"] == "Emergency Medicine"


def test_create_child_node(client):
    parent = client.post("/api/curriculum", json={"name": "Root", "parent_id": None}).json()
    child = client.post("/api/curriculum", json={"name": "Cardiology", "parent_id": parent["id"]}).json()
    assert child["level"] == 1
    assert child["path"] == "Root > Cardiology"
