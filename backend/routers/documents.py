import os
import uuid
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import Document, Chunk, Curriculum
from backend.config import DATA_DIR, ANTHROPIC_API_KEY
from backend.services.chunker import parse_and_chunk_docx
import anthropic

router = APIRouter()
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")


class DocumentPatch(BaseModel):
    curriculum_id: Optional[int] = None


def doc_to_dict(doc: Document, include_chunks: bool = False) -> dict:
    d = {
        "id": doc.id,
        "original_name": doc.original_name,
        "filename": doc.filename,
        "curriculum_id": doc.curriculum_id,
        "topic_path": doc.topic_path,
        "uploaded_at": doc.uploaded_at.isoformat() if doc.uploaded_at else None,
        "chunk_count": doc.chunk_count,
    }
    if include_chunks:
        d["chunks"] = [
            {
                "id": c.id,
                "chunk_index": c.chunk_index,
                "heading": c.heading,
                "content_type": c.content_type,
                "source_html": c.source_html,
                "card_count": c.card_count,
            }
            for c in doc.chunks
        ]
    return d


def _suggest_topic(filename: str, db: Session) -> Optional[int]:
    """Simple filename-based topic suggestion: match against curriculum node names."""
    nodes = db.query(Curriculum).all()
    fname_lower = filename.lower()
    best, best_score = None, 0
    for node in nodes:
        score = sum(1 for word in node.name.lower().split() if word in fname_lower)
        if score > best_score:
            best_score, best = score, node
    return best.id if best and best_score > 0 else None


@router.get("")
def list_documents(db: Session = Depends(get_db)):
    return [doc_to_dict(d) for d in db.query(Document).all()]


@router.get("/{doc_id}")
def get_document(doc_id: int, db: Session = Depends(get_db)):
    doc = db.get(Document, doc_id)
    if not doc:
        raise HTTPException(404)
    return doc_to_dict(doc, include_chunks=True)


@router.post("/upload", status_code=201)
async def upload_document(file: UploadFile = File(...), db: Session = Depends(get_db)):
    if not file.filename.endswith(".docx"):
        raise HTTPException(422, "Only .docx files supported")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    # Prefix with uuid to avoid filename collisions
    stem, ext = os.path.splitext(file.filename)
    unique_filename = f"{stem}_{uuid.uuid4().hex[:8]}{ext}"
    save_path = os.path.join(UPLOAD_DIR, unique_filename)
    with open(save_path, "wb") as f:
        f.write(await file.read())

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    img_dir = os.path.join(DATA_DIR, "chunk_images")
    os.makedirs(img_dir, exist_ok=True)

    try:
        chunks_data = parse_and_chunk_docx(save_path, img_dir, client)
    except Exception as e:
        os.remove(save_path)
        raise HTTPException(500, f"Failed to process document: {e}") from e

    suggested_curriculum_id = _suggest_topic(file.filename, db)
    topic_path = None
    if suggested_curriculum_id:
        node = db.get(Curriculum, suggested_curriculum_id)
        topic_path = node.path if node else None

    doc = Document(
        filename=unique_filename,
        original_name=file.filename,
        curriculum_id=suggested_curriculum_id,
        topic_path=topic_path,
        chunk_count=len(chunks_data),
    )
    db.add(doc)
    db.flush()

    for c in chunks_data:
        chunk = Chunk(
            document_id=doc.id,
            chunk_index=c["chunk_index"],
            heading=c["heading"],
            content_type=c["content_type"],
            source_text=c["source_text"],
            source_html=c["source_html"],
            rule_subset=c.get("rule_subset", []),
        )
        db.add(chunk)

    db.commit()
    db.refresh(doc)
    return {
        **doc_to_dict(doc),
        "suggested_curriculum_id": suggested_curriculum_id,
    }


@router.patch("/{doc_id}")
def patch_document(doc_id: int, body: DocumentPatch, db: Session = Depends(get_db)):
    doc = db.get(Document, doc_id)
    if not doc:
        raise HTTPException(404)
    if body.curriculum_id is not None:
        node = db.get(Curriculum, body.curriculum_id)
        if not node:
            raise HTTPException(404, "Curriculum node not found")
        doc.curriculum_id = body.curriculum_id
        doc.topic_path = node.path
    db.commit()
    db.refresh(doc)
    return doc_to_dict(doc)


@router.delete("/{doc_id}", status_code=204)
def delete_document(doc_id: int, db: Session = Depends(get_db)):
    doc = db.get(Document, doc_id)
    if not doc:
        raise HTTPException(404)
    db.delete(doc)
    db.commit()
