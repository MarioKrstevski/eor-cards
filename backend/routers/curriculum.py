from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, case
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import Curriculum, Chunk, Card, CardStatus
import anthropic
from backend.config import ANTHROPIC_API_KEY, DEFAULT_MODEL, DEFAULT_CHUNKING_MODEL, compute_cost
from backend.models import AIUsageLog
from backend.services.topic_detector import detect_chunk_topics

router = APIRouter()

class CurriculumCreate(BaseModel):
    name: str
    parent_id: Optional[int] = None

class CurriculumUpdate(BaseModel):
    name: str

def node_to_dict(node: Curriculum, children: list = None) -> dict:
    return {
        "id": node.id,
        "name": node.name,
        "level": node.level,
        "path": node.path,
        "parent_id": node.parent_id,
        "children": children or [],
    }

def build_tree(nodes: list[Curriculum]) -> list[dict]:
    by_id = {n.id: node_to_dict(n) for n in nodes}
    roots = []
    for n in nodes:
        if n.parent_id is None:
            roots.append(by_id[n.id])
        elif n.parent_id in by_id:
            by_id[n.parent_id]["children"].append(by_id[n.id])
    return roots

@router.get("")
def get_tree(db: Session = Depends(get_db)):
    nodes = db.query(Curriculum).all()
    return build_tree(nodes)

@router.post("", status_code=201)
def create_node(body: CurriculumCreate, db: Session = Depends(get_db)):
    parent = None
    if body.parent_id:
        parent = db.get(Curriculum, body.parent_id)
        if not parent:
            raise HTTPException(404, "Parent not found")
    level = (parent.level + 1) if parent else 0
    path = f"{parent.path} > {body.name}" if parent else body.name
    node = Curriculum(name=body.name, parent_id=body.parent_id, level=level, path=path)
    db.add(node)
    db.commit()
    db.refresh(node)
    return node_to_dict(node)

def _cascade_path_update(db, parent: Curriculum):
    """Recursively rebuild path strings for all children of a node."""
    children = db.query(Curriculum).filter_by(parent_id=parent.id).all()
    for child in children:
        child.path = f"{parent.path} > {child.name}"
        _cascade_path_update(db, child)

@router.patch("/{node_id}")
def rename_node(node_id: int, body: CurriculumUpdate, db: Session = Depends(get_db)):
    node = db.get(Curriculum, node_id)
    if not node:
        raise HTTPException(404)
    node.name = body.name
    # Rebuild this node's path from parent
    if node.parent_id:
        parent = db.get(Curriculum, node.parent_id)
        node.path = f"{parent.path} > {body.name}"
    else:
        node.path = body.name
    # Cascade path update to all descendants
    _cascade_path_update(db, node)
    db.commit()
    db.refresh(node)
    return node_to_dict(node)

@router.get("/coverage")
def get_coverage(db: Session = Depends(get_db)):
    """Return card breakdown per curriculum topic_id (direct, not aggregated)."""
    rows = (
        db.query(
            Chunk.topic_id,
            func.count(Card.id).label("total"),
            func.sum(case((Card.status == CardStatus.active, 1), else_=0)).label("active"),
            func.sum(case((Card.status == CardStatus.rejected, 1), else_=0)).label("rejected"),
            func.sum(case(
                ((Card.status == CardStatus.active) & ~Card.is_reviewed, 1),
                else_=0,
            )).label("unreviewed"),
        )
        .join(Card, Card.chunk_id == Chunk.id)
        .filter(Chunk.topic_id.isnot(None))
        .group_by(Chunk.topic_id)
        .all()
    )
    return {
        str(r.topic_id): {
            "total": r.total,
            "active": r.active,
            "rejected": r.rejected,
            "unreviewed": r.unreviewed,
        }
        for r in rows
    }


@router.delete("/{node_id}", status_code=204)
def delete_node(node_id: int, db: Session = Depends(get_db)):
    node = db.get(Curriculum, node_id)
    if not node:
        raise HTTPException(404)
    if db.query(Curriculum).filter_by(parent_id=node_id).count():
        raise HTTPException(400, "Cannot delete node with children")
    # Reassign chunks/cards that pointed here → point to parent (or null)
    parent = db.get(Curriculum, node.parent_id) if node.parent_id else None
    db.query(Chunk).filter(Chunk.topic_id == node_id).update(
        {
            "topic_id": parent.id if parent else None,
            "topic_path": parent.path if parent else None,
        },
        synchronize_session=False,
    )
    db.delete(node)
    db.commit()


@router.post("/{node_id}/reassign-topics")
def reassign_topics(node_id: int, chunking_model: str = DEFAULT_CHUNKING_MODEL, db: Session = Depends(get_db)):
    """Re-run AI topic detection for chunks currently assigned to this node's subtree."""
    node = db.get(Curriculum, node_id)
    if not node:
        raise HTTPException(404)

    # Collect all node IDs in subtree
    def subtree_ids(nid: int) -> set:
        ids = {nid}
        for child in db.query(Curriculum).filter_by(parent_id=nid).all():
            ids |= subtree_ids(child.id)
        return ids

    ids = subtree_ids(node_id)

    chunks = db.query(Chunk).filter(Chunk.topic_id.in_(ids)).all()
    if not chunks:
        return {"reassigned": 0}

    all_nodes = db.query(Curriculum).all()
    curriculum_nodes = [{"id": n.id, "path": n.path} for n in all_nodes]
    chunk_dicts = [{"id": c.id, "heading": c.heading, "source_text": c.source_text} for c in chunks]

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    mappings, usage = detect_chunk_topics(client, chunk_dicts, curriculum_nodes, model=chunking_model)

    for m in mappings:
        chunk = db.get(Chunk, m["chunk_id"])
        if chunk:
            old_topic_id = chunk.topic_id
            chunk.topic_id = m["topic_id"]
            chunk.topic_path = m["topic_path"]
            # Update card tags to reflect new leaf topic name
            if m["topic_id"] and m["topic_id"] != old_topic_id:
                new_node = db.get(Curriculum, m["topic_id"])
                if new_node:
                    leaf_name = new_node.name
                    for card in db.query(Card).filter_by(chunk_id=chunk.id).all():
                        tags = list(card.tags or [])
                        if leaf_name not in tags:
                            card.tags = tags + [leaf_name]

    db.commit()

    if usage.get("input_tokens", 0):
        db.add(AIUsageLog(
            operation="topic_detection",
            model=chunking_model,
            input_tokens=usage.get("input_tokens", 0),
            output_tokens=usage.get("output_tokens", 0),
            cost_usd=compute_cost(chunking_model, usage.get("input_tokens", 0), usage.get("output_tokens", 0)),
        ))
        db.commit()

    return {"reassigned": len(mappings)}
