# tests/test_documents_router.py

def test_list_documents_empty(client):
    r = client.get("/api/documents")
    assert r.status_code == 200
    assert r.json() == []


def test_upload_invalid_file(client):
    r = client.post("/api/documents/upload",
                    files={"file": ("test.txt", b"hello", "text/plain")})
    assert r.status_code == 422


def test_patch_document_curriculum(client, db):
    from backend.models import Document, Curriculum
    curr = Curriculum(name="Root", level=0, path="Root")
    db.add(curr)
    db.flush()
    doc = Document(filename="test.docx", original_name="test.docx")
    db.add(doc)
    db.commit()
    r = client.patch(f"/api/documents/{doc.id}", json={"curriculum_id": curr.id})
    assert r.status_code == 200
    assert r.json()["topic_path"] == "Root"
