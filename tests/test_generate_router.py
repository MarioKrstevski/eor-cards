# tests/test_generate_router.py


def test_get_models(client):
    r = client.get("/api/generate/models")
    assert r.status_code == 200
    models = r.json()
    assert any(m["id"] == "claude-sonnet-4-6" for m in models)


def test_estimate_document_not_found(client):
    r = client.post("/api/generate/estimate",
                    json={"document_id": 999, "chunk_ids": None,
                          "rule_set_id": 1, "model": "claude-sonnet-4-6"})
    assert r.status_code == 404
