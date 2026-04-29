"""Feature requests — client submits, developer completes."""
import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
import anthropic
from backend.db import get_db
from backend.models import FeatureRequest, utcnow
from backend.config import ANTHROPIC_API_KEY

try:
    from frontend_version import get_app_version
except ImportError:
    def get_app_version() -> int:
        return 0

logger = logging.getLogger(__name__)
router = APIRouter()

ADMIN_PASSWORD = "12345"

REFINE_PROMPT = """You are helping a user write a clear feature request for a software developer.
The user will describe what they want. Ask 2-3 SHORT clarifying questions (one at a time) to understand:
1. What exactly they want changed or added
2. Where in the app it should appear or work
3. Any specific details about how it should behave

Keep questions brief and specific. When you have enough info, generate a clean request with:
- A short title (under 60 chars)
- A clear description (2-4 sentences explaining what, where, and why)

Output the final request in this format:
===TITLE===
(title here)
===DESCRIPTION===
(description here)

Do NOT output the ===TITLE=== format until you have asked your questions and received answers."""


class CreateRequest(BaseModel):
    title: str
    description: str
    source: str = "manual"
    chat_session_id: Optional[int] = None


class CompleteRequest(BaseModel):
    password: str


class RefineMessage(BaseModel):
    messages: list[dict]  # conversation so far


@router.get("")
def list_requests(status: Optional[str] = None, db: Session = Depends(get_db)):
    q = db.query(FeatureRequest).order_by(FeatureRequest.created_at.desc())
    if status:
        q = q.filter_by(status=status)
    return [
        {
            "id": r.id,
            "title": r.title,
            "description": r.description,
            "source": r.source,
            "chat_session_id": r.chat_session_id,
            "status": r.status,
            "app_version": r.app_version,
            "created_at": r.created_at.isoformat(),
            "completed_at": r.completed_at.isoformat() if r.completed_at else None,
        }
        for r in q.all()
    ]


@router.post("", status_code=201)
def create_request(body: CreateRequest, db: Session = Depends(get_db)):
    req = FeatureRequest(
        title=body.title,
        description=body.description,
        source=body.source,
        chat_session_id=body.chat_session_id,
        app_version=get_app_version(),
    )
    db.add(req)
    db.commit()
    db.refresh(req)
    return {"id": req.id, "title": req.title}


@router.post("/{req_id}/complete")
def complete_request(req_id: int, body: CompleteRequest, db: Session = Depends(get_db)):
    if body.password != ADMIN_PASSWORD:
        raise HTTPException(403, "Incorrect password")
    req = db.get(FeatureRequest, req_id)
    if not req:
        raise HTTPException(404)
    req.status = "done"
    req.completed_at = utcnow()
    db.commit()
    return {"id": req.id, "status": "done"}


@router.delete("/{req_id}", status_code=204)
def delete_request(req_id: int, db: Session = Depends(get_db)):
    req = db.get(FeatureRequest, req_id)
    if not req:
        raise HTTPException(404)
    db.delete(req)
    db.commit()


@router.post("/refine")
def refine_request(body: RefineMessage):
    """AI-guided request refinement — ask clarifying questions then generate clean request."""
    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            system=REFINE_PROMPT,
            messages=body.messages,
        )
        return {"content": response.content[0].text}
    except Exception as e:
        logger.exception("Refine request failed")
        return {"content": f"Sorry, something went wrong: {str(e)[:200]}"}
