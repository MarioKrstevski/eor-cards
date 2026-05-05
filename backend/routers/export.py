import csv
import io
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload
from typing import Optional
from backend.db import get_db
from backend.models import Card, Curriculum, Document

router = APIRouter()


@router.get("/cards")
def export_cards(
    document_id: Optional[int] = None,
    curriculum_id: Optional[int] = None,
    db: Session = Depends(get_db),
):
    q = (
        db.query(Card)
        .join(Document, Card.document_id == Document.id)
        .options(joinedload(Card.document), joinedload(Card.chunk))
    )
    if document_id:
        q = q.filter(Card.document_id == document_id)
    elif curriculum_id:
        node = db.get(Curriculum, curriculum_id)
        if node:
            q = q.filter(
                (Document.topic_path == node.path) |
                Document.topic_path.startswith(node.path + " > ")
            )
    cards = q.all()

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=[
        "note_id", "id", "front_text", "front_html", "tags", "extra",
        "vignette", "teaching_case", "ref_img", "ref_img_position",
        "source_ref", "status", "needs_review", "chunk_heading", "document_name", "topic_path",
    ])
    writer.writeheader()
    for card in cards:
        writer.writerow({
            "note_id": card.note_id or "",
            "id": card.id,
            "front_text": card.front_text,
            "front_html": card.front_html,
            "tags": ",".join(card.tags or []),
            "extra": card.extra or "",
            "vignette": card.vignette or "",
            "teaching_case": card.teaching_case or "",
            "ref_img": card.ref_img or "",
            "ref_img_position": card.ref_img_position or "",
            "source_ref": card.source_ref or "",
            "status": card.status,
            "needs_review": card.needs_review,
            "chunk_heading": card.chunk.heading if card.chunk else "",
            "document_name": card.document.original_name if card.document else "",
            "topic_path": card.chunk.topic_path if card.chunk else "",
        })
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=cards.csv"},
    )
