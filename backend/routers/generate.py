import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db, SessionLocal
from backend.models import Document, Chunk, Card, GenerationJob, JobStatus, CardStatus, RuleSet, AIUsageLog, utcnow
from backend.services.generator import generate_cards_for_chunk
from backend.services.cost_estimator import estimate_cost
from backend.config import MODELS, DEFAULT_MODEL, ANTHROPIC_API_KEY, compute_cost
import anthropic

logger = logging.getLogger(__name__)

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
    replace_existing: bool = True


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
        body.replace_existing,
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


def _fail_job(db, job_id: int, message: str):
    try:
        job = db.get(GenerationJob, job_id)
        if job:
            job.status = JobStatus.failed
            job.error_message = message
            job.finished_at = utcnow()
            db.commit()
    except Exception:
        logger.exception("Failed to write error status for job %d", job_id)


def _run_generation(
    job_id: int,
    chunk_ids: list[int],
    rules_text: str,
    model: str,
    document_id: int,
    replace_existing: bool = True,
):
    """Background task: generate cards for each chunk, update job progress."""
    db = SessionLocal()
    try:
        job = db.get(GenerationJob, job_id)
        job.status = JobStatus.running
        job.started_at = utcnow()
        db.commit()

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        total_cards = 0
        total_input_tokens = 0
        total_output_tokens = 0

        # Pre-load all chunks so threads don't share the db session
        chunks_by_id = {}
        for chunk_id in chunk_ids:
            chunk = db.get(Chunk, chunk_id)
            if chunk:
                chunks_by_id[chunk_id] = {
                    "id": chunk.id,
                    "source_text": chunk.source_text,
                    "heading": chunk.heading,
                    "topic_path": chunk.topic_path,
                }
            else:
                logger.warning("Chunk %d not found during generation job %d, skipping", chunk_id, job_id)

        if replace_existing:
            for chunk_id in chunks_by_id:
                db.query(Card).filter(Card.chunk_id == chunk_id).delete()
            db.commit()

        def process_chunk(chunk_data):
            cards_data, needs_review, usage = generate_cards_for_chunk(
                client,
                {"source_text": chunk_data["source_text"], "heading": chunk_data["heading"],
                 "topic_path": chunk_data["topic_path"]},
                rules_text,
                model,
            )
            return chunk_data, cards_data, needs_review, usage

        with ThreadPoolExecutor(max_workers=14) as executor:
            futures = {executor.submit(process_chunk, c): c for c in chunks_by_id.values()}
            for future in as_completed(futures):
                chunk_data, cards_data, needs_review, usage = future.result()
                tags = chunk_data["topic_path"].split(" > ") if chunk_data["topic_path"] else []
                for card_data in cards_data:
                    card = Card(
                        chunk_id=chunk_data["id"],
                        document_id=document_id,
                        card_number=card_data["card_number"],
                        front_html=card_data["front_html"],
                        front_text=card_data["front_text"],
                        tags=tags,
                        needs_review=needs_review,
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
            model=model,
            input_tokens=total_input_tokens,
            output_tokens=total_output_tokens,
            cost_usd=compute_cost(model, total_input_tokens, total_output_tokens),
            document_id=document_id,
            job_id=job_id,
        ))
        job.status = JobStatus.done
        job.total_cards = total_cards
        job.actual_input_tokens = total_input_tokens
        job.actual_output_tokens = total_output_tokens
        job.finished_at = utcnow()
        db.commit()

    except anthropic.AuthenticationError:
        _fail_job(db, job_id, "Anthropic API key is invalid or missing. Check your ANTHROPIC_API_KEY.")
    except anthropic.PermissionDeniedError as e:
        msg = str(e).lower()
        if "credit" in msg or "billing" in msg or "balance" in msg or "quota" in msg:
            _fail_job(db, job_id, "Your Anthropic account is out of credits. Please top up your balance and try again.")
        else:
            _fail_job(db, job_id, f"Anthropic permission error: {e}")
    except anthropic.RateLimitError:
        _fail_job(db, job_id, "Anthropic rate limit reached. Please wait a moment and try again.")
    except anthropic.APIStatusError as e:
        msg = str(e).lower()
        if "credit" in msg or "billing" in msg or "balance" in msg:
            _fail_job(db, job_id, "Your Anthropic account is out of credits. Please top up your balance and try again.")
        else:
            _fail_job(db, job_id, f"Anthropic API error ({e.status_code}): {e.message}")
    except Exception as e:
        _fail_job(db, job_id, str(e))
    finally:
        db.close()
