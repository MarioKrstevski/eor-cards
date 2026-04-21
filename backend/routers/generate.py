from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db, SessionLocal
from backend.models import Document, Chunk, Card, GenerationJob, JobStatus, CardStatus, RuleSet
from backend.services.generator import generate_cards_for_chunk
from backend.services.cost_estimator import estimate_cost
from backend.config import MODELS, DEFAULT_MODEL, ANTHROPIC_API_KEY
import anthropic

router = APIRouter()


class EstimateRequest(BaseModel):
    document_id: int
    chunk_ids: Optional[list[int]] = None
    rule_set_id: int
    model: str = DEFAULT_MODEL


class StartRequest(BaseModel):
    document_id: int
    chunk_ids: Optional[list[int]] = None
    rule_set_id: int
    model: str = DEFAULT_MODEL


def _get_chunks(document_id: int, chunk_ids: Optional[list[int]], db: Session) -> list[Chunk]:
    doc = db.get(Document, document_id)
    if not doc:
        raise HTTPException(404, "Document not found")
    if chunk_ids:
        chunks = db.query(Chunk).filter(
            Chunk.id.in_(chunk_ids),
            Chunk.document_id == document_id,
        ).all()
        if len(chunks) != len(chunk_ids):
            raise HTTPException(422, "Some chunk_ids do not belong to this document")
    else:
        chunks = db.query(Chunk).filter_by(document_id=document_id).all()
    return chunks


@router.get("/models")
def list_models():
    return [
        {"id": k, "display": v["display"],
         "input_per_1m": v["input_per_1m"], "output_per_1m": v["output_per_1m"]}
        for k, v in MODELS.items()
    ]


@router.post("/estimate")
def estimate(body: EstimateRequest, db: Session = Depends(get_db)):
    rs = db.get(RuleSet, body.rule_set_id)
    if not rs:
        raise HTTPException(404, "Rule set not found")
    chunks = _get_chunks(body.document_id, body.chunk_ids, db)
    return estimate_cost(
        [{"source_text": c.source_text} for c in chunks],
        rs.content,
        body.model,
    )


@router.post("/start", status_code=201)
def start_generation(
    body: StartRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    rs = db.get(RuleSet, body.rule_set_id)
    if not rs:
        raise HTTPException(404, "Rule set not found")
    chunks = _get_chunks(body.document_id, body.chunk_ids, db)

    cost_est = estimate_cost(
        [{"source_text": c.source_text} for c in chunks],
        rs.content,
        body.model,
    )
    job = GenerationJob(
        document_id=body.document_id,
        scope="selected" if body.chunk_ids else "all",
        chunk_ids=body.chunk_ids,
        rule_set_id=body.rule_set_id,
        model=body.model,
        total_chunks=len(chunks),
        estimated_cost_usd=cost_est["estimated_cost_usd"],
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    background_tasks.add_task(
        _run_generation,
        job.id,
        [c.id for c in chunks],
        rs.content,
        body.model,
        body.document_id,
    )
    return {
        "job_id": job.id,
        "total_chunks": job.total_chunks,
        "estimated_cost_usd": job.estimated_cost_usd,
    }


@router.get("/jobs/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    job = db.get(GenerationJob, job_id)
    if not job:
        raise HTTPException(404)
    return {
        "id": job.id,
        "document_id": job.document_id,
        "status": job.status,
        "total_chunks": job.total_chunks,
        "processed_chunks": job.processed_chunks,
        "total_cards": job.total_cards,
        "estimated_cost_usd": job.estimated_cost_usd,
        "actual_input_tokens": job.actual_input_tokens,
        "actual_output_tokens": job.actual_output_tokens,
        "error_message": job.error_message,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }


def _run_generation(
    job_id: int,
    chunk_ids: list[int],
    rules_text: str,
    model: str,
    document_id: int,
):
    """Background task: generate cards for each chunk, update job progress."""
    db = SessionLocal()
    try:
        job = db.get(GenerationJob, job_id)
        job.status = JobStatus.running
        job.started_at = datetime.utcnow()
        db.commit()

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        doc = db.get(Document, document_id)
        tags = doc.topic_path.split(" > ") if doc and doc.topic_path else []
        total_cards = 0

        for chunk_id in chunk_ids:
            chunk = db.get(Chunk, chunk_id)
            if not chunk:
                continue
            cards_data, needs_review = generate_cards_for_chunk(
                client,
                {"source_text": chunk.source_text, "heading": chunk.heading},
                rules_text,
                model,
            )
            for card_data in cards_data:
                card = Card(
                    chunk_id=chunk.id,
                    document_id=document_id,
                    card_number=card_data["card_number"],
                    front_html=card_data["front_html"],
                    front_text=card_data["front_text"],
                    tags=tags,
                    needs_review=needs_review,
                )
                db.add(card)
            chunk.card_count = len(cards_data)
            total_cards += len(cards_data)
            job.processed_chunks += 1
            db.commit()

        job.status = JobStatus.done
        job.total_cards = total_cards
        job.finished_at = datetime.utcnow()
        db.commit()

    except Exception as e:
        job = db.get(GenerationJob, job_id)
        if job:
            job.status = JobStatus.failed
            job.error_message = str(e)
            job.finished_at = datetime.utcnow()
            db.commit()
    finally:
        db.close()
