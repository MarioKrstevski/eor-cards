from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from backend.db import get_db
from backend.models import Chunk, ChunkImage

router = APIRouter()


class UploadImageRequest(BaseModel):
    data_uri: str


@router.get("/chunks/{chunk_id}/images")
def list_chunk_images(chunk_id: int, db: Session = Depends(get_db)):
    chunk = db.get(Chunk, chunk_id)
    if not chunk:
        raise HTTPException(404, "Chunk not found")
    images = db.query(ChunkImage).filter(ChunkImage.chunk_id == chunk_id).order_by(ChunkImage.position).all()
    return [
        {"id": img.id, "chunk_id": img.chunk_id, "data_uri": img.data_uri, "position": img.position}
        for img in images
    ]


@router.post("/chunks/{chunk_id}/images", status_code=201)
def upload_chunk_image(chunk_id: int, body: UploadImageRequest, db: Session = Depends(get_db)):
    chunk = db.get(Chunk, chunk_id)
    if not chunk:
        raise HTTPException(404, "Chunk not found")
    if not body.data_uri:
        raise HTTPException(422, "data_uri is required")
    # Determine next position
    max_pos = db.query(ChunkImage.position).filter(ChunkImage.chunk_id == chunk_id).order_by(ChunkImage.position.desc()).first()
    next_pos = (max_pos[0] + 1) if max_pos else 0
    img = ChunkImage(chunk_id=chunk_id, data_uri=body.data_uri, position=next_pos)
    db.add(img)
    db.commit()
    db.refresh(img)
    return {"id": img.id, "chunk_id": img.chunk_id, "data_uri": img.data_uri, "position": img.position}


@router.delete("/chunk-images/{image_id}", status_code=204)
def delete_chunk_image(image_id: int, db: Session = Depends(get_db)):
    img = db.get(ChunkImage, image_id)
    if not img:
        raise HTTPException(404, "Image not found")
    db.delete(img)
    db.commit()
