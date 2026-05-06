import logging
import threading
import time
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


class SupplementalEstimateRequest(BaseModel):
    card_ids: list[int]
    model: str


class SupplementalStartRequest(BaseModel):
    card_ids: list[int]
    rule_set_id: int
    model: str
    replace_existing: bool = False


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


@router.post("/supplemental/estimate")
def estimate_supplemental(body: SupplementalEstimateRequest, db: Session = Depends(get_db)):
    """Estimate cost for combined vignette + teaching case generation."""
    try:
        cards = db.query(Card).filter(Card.id.in_(body.card_ids)).all()
        # Group by leaf topic to count condition groups
        groups = {}
        for c in cards:
            leaf = (c.tags or [])[-1] if c.tags else "Unassigned"
            groups.setdefault(leaf, []).append(c)
        num_groups = len(groups)
        # Estimate: ~500 input tokens per group (cards + rules), ~1500 output (vignette + teaching case)
        est_input = num_groups * 500
        est_output = num_groups * 1500
        cost = compute_cost(body.model, est_input, est_output)
        return {
            "card_count": len(cards),
            "condition_groups": num_groups,
            "estimated_input_tokens": est_input,
            "estimated_output_tokens": est_output,
            "estimated_cost_usd": cost,
            "model": body.model,
        }
    except Exception as e:
        logger.exception("estimate_supplemental failed")
        raise HTTPException(500, f"Estimate failed: {e}")


@router.post("/supplemental/start")
def start_supplemental(body: SupplementalStartRequest, bg: BackgroundTasks, db: Session = Depends(get_db)):
    """Start combined vignette + teaching case generation, grouped by condition."""
    try:
        rs = db.get(RuleSet, body.rule_set_id)
        if not rs:
            raise HTTPException(404, "Rule set not found")
        cards = db.query(Card).filter(Card.id.in_(body.card_ids)).all()
        if not cards:
            raise HTTPException(400, "No cards found")

        # Count condition groups for progress tracking
        groups = {}
        for c in cards:
            leaf = (c.tags or [])[-1] if c.tags else "Unassigned"
            groups.setdefault(leaf, []).append(c)

        est_input = len(groups) * 500
        est_output = len(groups) * 1500
        est_cost = compute_cost(body.model, est_input, est_output)

        job = GenerationJob(
            document_id=cards[0].document_id,
            job_type="supplemental",
            scope="selected",
            chunk_ids=[c.id for c in cards],
            rule_set_id=body.rule_set_id,
            model=body.model,
            status=JobStatus.pending,
            total_chunks=len(groups),  # track condition groups, not cards
            processed_chunks=0,
            total_cards=0,
            estimated_cost_usd=est_cost,
        )
        db.add(job)
        db.commit()
        db.refresh(job)

        bg.add_task(
            _run_supplemental,
            job.id,
            [c.id for c in cards],
            rs.content,
            body.model,
            body.replace_existing,
        )
        return {"job_id": job.id, "total_cards": len(cards), "condition_groups": len(groups), "estimated_cost_usd": est_cost}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("start_supplemental failed")
        raise HTTPException(500, f"Start supplemental failed: {e}")


@router.get("/jobs/active")
def get_active_jobs(db: Session = Depends(get_db)):
    """Return any running or pending jobs (for resume polling after page refresh)."""
    jobs = db.query(GenerationJob).filter(
        GenerationJob.status.in_([JobStatus.pending, JobStatus.running])
    ).all()
    return [
        {
            "id": job.id,
            "job_type": job.job_type,
            "document_id": job.document_id,
            "status": job.status,
            "total_chunks": job.total_chunks,
            "processed_chunks": job.processed_chunks,
            "total_cards": job.total_cards,
            "pipeline_step": job.pipeline_step,
        }
        for job in jobs
    ]


@router.get("/jobs/{job_id}")
def get_job(job_id: int, db: Session = Depends(get_db)):
    job = db.get(GenerationJob, job_id)
    if not job:
        raise HTTPException(404)
    return {
        "id": job.id,
        "job_type": job.job_type,
        "document_id": job.document_id,
        "status": job.status,
        "total_chunks": job.total_chunks,
        "processed_chunks": job.processed_chunks,
        "total_cards": job.total_cards,
        "estimated_cost_usd": job.estimated_cost_usd,
        "actual_input_tokens": job.actual_input_tokens,
        "actual_output_tokens": job.actual_output_tokens,
        "pipeline_step": job.pipeline_step,
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
                    "topic_id": chunk.topic_id,
                    "ref_img": chunk.ref_img,
                }
            else:
                logger.warning("Chunk %d not found during generation job %d, skipping", chunk_id, job_id)

        # Group chunks by topic_id for sibling context
        chunks_by_topic = {}
        for ch in chunks_by_id.values():
            tid = ch.get("topic_id")
            if tid:
                chunks_by_topic.setdefault(tid, []).append(ch)

        note_id_base = int(time.time() * 1000)
        note_id_counter = {"value": 0}
        note_id_lock = threading.Lock()

        def next_note_id():
            with note_id_lock:
                nid = note_id_base + note_id_counter["value"]
                note_id_counter["value"] += 1
                return nid

        if replace_existing:
            for chunk_id in chunks_by_id:
                db.query(Card).filter(Card.chunk_id == chunk_id).delete()
            db.commit()

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
                        model,
                        sibling_texts=siblings,
                    )
                    return chunk_data, cards_data, needs_review, usage
                except anthropic.RateLimitError:
                    if attempt == 3:
                        raise
                    wait = 20 * (2 ** attempt)  # 20s, 40s, 80s
                    logger.warning("Rate limit on chunk %d, retrying in %ds (attempt %d/4)", chunk_data["id"], wait, attempt + 1)
                    time.sleep(wait)

        with ThreadPoolExecutor(max_workers=3) as executor:
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
                        extra=card_data.get("extra"),
                        source_ref=card_data.get("source_ref"),
                        tags=tags,
                        needs_review=needs_review,
                        ref_img=chunk_data.get("ref_img"),
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


def _run_supplemental(
    job_id: int,
    card_ids: list[int],
    rules_text: str,
    model: str,
    replace_existing: bool,
):
    """Background task: generate vignette + teaching case per condition group."""
    from backend.services.supplemental_generator import generate_supplemental_for_group

    db = SessionLocal()
    try:
        job = db.get(GenerationJob, job_id)
        job.status = JobStatus.running
        job.started_at = utcnow()
        db.commit()

        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        cards = db.query(Card).filter(Card.id.in_(card_ids)).all()

        # Group cards by leaf topic (condition)
        condition_groups = {}
        for c in cards:
            if not replace_existing and c.vignette and c.teaching_case:
                continue
            leaf = (c.tags or [])[-1] if c.tags else "Unassigned"
            condition_groups.setdefault(leaf, []).append({
                "id": c.id,
                "card_number": c.card_number,
                "front_text": c.front_text,
            })

        total_input = 0
        total_output = 0
        processed_groups = 0
        total_cards_updated = 0

        def generate_supplemental_with_retry(condition, group_cards):
            for attempt in range(4):
                try:
                    return generate_supplemental_for_group(client, condition, group_cards, rules_text, model)
                except anthropic.RateLimitError:
                    if attempt == 3:
                        raise
                    wait = 20 * (2 ** attempt)
                    logger.warning("Rate limit on supplemental '%s', retrying in %ds (attempt %d/4)", condition, wait, attempt + 1)
                    time.sleep(wait)

        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {
                executor.submit(
                    generate_supplemental_with_retry, condition, group_cards
                ): (condition, group_cards)
                for condition, group_cards in condition_groups.items()
            }
            for future in as_completed(futures):
                condition, group_cards = futures[future]
                try:
                    vignette, teaching_case, usage = future.result()
                    # Apply same vignette + teaching case to all cards in this condition
                    card_ids_in_group = [c["id"] for c in group_cards]
                    db.query(Card).filter(Card.id.in_(card_ids_in_group)).update(
                        {"vignette": vignette, "teaching_case": teaching_case},
                        synchronize_session="fetch",
                    )
                    total_input += usage.get("input_tokens", 0)
                    total_output += usage.get("output_tokens", 0)
                    total_cards_updated += len(card_ids_in_group)
                except Exception:
                    logger.exception("Error generating supplemental for condition '%s'", condition)
                finally:
                    processed_groups += 1
                    job.processed_chunks = processed_groups
                    db.commit()

        cost = compute_cost(model, total_input, total_output)
        db.add(AIUsageLog(
            operation="supplemental_generation",
            model=model,
            input_tokens=total_input,
            output_tokens=total_output,
            cost_usd=cost,
            job_id=job_id,
        ))

        job.status = JobStatus.done
        job.actual_input_tokens = total_input
        job.actual_output_tokens = total_output
        job.total_cards = total_cards_updated
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
        logger.exception("_run_supplemental failed")
        _fail_job(db, job_id, str(e))
    finally:
        db.close()
