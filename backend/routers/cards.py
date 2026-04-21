from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import Card, CardStatus
from backend.services.generator import strip_card_html

router = APIRouter()


class CardPatch(BaseModel):
    front_html: Optional[str] = None
    tags: Optional[list[str]] = None
    extra: Optional[str] = None
    status: Optional[CardStatus] = None


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
        "status": card.status,
        "needs_review": card.needs_review,
        "created_at": card.created_at.isoformat() if card.created_at else None,
        "updated_at": card.updated_at.isoformat() if card.updated_at else None,
        "topic_path": card.document.topic_path if card.document else None,
        "chunk_heading": card.chunk.heading if card.chunk else None,
    }


@router.get("")
def list_cards(
    document_id: Optional[int] = None,
    chunk_id: Optional[int] = None,
    status: Optional[CardStatus] = None,
    needs_review: Optional[bool] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Card).options(joinedload(Card.document), joinedload(Card.chunk))
    if document_id:
        q = q.filter(Card.document_id == document_id)
    if chunk_id:
        q = q.filter(Card.chunk_id == chunk_id)
    if status:
        q = q.filter(Card.status == status)
    if needs_review is not None:
        q = q.filter(Card.needs_review == needs_review)
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
    if body.status is not None:
        card.status = body.status
    db.commit()
    db.refresh(card)
    return card_to_dict(card)


@router.post("/{card_id}/reject")
def reject_card(card_id: int, db: Session = Depends(get_db)):
    card = db.get(Card, card_id)
    if not card:
        raise HTTPException(404)
    card.status = CardStatus.rejected
    db.commit()
    db.refresh(card)
    return card_to_dict(card)
