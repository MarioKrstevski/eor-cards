import logging
import os
import threading
import time
import traceback
import uuid
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db, SessionLocal
from backend.models import Document, Chunk, ChunkImage, Curriculum, AIUsageLog, Card, CardStatus, GenerationJob, JobStatus, RuleSet, utcnow
from backend.config import DATA_DIR, ANTHROPIC_API_KEY, compute_cost, DEFAULT_MODEL
from backend.services.chunker import parse_and_chunk_docx, parse_and_chunk_html
from backend.services.topic_detector import detect_chunk_topics
from backend.services.generator import generate_cards_for_chunk
from backend.services.supplemental_generator import generate_supplemental_for_group
from concurrent.futures import ThreadPoolExecutor, as_completed
import anthropic

logger = logging.getLogger(__name__)

router = APIRouter()
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")


def _get_curriculum_leaves(db: Session) -> list[dict]:
    """Fetch curriculum leaf nodes (nodes with no children) sorted by tree position.

    Returns list of dicts: [{id, name, path, sort_order}, ...]
    """
    all_nodes = db.query(Curriculum).all()
    if not all_nodes:
        return []

    # Find which nodes are parents
    parent_ids = {n.parent_id for n in all_nodes if n.parent_id is not None}

    # Leaves are nodes that are NOT parents of any other node
    leaves = [n for n in all_nodes if n.id not in parent_ids]

    if not leaves:
        return []

    # Build a sort key that respects tree position:
    # We walk the tree in DFS order using sort_order at each level
    by_id = {n.id: n for n in all_nodes}

    def tree_sort_key(node: Curriculum) -> list[int]:
        """Build a list of sort_orders from root to this node for proper DFS ordering."""
        path = []
        current = node
        while current is not None:
            path.append(current.sort_order)
            current = by_id.get(current.parent_id)
        path.reverse()
        return path

    leaves.sort(key=tree_sort_key)

    return [
        {"id": n.id, "name": n.name, "path": n.path, "sort_order": n.sort_order}
        for n in leaves
    ]


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
def list_documents(topic_id: Optional[int] = None, db: Session = Depends(get_db)):
    if topic_id is not None:
        # Collect subtree of curriculum IDs
        def subtree_ids(nid: int) -> set:
            ids = {nid}
            for child in db.query(Curriculum).filter_by(parent_id=nid).all():
                ids |= subtree_ids(child.id)
            return ids
        ids = subtree_ids(topic_id)
        doc_id_rows = db.query(Chunk.document_id).filter(Chunk.topic_id.in_(ids)).distinct().all()
        doc_id_set = {r[0] for r in doc_id_rows}
        docs = db.query(Document).filter(Document.id.in_(doc_id_set)).all()
    else:
        docs = db.query(Document).all()
    return [doc_to_dict(d) for d in docs]


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

    # Fetch curriculum leaves for topic-first slicing
    curriculum_leaves = _get_curriculum_leaves(db)

    try:
        chunks_data, chunking_usage = parse_and_chunk_docx(
            save_path, img_dir, client, model=chunking_model,
            curriculum_leaves=curriculum_leaves if curriculum_leaves else None,
        )
    except Exception as e:
        os.remove(save_path)
        raise HTTPException(500, f"Failed to process document: {e}") from e

    # Did we use topic-first slicing? Chunks will have topic_id set.
    used_topic_slicing = bool(curriculum_leaves) and any(c.get("topic_id") is not None for c in chunks_data)

    doc = Document(
        filename=unique_filename,
        original_name=file.filename,
        chunk_count=len(chunks_data),
    )
    db.add(doc)
    db.flush()

    # Save chunks — include topic assignment if topic-first slicing was used
    chunk_objs = []
    for c in chunks_data:
        chunk = Chunk(
            document_id=doc.id,
            chunk_index=c["chunk_index"],
            heading=c["heading"],
            content_type=c["content_type"],
            source_text=c["source_text"],
            source_html=c["source_html"],
            ref_img=c.get("ref_img"),
            rule_subset=c.get("rule_subset", []),
            topic_id=c.get("topic_id") if used_topic_slicing else None,
            topic_path=c.get("topic_path") if used_topic_slicing else None,
            topic_confirmed=False,
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

    # Topic detection — skip if topic-first slicing already assigned topics
    topic_detection_cost = 0.0
    suggested_topics = {}

    if used_topic_slicing:
        # Topics already assigned during slicing — build suggestions from chunk data
        for ch, c in zip(chunk_objs, chunks_data):
            suggested_topics[ch.id] = {
                "topic_id": c.get("topic_id"),
                "topic_path": c.get("topic_path"),
                "needs_review": c.get("needs_review", False),
            }
    else:
        # Fallback: run separate topic detection
        curriculum_nodes = [{"id": n.id, "path": n.path} for n in db.query(Curriculum).all()]
        chunk_inputs = [{"id": ch.id, "heading": ch.heading, "source_text": ch.source_text} for ch in chunk_objs]

        if curriculum_nodes:
            try:
                mappings, td_usage = detect_chunk_topics(client, chunk_inputs, curriculum_nodes, chunking_model)
                td_cost = compute_cost(chunking_model, td_usage["input_tokens"], td_usage["output_tokens"])
                topic_detection_cost = td_cost
                db.add(AIUsageLog(
                    operation="topic_detection",
                    model=chunking_model,
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
            "needs_review": suggestion.get("needs_review", False),
        })

    return {
        "id": doc.id,
        "original_name": doc.original_name,
        "filename": doc.filename,
        "uploaded_at": doc.uploaded_at.isoformat(),
        "chunk_count": doc.chunk_count,
        "chunks": chunks_response,
        "slicing_method": "topic_first" if used_topic_slicing else "semantic",
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

    # Fetch curriculum leaves for topic-first slicing
    curriculum_leaves = _get_curriculum_leaves(db)

    try:
        chunks_data, chunking_usage = parse_and_chunk_html(
            body.html, client, model=body.chunking_model,
            curriculum_leaves=curriculum_leaves if curriculum_leaves else None,
        )
    except ValueError as e:
        logger.error("paste_document: parse/chunk ValueError: %s", e)
        raise HTTPException(422, str(e)) from e
    except Exception as e:
        logger.error("paste_document: parse/chunk failed:\n%s", traceback.format_exc())
        raise HTTPException(500, f"Failed to process pasted content: {e}") from e

    # Did we use topic-first slicing?
    used_topic_slicing = bool(curriculum_leaves) and any(c.get("topic_id") is not None for c in chunks_data)

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
                ref_img=c.get("ref_img"),
                rule_subset=c.get("rule_subset", []),
                topic_id=c.get("topic_id") if used_topic_slicing else None,
                topic_path=c.get("topic_path") if used_topic_slicing else None,
                topic_confirmed=False,
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

        # Topic detection — skip if topic-first slicing already assigned topics
        topic_detection_cost = 0.0
        suggested_topics = {}

        if used_topic_slicing:
            for ch, c in zip(chunk_objs, chunks_data):
                suggested_topics[ch.id] = {
                    "topic_id": c.get("topic_id"),
                    "topic_path": c.get("topic_path"),
                    "needs_review": c.get("needs_review", False),
                }
        else:
            curriculum_nodes = [{"id": n.id, "path": n.path} for n in db.query(Curriculum).all()]
            chunk_inputs = [{"id": ch.id, "heading": ch.heading, "source_text": ch.source_text} for ch in chunk_objs]

            if curriculum_nodes:
                try:
                    mappings, td_usage = detect_chunk_topics(client, chunk_inputs, curriculum_nodes, chunking_model)
                    td_cost = compute_cost(chunking_model, td_usage["input_tokens"], td_usage["output_tokens"])
                    topic_detection_cost = td_cost
                    db.add(AIUsageLog(
                        operation="topic_detection",
                        model=chunking_model,
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
                "needs_review": suggestion.get("needs_review", False),
            })

        return {
            "id": doc.id,
            "original_name": doc.original_name,
            "filename": doc.filename,
            "uploaded_at": doc.uploaded_at.isoformat(),
            "chunk_count": doc.chunk_count,
            "chunks": chunks_response,
            "slicing_method": "topic_first" if used_topic_slicing else "semantic",
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


class RenameDocumentRequest(BaseModel):
    name: str

@router.patch("/{doc_id}/rename", status_code=200)
def rename_document(doc_id: int, body: RenameDocumentRequest, db: Session = Depends(get_db)):
    doc = db.get(Document, doc_id)
    if not doc:
        raise HTTPException(404)
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Name cannot be empty")
    doc.original_name = name
    db.commit()
    return {"id": doc.id, "original_name": doc.original_name}

@router.delete("/{doc_id}", status_code=204)
def delete_document(doc_id: int, db: Session = Depends(get_db)):
    doc = db.get(Document, doc_id)
    if not doc:
        raise HTTPException(404)
    # Clean up uploaded file from disk
    file_path = os.path.join(UPLOAD_DIR, doc.filename)
    try:
        if os.path.exists(file_path):
            os.remove(file_path)
    except OSError:
        pass
    # Fail any active jobs for this document before deleting
    db.query(GenerationJob).filter(
        GenerationJob.document_id == doc_id,
        GenerationJob.status.in_([JobStatus.pending, JobStatus.running])
    ).update({"status": JobStatus.failed, "error_message": "Document deleted"}, synchronize_session=False)
    # Nullify document_id on all jobs so CASCADE delete doesn't remove job records
    db.query(GenerationJob).filter(GenerationJob.document_id == doc_id).update(
        {"document_id": None}, synchronize_session=False
    )
    # Delete cards, chunk images, and chunks to avoid timeout on large docs
    db.query(Card).filter(Card.document_id == doc_id).delete(synchronize_session=False)
    chunk_ids = [r[0] for r in db.query(Chunk.id).filter(Chunk.document_id == doc_id).all()]
    if chunk_ids:
        db.query(ChunkImage).filter(ChunkImage.chunk_id.in_(chunk_ids)).delete(synchronize_session=False)
    db.query(Chunk).filter(Chunk.document_id == doc_id).delete(synchronize_session=False)
    db.delete(doc)
    db.commit()


# ── Full-Auto Pipeline ──────────────────────────────────────────────────────────


class PasteAutoRequest(BaseModel):
    html: str
    name: str
    chunking_model: str = "claude-haiku-4-5-20251001"
    model: str = DEFAULT_MODEL
    rule_set_id: int
    supplemental_rule_set_id: Optional[int] = None


class PasteSimpleRequest(BaseModel):
    html: str
    name: str
    model: str = DEFAULT_MODEL
    rule_set_id: int
    supplemental_rule_set_id: Optional[int] = None


@router.post("/upload-auto", status_code=201)
async def upload_document_auto(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    chunking_model: str = Form("claude-haiku-4-5-20251001"),
    model: str = Form(DEFAULT_MODEL),
    rule_set_id: int = Form(...),
    supplemental_rule_set_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
):
    """Upload a .docx and run the full-auto pipeline: chunk -> topics -> cards -> vignettes."""
    if not file.filename.endswith(".docx"):
        raise HTTPException(422, "Only .docx files supported")

    # Validate rule sets exist
    rs = db.get(RuleSet, rule_set_id)
    if not rs:
        raise HTTPException(404, "Card rule set not found")
    supp_rs = None
    if supplemental_rule_set_id:
        supp_rs = db.get(RuleSet, supplemental_rule_set_id)
        if not supp_rs:
            raise HTTPException(404, "Supplemental rule set not found")

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    stem, ext = os.path.splitext(file.filename)
    unique_filename = f"{stem}_{uuid.uuid4().hex[:8]}{ext}"
    save_path = os.path.join(UPLOAD_DIR, unique_filename)
    with open(save_path, "wb") as f:
        f.write(await file.read())

    # Create document record immediately (chunk_count=0 until pipeline fills it)
    doc = Document(
        filename=unique_filename,
        original_name=file.filename,
        chunk_count=0,
    )
    db.add(doc)
    db.flush()

    # Create a tracking job
    job = GenerationJob(
        document_id=doc.id,
        job_type="full_auto",
        scope="all",
        rule_set_id=rule_set_id,
        model=model,
        status=JobStatus.pending,
        total_chunks=0,
        processed_chunks=0,
        total_cards=0,
        pipeline_step="chunking",
    )
    db.add(job)
    db.commit()
    db.refresh(doc)
    db.refresh(job)

    background_tasks.add_task(
        _run_full_auto_pipeline,
        doc.id,
        job.id,
        save_path,
        None,  # html (upload uses file path)
        chunking_model,
        model,
        rule_set_id,
        supplemental_rule_set_id,
        is_docx=True,
    )

    return {"document_id": doc.id, "job_id": job.id}


@router.post("/paste-auto", status_code=201)
async def paste_document_auto(
    body: PasteAutoRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Accept clipboard HTML and run the full-auto pipeline."""
    if not body.html or not body.html.strip():
        raise HTTPException(422, "No HTML content provided")
    if not body.name or not body.name.strip():
        raise HTTPException(422, "Document name is required")

    rs = db.get(RuleSet, body.rule_set_id)
    if not rs:
        raise HTTPException(404, "Card rule set not found")
    if body.supplemental_rule_set_id:
        supp_rs = db.get(RuleSet, body.supplemental_rule_set_id)
        if not supp_rs:
            raise HTTPException(404, "Supplemental rule set not found")

    doc = Document(
        filename=f"paste_{uuid.uuid4().hex[:8]}.html",
        original_name=body.name.strip(),
        chunk_count=0,
    )
    db.add(doc)
    db.flush()

    job = GenerationJob(
        document_id=doc.id,
        job_type="full_auto",
        scope="all",
        rule_set_id=body.rule_set_id,
        model=body.model,
        status=JobStatus.pending,
        total_chunks=0,
        processed_chunks=0,
        total_cards=0,
        pipeline_step="chunking",
    )
    db.add(job)
    db.commit()
    db.refresh(doc)
    db.refresh(job)

    background_tasks.add_task(
        _run_full_auto_pipeline,
        doc.id,
        job.id,
        None,  # file_path (paste uses html)
        body.html,
        body.chunking_model,
        body.model,
        body.rule_set_id,
        body.supplemental_rule_set_id,
        is_docx=False,
    )

    return {"document_id": doc.id, "job_id": job.id}


def _fail_auto_job(db, job_id: int, message: str):
    try:
        job = db.get(GenerationJob, job_id)
        if job:
            job.status = JobStatus.failed
            job.error_message = message
            job.finished_at = utcnow()
            db.commit()
    except Exception:
        logger.exception("Failed to write error status for full-auto job %d", job_id)


def _run_full_auto_pipeline(
    doc_id: int,
    job_id: int,
    file_path: Optional[str],
    html: Optional[str],
    chunking_model: str,
    generation_model: str,
    rule_set_id: int,
    supplemental_rule_set_id: Optional[int],
    is_docx: bool,
):
    """Background task: full-auto pipeline — chunk, assign topics, generate cards, generate supplementals."""
    db = SessionLocal()
    try:
        job = db.get(GenerationJob, job_id)
        job.status = JobStatus.running
        job.started_at = utcnow()
        job.pipeline_step = "chunking"
        db.commit()

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        img_dir = os.path.join(DATA_DIR, "chunk_images")
        os.makedirs(img_dir, exist_ok=True)

        # ── Step 1: Parse & chunk ─────────────────────────────────────────────
        if is_docx:
            chunks_data, chunking_usage = parse_and_chunk_docx(file_path, img_dir, client, model=chunking_model)
        else:
            chunks_data, chunking_usage = parse_and_chunk_html(html, client, model=chunking_model)

        doc = db.get(Document, doc_id)
        doc.chunk_count = len(chunks_data)

        chunk_objs = []
        for c in chunks_data:
            chunk = Chunk(
                document_id=doc_id,
                chunk_index=c["chunk_index"],
                heading=c["heading"],
                content_type=c["content_type"],
                source_text=c["source_text"],
                source_html=c["source_html"],
                ref_img=c.get("ref_img"),
                rule_subset=c.get("rule_subset", []),
            )
            db.add(chunk)
            chunk_objs.append(chunk)
        db.commit()
        for ch in chunk_objs:
            db.refresh(ch)

        # Save chunk images to gallery
        auto_chunk_first_image = {}
        for ch in chunk_objs:
            if ch.ref_img:
                img = ChunkImage(chunk_id=ch.id, data_uri=ch.ref_img, position=0)
                db.add(img)
                db.flush()
                auto_chunk_first_image[ch.id] = img.id
        db.commit()

        # Log chunking usage
        chunking_cost = compute_cost(chunking_model, chunking_usage["input_tokens"], chunking_usage["output_tokens"])
        db.add(AIUsageLog(
            operation="chunking",
            model=chunking_model,
            input_tokens=chunking_usage["input_tokens"],
            output_tokens=chunking_usage["output_tokens"],
            cost_usd=chunking_cost,
            document_id=doc_id,
        ))
        db.commit()

        # ── Step 2: Auto-assign topics ────────────────────────────────────────
        job.pipeline_step = "topics"
        job.total_chunks = len(chunk_objs)
        db.commit()

        curriculum_nodes = [{"id": n.id, "path": n.path} for n in db.query(Curriculum).all()]
        chunk_inputs = [{"id": ch.id, "heading": ch.heading, "source_text": ch.source_text} for ch in chunk_objs]

        if curriculum_nodes:
            try:
                mappings, td_usage = detect_chunk_topics(client, chunk_inputs, curriculum_nodes, chunking_model)
                td_cost = compute_cost(chunking_model, td_usage["input_tokens"], td_usage["output_tokens"])
                db.add(AIUsageLog(
                    operation="topic_detection",
                    model=chunking_model,
                    input_tokens=td_usage["input_tokens"],
                    output_tokens=td_usage["output_tokens"],
                    cost_usd=td_cost,
                    document_id=doc_id,
                ))
                # Auto-accept topics: set topic_confirmed=True for matches, False for null (low confidence)
                for m in mappings:
                    chunk = db.get(Chunk, m["chunk_id"])
                    if chunk:
                        chunk.topic_id = m["topic_id"]
                        chunk.topic_path = m["topic_path"]
                        # High confidence = topic was matched; low confidence = None
                        chunk.topic_confirmed = m["topic_id"] is not None
                db.commit()
            except Exception:
                logger.warning("full_auto: topic detection failed (non-fatal):\n%s", traceback.format_exc())

        # Refresh chunk objects to get updated topic data
        for ch in chunk_objs:
            db.refresh(ch)

        # ── Step 3: Generate cards ────────────────────────────────────────────
        job.pipeline_step = "cards"
        db.commit()

        rs = db.get(RuleSet, rule_set_id)
        rules_text = rs.content

        # Pre-load chunk data for thread safety (same pattern as generate.py _run_generation)
        chunks_by_id = {}
        for ch in chunk_objs:
            chunks_by_id[ch.id] = {
                "id": ch.id,
                "source_text": ch.source_text,
                "heading": ch.heading,
                "topic_path": ch.topic_path,
                "topic_id": ch.topic_id,
                "ref_img": ch.ref_img,
            }

        # Group by topic for sibling context
        chunks_by_topic = {}
        for ch_data in chunks_by_id.values():
            tid = ch_data.get("topic_id")
            if tid:
                chunks_by_topic.setdefault(tid, []).append(ch_data)

        note_id_base = int(time.time() * 1000)
        note_id_counter = {"value": 0}
        note_id_lock = threading.Lock()

        def next_note_id():
            with note_id_lock:
                nid = note_id_base + note_id_counter["value"]
                note_id_counter["value"] += 1
                return nid

        total_cards = 0
        total_input_tokens = 0
        total_output_tokens = 0

        def process_chunk(chunk_data):
            tid = chunk_data.get("topic_id")
            siblings = [s for s in chunks_by_topic.get(tid, []) if s["id"] != chunk_data["id"]] if tid else []
            for attempt in range(4):
                try:
                    cards_data, needs_review, usage = generate_cards_for_chunk(
                        client,
                        {"source_text": chunk_data["source_text"], "heading": chunk_data["heading"],
                         "topic_path": chunk_data["topic_path"]},
                        rules_text,
                        generation_model,
                        sibling_texts=siblings,
                    )
                    return chunk_data, cards_data, needs_review, usage
                except anthropic.RateLimitError:
                    if attempt == 3:
                        raise
                    wait = 20 * (2 ** attempt)
                    logger.warning("Rate limit on chunk %d, retrying in %ds (attempt %d/4)", chunk_data["id"], wait, attempt + 1)
                    time.sleep(wait)

        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {executor.submit(process_chunk, c): c for c in chunks_by_id.values()}
            for future in as_completed(futures):
                chunk_data, cards_data, needs_review, usage = future.result()
                tags = chunk_data["topic_path"].split(" > ") if chunk_data["topic_path"] else []
                gallery_img_id = auto_chunk_first_image.get(chunk_data["id"])
                for card_data in cards_data:
                    card = Card(
                        chunk_id=chunk_data["id"],
                        document_id=doc_id,
                        card_number=card_data["card_number"],
                        front_html=card_data["front_html"],
                        front_text=card_data["front_text"],
                        extra=card_data.get("extra"),
                        source_ref=card_data.get("source_ref"),
                        tags=tags,
                        needs_review=needs_review,
                        ref_img_id=gallery_img_id,
                        ref_img=chunk_data.get("ref_img") if not gallery_img_id else None,
                        note_id=next_note_id(),
                    )
                    db.add(card)
                db.query(Chunk).filter(Chunk.id == chunk_data["id"]).update({"card_count": len(cards_data)})
                total_cards += len(cards_data)
                total_input_tokens += usage["input_tokens"]
                total_output_tokens += usage["output_tokens"]
                job.processed_chunks += 1
                db.commit()

        db.add(AIUsageLog(
            operation="card_generation",
            model=generation_model,
            input_tokens=total_input_tokens,
            output_tokens=total_output_tokens,
            cost_usd=compute_cost(generation_model, total_input_tokens, total_output_tokens),
            document_id=doc_id,
            job_id=job_id,
        ))
        job.total_cards = total_cards
        db.commit()

        # ── Step 4: Generate vignettes & teaching cases ───────────────────────
        if supplemental_rule_set_id:
            job.pipeline_step = "vignettes"
            db.commit()

            supp_rs = db.get(RuleSet, supplemental_rule_set_id)
            supp_rules_text = supp_rs.content

            all_cards = db.query(Card).filter(Card.document_id == doc_id, Card.status == CardStatus.active).all()

            # Group cards by leaf topic (condition)
            condition_groups = {}
            for c in all_cards:
                leaf = (c.tags or [])[-1] if c.tags else "Unassigned"
                condition_groups.setdefault(leaf, []).append({
                    "id": c.id,
                    "card_number": c.card_number,
                    "front_text": c.front_text,
                })

            supp_input = 0
            supp_output = 0

            def generate_supplemental_with_retry(condition, group_cards):
                for attempt in range(4):
                    try:
                        return generate_supplemental_for_group(client, condition, group_cards, supp_rules_text, generation_model)
                    except anthropic.RateLimitError:
                        if attempt == 3:
                            raise
                        wait = 20 * (2 ** attempt)
                        logger.warning("Rate limit on supplemental '%s', retrying in %ds (attempt %d/4)", condition, wait, attempt + 1)
                        time.sleep(wait)

            with ThreadPoolExecutor(max_workers=3) as executor:
                futures = {
                    executor.submit(generate_supplemental_with_retry, cond, cards_list): (cond, cards_list)
                    for cond, cards_list in condition_groups.items()
                }
                for future in as_completed(futures):
                    cond, cards_list = futures[future]
                    try:
                        vignette, teaching_case, usage = future.result()
                        card_ids_in_group = [c["id"] for c in cards_list]
                        db.query(Card).filter(Card.id.in_(card_ids_in_group)).update(
                            {"vignette": vignette, "teaching_case": teaching_case},
                            synchronize_session="fetch",
                        )
                        supp_input += usage.get("input_tokens", 0)
                        supp_output += usage.get("output_tokens", 0)
                    except Exception:
                        logger.exception("full_auto: supplemental generation failed for condition '%s'", cond)
                    db.commit()

            if supp_input > 0 or supp_output > 0:
                db.add(AIUsageLog(
                    operation="supplemental_generation",
                    model=generation_model,
                    input_tokens=supp_input,
                    output_tokens=supp_output,
                    cost_usd=compute_cost(generation_model, supp_input, supp_output),
                    document_id=doc_id,
                    job_id=job_id,
                ))
                db.commit()

        # ── Step 5: Done ──────────────────────────────────────────────────────
        job.pipeline_step = "done"
        job.status = JobStatus.done
        job.actual_input_tokens = total_input_tokens
        job.actual_output_tokens = total_output_tokens
        job.finished_at = utcnow()
        db.commit()

    except anthropic.AuthenticationError:
        _fail_auto_job(db, job_id, "Anthropic API key is invalid or missing. Check your ANTHROPIC_API_KEY.")
    except anthropic.PermissionDeniedError as e:
        msg = str(e).lower()
        if "credit" in msg or "billing" in msg or "balance" in msg or "quota" in msg:
            _fail_auto_job(db, job_id, "Your Anthropic account is out of credits. Please top up your balance and try again.")
        else:
            _fail_auto_job(db, job_id, f"Anthropic permission error: {e}")
    except anthropic.RateLimitError:
        _fail_auto_job(db, job_id, "Anthropic rate limit reached. Please wait a moment and try again.")
    except anthropic.APIStatusError as e:
        msg = str(e).lower()
        if "credit" in msg or "billing" in msg or "balance" in msg:
            _fail_auto_job(db, job_id, "Your Anthropic account is out of credits. Please top up your balance and try again.")
        else:
            _fail_auto_job(db, job_id, f"Anthropic API error ({e.status_code}): {e.message}")
    except Exception as e:
        logger.exception("_run_full_auto_pipeline failed")
        _fail_auto_job(db, job_id, str(e))
    finally:
        db.close()


# ── Simple Batch Pipeline ──────────────────────────────────────────────────────


@router.post("/upload-simple", status_code=201)
async def upload_document_simple(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    model: str = Form(DEFAULT_MODEL),
    rule_set_id: int = Form(...),
    supplemental_rule_set_id: Optional[str] = Form(None),
    db: Session = Depends(get_db),
):
    """Upload .docx → deterministic split → per-chunk parallel generation."""
    try:
        if not file.filename.endswith(".docx"):
            raise HTTPException(422, "Only .docx files supported")

        rs = db.get(RuleSet, rule_set_id)
        if not rs:
            raise HTTPException(404, f"Rule set {rule_set_id} not found")

        os.makedirs(UPLOAD_DIR, exist_ok=True)
        stem, ext = os.path.splitext(file.filename)
        unique_filename = f"{stem}_{uuid.uuid4().hex[:8]}{ext}"
        save_path = os.path.join(UPLOAD_DIR, unique_filename)
        with open(save_path, "wb") as f:
            f.write(await file.read())

        doc = Document(
            filename=unique_filename,
            original_name=file.filename,
            chunk_count=0,
        )
        db.add(doc)
        db.flush()

        job = GenerationJob(
            document_id=doc.id,
            job_type="simple_batch",
            scope="all",
            rule_set_id=rule_set_id,
            model=model,
            status=JobStatus.pending,
            total_chunks=0,
            processed_chunks=0,
            total_cards=0,
            pipeline_step="parsing",
        )
        db.add(job)
        db.commit()
        db.refresh(doc)
        db.refresh(job)

        # Parse supplemental_rule_set_id from string (FormData sends strings)
        supp_id = int(supplemental_rule_set_id) if supplemental_rule_set_id else None

        background_tasks.add_task(
            _run_simple_pipeline,
            doc.id,
            job.id,
            save_path,
            None,
            model,
            rule_set_id,
            supp_id,
            True,
        )

        return {"document_id": doc.id, "job_id": job.id}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("upload-simple failed")
        raise HTTPException(500, f"Upload failed: {type(e).__name__}: {e}")


@router.post("/paste-simple", status_code=201)
async def paste_document_simple(
    body: PasteSimpleRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Paste HTML → deterministic split → per-chunk parallel generation."""
    try:
        if not body.html or not body.html.strip():
            raise HTTPException(422, "No HTML content provided")
        if not body.name or not body.name.strip():
            raise HTTPException(422, "Document name is required")

        rs = db.get(RuleSet, body.rule_set_id)
        if not rs:
            raise HTTPException(404, f"Rule set {body.rule_set_id} not found")

        doc = Document(
            filename=f"paste_{uuid.uuid4().hex[:8]}.html",
            original_name=body.name.strip(),
            chunk_count=0,
        )
        db.add(doc)
        db.flush()

        job = GenerationJob(
            document_id=doc.id,
            job_type="simple_batch",
            scope="all",
            rule_set_id=body.rule_set_id,
            model=body.model,
            status=JobStatus.pending,
            total_chunks=0,
            processed_chunks=0,
            total_cards=0,
            pipeline_step="parsing",
        )
        db.add(job)
        db.commit()
        db.refresh(doc)
        db.refresh(job)

        background_tasks.add_task(
            _run_simple_pipeline,
            doc.id,
            job.id,
            None,
            body.html,
            body.model,
            body.rule_set_id,
            body.supplemental_rule_set_id,
            False,
        )

        return {"document_id": doc.id, "job_id": job.id}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("paste-simple failed")
        raise HTTPException(500, f"Paste failed: {type(e).__name__}: {e}")


def _run_simple_pipeline(
    doc_id: int,
    job_id: int,
    file_path: Optional[str],
    html: Optional[str],
    model: str,
    rule_set_id: int,
    supplemental_rule_set_id: Optional[int],
    is_docx: bool,
):
    """Background task: deterministic parse → per-chunk parallel generation → supplementals."""
    from backend.services.batch_generator import build_chunks_from_sections, build_sections_from_elements
    from backend.services.chunker import parse_docx, parse_html_to_elements
    from backend.services.generator import generate_cards_for_chunk, number_paragraphs

    db = SessionLocal()
    try:
        job = db.get(GenerationJob, job_id)
        job.status = JobStatus.running
        job.started_at = utcnow()
        job.pipeline_step = "parsing"
        db.commit()

        # ── Step 1: Parse document deterministically (no AI) ─────────────────
        if is_docx:
            img_dir = os.path.join(DATA_DIR, "chunk_images")
            os.makedirs(img_dir, exist_ok=True)
            elements, images = parse_docx(file_path, img_dir)
            # Delete uploaded file — no longer needed after parsing
            try:
                os.remove(file_path)
            except OSError:
                pass
        else:
            elements, images = parse_html_to_elements(html)

        if not elements:
            _fail_auto_job(db, job_id, "No content could be extracted from the document")
            return

        # ── Step 2: Build chunks deterministically (no AI) ───────────────────
        job.pipeline_step = "splitting"
        db.commit()

        sections = build_sections_from_elements(elements)
        chunk_dicts = build_chunks_from_sections(sections, elements)

        doc = db.get(Document, doc_id)
        doc.chunk_count = len(chunk_dicts)

        chunk_objs = []
        for c in chunk_dicts:
            chunk = Chunk(
                document_id=doc_id,
                chunk_index=c["chunk_index"],
                heading=c["heading"],
                content_type=c["content_type"],
                source_text=c["source_text"],
                source_html=c["source_html"],
                ref_img=c.get("ref_img"),
                rule_subset=c.get("rule_subset", []),
            )
            db.add(chunk)
            chunk_objs.append(chunk)
        db.commit()
        for ch in chunk_objs:
            db.refresh(ch)

        # Save chunk images to gallery and build a mapping chunk_id -> first image id
        chunk_first_image = {}
        for ch in chunk_objs:
            if ch.ref_img:
                img = ChunkImage(chunk_id=ch.id, data_uri=ch.ref_img, position=0)
                db.add(img)
                db.flush()
                chunk_first_image[ch.id] = img.id
        db.commit()

        job.total_chunks = len(chunk_objs)
        db.commit()

        # ── Step 3: Generate cards per chunk IN PARALLEL ─────────────────────
        job.pipeline_step = "generating"
        db.commit()

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        rs = db.get(RuleSet, rule_set_id)
        rules_text = rs.content

        # Build curriculum tree for inline topic tagging
        curriculum_nodes = db.query(Curriculum).all()
        curriculum_tree = "\n".join(
            f"  {n.path}" for n in curriculum_nodes if n.path
        ) if curriculum_nodes else ""

        # Pre-load chunk data for thread safety
        chunks_data = []
        for ch in chunk_objs:
            chunks_data.append({
                "id": ch.id,
                "source_text": ch.source_text,
                "heading": ch.heading,
                "ref_img": ch.ref_img,
            })

        total_cards = 0
        total_input_tokens = 0
        total_output_tokens = 0
        note_id_base = int(time.time() * 1000)
        note_id_counter = {"value": 0}
        note_id_lock = threading.Lock()

        def next_note_id():
            with note_id_lock:
                nid = note_id_base + note_id_counter["value"]
                note_id_counter["value"] += 1
                return nid

        # Append curriculum context to rules for inline topic tagging
        rules_with_topics = rules_text
        if curriculum_tree:
            rules_with_topics += (
                "\n\nCURRICULUM TOPICS — assign the most specific matching topic path "
                "as the LAST tag on each card (e.g., 'Emergency Medicine > Cardiovascular > Endocarditis'). "
                "Available topics:\n" + curriculum_tree
            )

        def process_chunk(chunk_data):
            """Generate cards for one chunk with retry."""
            for attempt in range(4):
                try:
                    cards_data, needs_review, usage = generate_cards_for_chunk(
                        client,
                        {
                            "source_text": chunk_data["source_text"],
                            "heading": chunk_data["heading"],
                            "topic_path": "",  # no pre-assigned topic — model tags inline
                        },
                        rules_with_topics,
                        model,
                    )
                    return chunk_data, cards_data, needs_review, usage
                except anthropic.RateLimitError:
                    if attempt == 3:
                        raise
                    wait = 20 * (2 ** attempt)
                    logger.warning(
                        "Rate limit on chunk %d, retrying in %ds (attempt %d/4)",
                        chunk_data["id"], wait, attempt + 1,
                    )
                    time.sleep(wait)

        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {executor.submit(process_chunk, cd): cd for cd in chunks_data}
            for future in as_completed(futures):
                try:
                    chunk_data, cards_data, needs_review, usage = future.result()
                except Exception as exc:
                    logger.exception("Chunk %d failed: %s", futures[future]["id"], exc)
                    job.processed_chunks += 1
                    db.commit()
                    continue

                # Determine tags from chunk heading or curriculum match
                # The model should include topic in its output if curriculum was provided
                tags = []
                # Try to match chunk heading to curriculum
                heading_lower = chunk_data["heading"].lower().strip()
                for node in curriculum_nodes:
                    if node.path and node.name.lower().strip() == heading_lower:
                        tags = node.path.split(" > ")
                        # Also set chunk topic
                        db.query(Chunk).filter(Chunk.id == chunk_data["id"]).update({
                            "topic_id": node.id,
                            "topic_path": node.path,
                            "topic_confirmed": True,
                        })
                        break

                # Use gallery image id if available, otherwise fall back to inline ref_img
                gallery_img_id = chunk_first_image.get(chunk_data["id"])
                for card_data in cards_data:
                    card = Card(
                        chunk_id=chunk_data["id"],
                        document_id=doc_id,
                        card_number=card_data["card_number"],
                        front_html=card_data["front_html"],
                        front_text=card_data["front_text"],
                        extra=card_data.get("extra"),
                        source_ref=card_data.get("source_ref"),
                        tags=tags,
                        needs_review=needs_review,
                        ref_img_id=gallery_img_id,
                        ref_img=chunk_data.get("ref_img") if not gallery_img_id else None,
                        note_id=next_note_id(),
                    )
                    db.add(card)

                db.query(Chunk).filter(Chunk.id == chunk_data["id"]).update(
                    {"card_count": len(cards_data)}
                )
                total_cards += len(cards_data)
                total_input_tokens += usage["input_tokens"]
                total_output_tokens += usage["output_tokens"]
                job.processed_chunks += 1
                db.commit()

        # Log card generation usage
        db.add(AIUsageLog(
            operation="card_generation",
            model=model,
            input_tokens=total_input_tokens,
            output_tokens=total_output_tokens,
            cost_usd=compute_cost(model, total_input_tokens, total_output_tokens),
            document_id=doc_id,
            job_id=job_id,
        ))
        job.total_cards = total_cards
        db.commit()

        # ── Step 4: Generate vignettes & teaching cases ──────────────────────
        # Fall back to card generation rule set if no supplemental rule set specified
        effective_supp_rule_set_id = supplemental_rule_set_id or rule_set_id
        if effective_supp_rule_set_id:
            job.pipeline_step = "supplementals"
            db.commit()

            supp_rs = db.get(RuleSet, effective_supp_rule_set_id)
            if supp_rs:
                supp_rules_text = supp_rs.content
                all_cards = db.query(Card).filter(
                    Card.document_id == doc_id,
                    Card.status == CardStatus.active
                ).all()

                # Group cards by leaf topic (condition)
                condition_groups = {}
                for c in all_cards:
                    leaf = (c.tags or [])[-1] if c.tags else "Unassigned"
                    condition_groups.setdefault(leaf, []).append({
                        "id": c.id,
                        "card_number": c.card_number,
                        "front_text": c.front_text,
                    })

                supp_input = 0
                supp_output = 0

                def generate_supplemental_with_retry(condition, group_cards):
                    for attempt in range(4):
                        try:
                            return generate_supplemental_for_group(
                                client, condition, group_cards, supp_rules_text, model
                            )
                        except anthropic.RateLimitError:
                            if attempt == 3:
                                raise
                            wait = 20 * (2 ** attempt)
                            logger.warning(
                                "Rate limit on supplemental '%s', retrying in %ds",
                                condition, wait,
                            )
                            time.sleep(wait)

                with ThreadPoolExecutor(max_workers=3) as executor:
                    futures = {
                        executor.submit(
                            generate_supplemental_with_retry, cond, cards_list
                        ): (cond, cards_list)
                        for cond, cards_list in condition_groups.items()
                    }
                    for future in as_completed(futures):
                        cond, cards_list = futures[future]
                        try:
                            vignette, teaching_case, s_usage = future.result()
                            card_ids_in_group = [c["id"] for c in cards_list]
                            db.query(Card).filter(Card.id.in_(card_ids_in_group)).update(
                                {"vignette": vignette, "teaching_case": teaching_case},
                                synchronize_session="fetch",
                            )
                            supp_input += s_usage.get("input_tokens", 0)
                            supp_output += s_usage.get("output_tokens", 0)
                        except Exception:
                            logger.exception(
                                "simple_pipeline: supplemental failed for '%s'", cond
                            )
                        db.commit()

                if supp_input > 0 or supp_output > 0:
                    db.add(AIUsageLog(
                        operation="supplemental_generation",
                        model=model,
                        input_tokens=supp_input,
                        output_tokens=supp_output,
                        cost_usd=compute_cost(model, supp_input, supp_output),
                        document_id=doc_id,
                        job_id=job_id,
                    ))
                    total_input_tokens += supp_input
                    total_output_tokens += supp_output
                    db.commit()

        # ── Done ─────────────────────────────────────────────────────────────
        job.pipeline_step = "done"
        job.status = JobStatus.done
        job.total_cards = total_cards
        job.actual_input_tokens = total_input_tokens
        job.actual_output_tokens = total_output_tokens
        job.finished_at = utcnow()
        db.commit()

    except anthropic.AuthenticationError:
        _fail_auto_job(db, job_id, "Anthropic API key is invalid or missing.")
    except anthropic.PermissionDeniedError as e:
        msg = str(e).lower()
        if "credit" in msg or "billing" in msg or "balance" in msg or "quota" in msg:
            _fail_auto_job(db, job_id, "Your Anthropic account is out of credits.")
        else:
            _fail_auto_job(db, job_id, f"Anthropic permission error: {e}")
    except anthropic.RateLimitError:
        _fail_auto_job(db, job_id, "Rate limit reached after all retries.")
    except anthropic.APIStatusError as e:
        msg = str(e).lower()
        if "credit" in msg or "billing" in msg or "balance" in msg:
            _fail_auto_job(db, job_id, "Your Anthropic account is out of credits.")
        else:
            _fail_auto_job(db, job_id, f"Anthropic API error ({e.status_code}): {e.message}")
    except Exception as e:
        logger.exception("_run_simple_pipeline failed")
        _fail_auto_job(db, job_id, str(e))
    finally:
        db.close()
