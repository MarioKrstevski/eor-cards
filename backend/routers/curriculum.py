from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.db import get_db
from backend.models import Curriculum, Document

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

@router.patch("/{node_id}")
def rename_node(node_id: int, body: CurriculumUpdate, db: Session = Depends(get_db)):
    node = db.get(Curriculum, node_id)
    if not node:
        raise HTTPException(404)
    node.name = body.name
    db.commit()
    db.refresh(node)
    return node_to_dict(node)

@router.delete("/{node_id}", status_code=204)
def delete_node(node_id: int, db: Session = Depends(get_db)):
    node = db.get(Curriculum, node_id)
    if not node:
        raise HTTPException(404)
    if db.query(Document).filter_by(curriculum_id=node_id).count():
        raise HTTPException(400, "Cannot delete node with assigned documents")
    db.delete(node)
    db.commit()
