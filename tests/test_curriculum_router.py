# tests/test_curriculum_router.py


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
