import logging
import os
import traceback
import uuid
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db, SessionLocal
from backend.models import Document, Chunk, Curriculum, AIUsageLog, Card, CardStatus
from backend.config import DATA_DIR, ANTHROPIC_API_KEY, compute_cost, DEFAULT_MODEL, DEFAULT_CHUNKING_MODEL
from backend.services.chunker import parse_and_chunk_docx, parse_and_chunk_html
from backend.services.topic_detector import detect_chunk_topics
import anthropic

logger = logging.getLogger(__name__)

router = APIRouter()
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")


class ConfirmTopicsRequest(BaseModel):
    topics: list[dict]  # [{chunk_id: int, topic_id: int | None}]


class PasteDocumentRequest(BaseModel):
    html: str
    name: str
    chunking_model: str = "claude-haiku-4-5-20251001"


def doc_to_dict(doc: Document, include_chunks: bool = False) -> dict:
    total_cards = sum(c.card_count for c in doc.chunks) if doc.chunks is not None else 0
    unreviewed_cards = sum(
        1 for card in (doc.cards or [])
        if card.status == CardStatus.active and not card.is_reviewed
    )
    d = {
        "id": doc.id,
        "original_name": doc.original_name,
        "filename": doc.filename,
        "uploaded_at": doc.uploaded_at.isoformat() if doc.uploaded_at else None,
        "chunk_count": doc.chunk_count,
        "total_cards": total_cards,
        "unreviewed_cards": unreviewed_cards,
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
                "topic_id": c.topic_id,
                "topic_path": c.topic_path,
                "topic_confirmed": c.topic_confirmed,
            }
            for c in doc.chunks
        ]
    return d


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
async def upload_document(file: UploadFile = File(...), chunking_model: str = "claude-haiku-4-5-20251001", db: Session = Depends(get_db)):
    if not file.filename.endswith(".docx"):
        raise HTTPException(422, "Only .docx files supported")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    stem, ext = os.path.splitext(file.filename)
    unique_filename = f"{stem}_{uuid.uuid4().hex[:8]}{ext}"
    save_path = os.path.join(UPLOAD_DIR, unique_filename)
    with open(save_path, "wb") as f:
        f.write(await file.read())

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    img_dir = os.path.join(DATA_DIR, "chunk_images")
    os.makedirs(img_dir, exist_ok=True)

    try:
        chunks_data, chunking_usage = parse_and_chunk_docx(save_path, img_dir, client, model=chunking_model)
    except Exception as e:
        os.remove(save_path)
        raise HTTPException(500, f"Failed to process document: {e}") from e

    doc = Document(
        filename=unique_filename,
        original_name=file.filename,
        chunk_count=len(chunks_data),
    )
    db.add(doc)
    db.flush()

    # Save chunks
    chunk_objs = []
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
        chunk_objs.append(chunk)
    db.commit()
    for ch in chunk_objs:
        db.refresh(ch)

    # Log chunking usage
    chunking_cost = compute_cost(chunking_model, chunking_usage["input_tokens"], chunking_usage["output_tokens"])
    db.add(AIUsageLog(
        operation="chunking",
        model=chunking_model,
        input_tokens=chunking_usage["input_tokens"],
        output_tokens=chunking_usage["output_tokens"],
        cost_usd=chunking_cost,
        document_id=doc.id,
    ))
    db.commit()

    # Run topic detection
    curriculum_nodes = [{"id": n.id, "path": n.path} for n in db.query(Curriculum).all()]
    chunk_inputs = [{"id": ch.id, "heading": ch.heading, "source_text": ch.source_text} for ch in chunk_objs]
    topic_detection_cost = 0.0
    suggested_topics = {}

    if curriculum_nodes:
        try:
            mappings, td_usage = detect_chunk_topics(client, chunk_inputs, curriculum_nodes, DEFAULT_CHUNKING_MODEL)
            td_cost = compute_cost(DEFAULT_MODEL, td_usage["input_tokens"], td_usage["output_tokens"])
            topic_detection_cost = td_cost
            db.add(AIUsageLog(
                operation="topic_detection",
                model=DEFAULT_MODEL,
                input_tokens=td_usage["input_tokens"],
                output_tokens=td_usage["output_tokens"],
                cost_usd=td_cost,
                document_id=doc.id,
            ))
            db.commit()
            suggested_topics = {m["chunk_id"]: {"topic_id": m["topic_id"], "topic_path": m["topic_path"]} for m in mappings}
        except Exception:
            # topic detection failure is non-fatal
            pass

    # Build response
    chunks_response = []
    for ch in chunk_objs:
        suggestion = suggested_topics.get(ch.id, {})
        chunks_response.append({
            "id": ch.id,
            "chunk_index": ch.chunk_index,
            "heading": ch.heading,
            "content_type": ch.content_type,
            "source_html": ch.source_html,
            "card_count": 0,
            "topic_id": suggestion.get("topic_id"),
            "topic_path": suggestion.get("topic_path"),
            "topic_confirmed": False,
        })

    return {
        "id": doc.id,
        "original_name": doc.original_name,
        "filename": doc.filename,
        "uploaded_at": doc.uploaded_at.isoformat(),
        "chunk_count": doc.chunk_count,
        "chunks": chunks_response,
        "ai_costs": {
            "chunking_usd": chunking_cost,
            "topic_detection_usd": topic_detection_cost,
            "total_usd": round(chunking_cost + topic_detection_cost, 6),
        },
    }


@router.post("/paste", status_code=201)
async def paste_document(body: PasteDocumentRequest, db: Session = Depends(get_db)):
    """Accept clipboard HTML (from Word, Google Docs, etc.), chunk it, and create a document."""
    if not body.html or not body.html.strip():
        raise HTTPException(422, "No HTML content provided")
    if not body.name or not body.name.strip():
        raise HTTPException(422, "Document name is required")

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    try:
        chunks_data, chunking_usage = parse_and_chunk_html(body.html, client, model=body.chunking_model)
    except ValueError as e:
        logger.error("paste_document: parse/chunk ValueError: %s", e)
        raise HTTPException(422, str(e)) from e
    except Exception as e:
        logger.error("paste_document: parse/chunk failed:\n%s", traceback.format_exc())
        raise HTTPException(500, f"Failed to process pasted content: {e}") from e

    try:
        doc = Document(
            filename=f"paste_{uuid.uuid4().hex[:8]}.html",
            original_name=body.name.strip(),
            chunk_count=len(chunks_data),
        )
        db.add(doc)
        db.flush()

        chunk_objs = []
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
            chunk_objs.append(chunk)
        db.commit()
        for ch in chunk_objs:
            db.refresh(ch)

        chunking_model = body.chunking_model
        chunking_cost = compute_cost(chunking_model, chunking_usage["input_tokens"], chunking_usage["output_tokens"])
        db.add(AIUsageLog(
            operation="chunking",
            model=chunking_model,
            input_tokens=chunking_usage["input_tokens"],
            output_tokens=chunking_usage["output_tokens"],
            cost_usd=chunking_cost,
            document_id=doc.id,
        ))
        db.commit()

        curriculum_nodes = [{"id": n.id, "path": n.path} for n in db.query(Curriculum).all()]
        chunk_inputs = [{"id": ch.id, "heading": ch.heading, "source_text": ch.source_text} for ch in chunk_objs]
        topic_detection_cost = 0.0
        suggested_topics = {}

        if curriculum_nodes:
            try:
                mappings, td_usage = detect_chunk_topics(client, chunk_inputs, curriculum_nodes, DEFAULT_CHUNKING_MODEL)
                td_cost = compute_cost(DEFAULT_MODEL, td_usage["input_tokens"], td_usage["output_tokens"])
                topic_detection_cost = td_cost
                db.add(AIUsageLog(
                    operation="topic_detection",
                    model=DEFAULT_MODEL,
                    input_tokens=td_usage["input_tokens"],
                    output_tokens=td_usage["output_tokens"],
                    cost_usd=td_cost,
                    document_id=doc.id,
                ))
                db.commit()
                suggested_topics = {m["chunk_id"]: {"topic_id": m["topic_id"], "topic_path": m["topic_path"]} for m in mappings}
            except Exception:
                logger.warning("paste_document: topic detection failed (non-fatal):\n%s", traceback.format_exc())

        chunks_response = []
        for ch in chunk_objs:
            suggestion = suggested_topics.get(ch.id, {})
            chunks_response.append({
                "id": ch.id,
                "chunk_index": ch.chunk_index,
                "heading": ch.heading,
                "content_type": ch.content_type,
                "source_html": ch.source_html,
                "card_count": 0,
                "topic_id": suggestion.get("topic_id"),
                "topic_path": suggestion.get("topic_path"),
                "topic_confirmed": False,
            })

        return {
            "id": doc.id,
            "original_name": doc.original_name,
            "filename": doc.filename,
            "uploaded_at": doc.uploaded_at.isoformat(),
            "chunk_count": doc.chunk_count,
            "chunks": chunks_response,
            "ai_costs": {
                "chunking_usd": chunking_cost,
                "topic_detection_usd": topic_detection_cost,
                "total_usd": round(chunking_cost + topic_detection_cost, 6),
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("paste_document: DB/response error:\n%s", traceback.format_exc())
        db.rollback()
        raise HTTPException(500, f"Server error saving document: {e}") from e


@router.post("/{doc_id}/confirm-topics", status_code=200)
def confirm_topics(doc_id: int, body: ConfirmTopicsRequest, db: Session = Depends(get_db)):
    """Save confirmed topic assignments for all chunks of a document."""
    doc = db.get(Document, doc_id)
    if not doc:
        raise HTTPException(404)

    topic_map = {n.id: n.path for n in db.query(Curriculum).all()}

    for item in body.topics:
        chunk = db.get(Chunk, item["chunk_id"])
        if not chunk or chunk.document_id != doc_id:
            continue
        tid = item.get("topic_id")
        chunk.topic_id = tid
        chunk.topic_path = topic_map.get(tid) if tid else None
        chunk.topic_confirmed = True

    db.commit()
    return doc_to_dict(doc, include_chunks=True)


@router.delete("/{doc_id}", status_code=204)
def delete_document(doc_id: int, db: Session = Depends(get_db)):
    doc = db.get(Document, doc_id)
    if not doc:
        raise HTTPException(404)
    db.delete(doc)
    db.commit()
