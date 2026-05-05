import json
import anthropic
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import cast, String
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import Card, CardStatus, Chunk, RuleSet, AIUsageLog
from backend.services.generator import strip_card_html, regenerate_single_card
from backend.config import ANTHROPIC_API_KEY, DEFAULT_MODEL, compute_cost

router = APIRouter()


class RegenerateCardRequest(BaseModel):
    model: str = DEFAULT_MODEL
    prompt: Optional[str] = None


class CardPatch(BaseModel):
    front_html: Optional[str] = None
    tags: Optional[list[str]] = None
    extra: Optional[str] = None
    vignette: Optional[str] = None
    teaching_case: Optional[str] = None
    ref_img: Optional[str] = None
    ref_img_position: Optional[str] = None
    status: Optional[CardStatus] = None
    is_reviewed: Optional[bool] = None


def card_to_dict(card: Card) -> dict:
    return {
        "id": card.id,
        "chunk_id": card.chunk_id,
        "document_id": card.document_id,
        "card_number": card.card_number,
        "front_html": card.front_html,
        "front_text": card.front_text,
        "tags": card.tags,
        "extra": card.extra,
        "vignette": card.vignette,
        "teaching_case": card.teaching_case,
        "ref_img": card.ref_img,
        "ref_img_position": card.ref_img_position,
        "source_ref": card.source_ref,
        "note_id": card.note_id,
        "status": card.status,
        "is_reviewed": card.is_reviewed,
        "created_at": card.created_at.isoformat() if card.created_at else None,
        "updated_at": card.updated_at.isoformat() if card.updated_at else None,
        "topic_path": card.chunk.topic_path if card.chunk else None,
        "chunk_heading": card.chunk.heading if card.chunk else None,
        "chunk_source_html": card.chunk.source_html if card.chunk else None,
    }


@router.get("")
def list_cards(
    document_id: Optional[int] = None,
    chunk_id: Optional[int] = None,
    status: Optional[CardStatus] = None,
    is_reviewed: Optional[bool] = None,
    tag: Optional[str] = None,
    search_q: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Card).options(joinedload(Card.document), joinedload(Card.chunk))
    if document_id:
        q = q.filter(Card.document_id == document_id)
    if chunk_id:
        q = q.filter(Card.chunk_id == chunk_id)
    if status:
        q = q.filter(Card.status == status)
    if is_reviewed is not None:
        q = q.filter(Card.is_reviewed == is_reviewed)
    if tag:
        q = q.filter(cast(Card.tags, String).contains(json.dumps(tag)))
    if search_q:
        q_pattern = f"%{search_q}%"
        q = q.filter(Card.front_text.ilike(q_pattern))
    q = q.join(Card.chunk)
    if document_id or chunk_id:
        # Document view: follow document flow
        q = q.order_by(Chunk.chunk_index, Card.card_number)
    else:
        # Topic/search view: group by topic, then document order within
        q = q.order_by(Chunk.topic_path, Card.document_id, Card.card_number)
    return [card_to_dict(c) for c in q.all()]


@router.patch("/{card_id}")
def patch_card(card_id: int, body: CardPatch, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    if body.front_html is not None:
        card.front_html = body.front_html
        card.front_text = strip_card_html(body.front_html)
    if body.tags is not None:
        card.tags = body.tags
    if body.extra is not None:
        card.extra = body.extra
    if body.vignette is not None:
        card.vignette = body.vignette
    if body.teaching_case is not None:
        card.teaching_case = body.teaching_case
    if body.ref_img is not None:
        card.ref_img = body.ref_img if body.ref_img != "" else None
    if body.ref_img_position is not None:
        card.ref_img_position = body.ref_img_position
    if body.status is not None:
        card.status = body.status
    if body.is_reviewed is not None:
        card.is_reviewed = body.is_reviewed
    db.commit()
    db.refresh(card)
    return card_to_dict(card)


@router.post("/{card_id}/regenerate")
def regenerate_card(card_id: int, body: RegenerateCardRequest, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    chunk = db.get(Chunk, card.chunk_id)
    if not chunk:
        raise HTTPException(404, "Chunk not found")
    rs = db.query(RuleSet).filter_by(rule_type='generation', is_default=True).first()
    rules = rs.content if rs else "Generate cloze cards. Use {{c1::term}} format."
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    cards_data, needs_review, usage = regenerate_single_card(
        client,
        chunk={"source_text": chunk.source_text, "heading": chunk.heading},
        existing_card_html=card.front_html,
        rules_text=rules,
        extra_prompt=body.prompt or None,
        model=body.model,
    )
    if cards_data:
        card.front_html = cards_data[0]["front_html"]
        card.front_text = cards_data[0]["front_text"]
        if cards_data[0].get("extra") is not None:
            card.extra = cards_data[0]["extra"]
        card.source_ref = cards_data[0].get("source_ref")
        card.is_reviewed = False
    db.commit()
    if usage:
        db.add(AIUsageLog(
            operation="card_regen",
            model=body.model,
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            cost_usd=compute_cost(body.model, usage.get("input_tokens", 0), usage.get("output_tokens", 0)),
            card_id=card_id,
            chunk_id=card.chunk_id,
        ))
        db.commit()
    db.refresh(card)
    return card_to_dict(card)


@router.post("/{card_id}/reject")
def reject_card(card_id: int, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    card.status = CardStatus.rejected
    card.is_reviewed = True
    db.commit()
    db.refresh(card)
    return card_to_dict(card)


class BulkReviewRequest(BaseModel):
    card_ids: list[int]

@router.post("/bulk-review")
def bulk_mark_reviewed(body: BulkReviewRequest, db: Session = Depends(get_db)):
    if body.card_ids:
        db.query(Card).filter(Card.id.in_(body.card_ids)).update(
            {"is_reviewed": True}, synchronize_session=False
        )
        db.commit()
    return {"updated": len(body.card_ids)}


@router.post("/bulk-delete", status_code=200)
def bulk_delete_cards(body: BulkReviewRequest, db: Session = Depends(get_db)):
    if body.card_ids:
        db.query(Card).filter(Card.id.in_(body.card_ids)).delete(synchronize_session=False)
        db.commit()
    return {"deleted": len(body.card_ids)}


@router.delete("/{card_id}", status_code=204)
def delete_card(card_id: int, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    # Update chunk card count
    chunk = db.get(Chunk, card.chunk_id)
    if chunk and chunk.card_count > 0:
        chunk.card_count -= 1
    db.delete(card)
    db.commit()
