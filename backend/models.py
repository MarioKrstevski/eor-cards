from datetime import datetime
from typing import Optional
from sqlalchemy import String, Text, Boolean, Integer, Float, JSON, ForeignKey, Enum
from sqlalchemy.orm import Mapped, mapped_column, relationship
from backend.db import Base
import enum

def utcnow():
    return datetime.utcnow()

class RuleSet(Base):
    __tablename__ = "rule_sets"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True)
    content: Mapped[str] = mapped_column(Text)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

class Curriculum(Base):
    __tablename__ = "curriculum"
    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[Optional[int]] = mapped_column(ForeignKey("curriculum.id"), nullable=True)
    name: Mapped[str] = mapped_column(String(200))
    level: Mapped[int] = mapped_column(Integer, default=0)
    path: Mapped[str] = mapped_column(String(500))
    children: Mapped[list["Curriculum"]] = relationship("Curriculum", back_populates="parent")
    parent: Mapped[Optional["Curriculum"]] = relationship("Curriculum", back_populates="children", remote_side="Curriculum.id")

class Document(Base):
    __tablename__ = "documents"
    id: Mapped[int] = mapped_column(primary_key=True)
    filename: Mapped[str] = mapped_column(String(300))
    original_name: Mapped[str] = mapped_column(String(300))
    uploaded_at: Mapped[datetime] = mapped_column(default=utcnow)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    chunks: Mapped[list["Chunk"]] = relationship("Chunk", back_populates="document", cascade="all, delete-orphan")
    cards: Mapped[list["Card"]] = relationship("Card", back_populates="document", cascade="all, delete-orphan")
    jobs: Mapped[list["GenerationJob"]] = relationship("GenerationJob", back_populates="document", cascade="all, delete-orphan")

class Chunk(Base):
    __tablename__ = "chunks"
    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id"))
    chunk_index: Mapped[int] = mapped_column(Integer)
    heading: Mapped[str] = mapped_column(String(300))
    content_type: Mapped[str] = mapped_column(String(50))
    source_text: Mapped[str] = mapped_column(Text)
    source_html: Mapped[str] = mapped_column(Text)
    rule_subset: Mapped[list] = mapped_column(JSON, default=list)
    card_count: Mapped[int] = mapped_column(Integer, default=0)
    topic_id: Mapped[Optional[int]] = mapped_column(ForeignKey("curriculum.id"), nullable=True)
    topic_path: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    topic_confirmed: Mapped[bool] = mapped_column(Boolean, default=False)
    document: Mapped["Document"] = relationship("Document", back_populates="chunks")
    cards: Mapped[list["Card"]] = relationship("Card", back_populates="chunk", cascade="all, delete-orphan")

class CardStatus(str, enum.Enum):
    active = "active"
    rejected = "rejected"

class Card(Base):
    __tablename__ = "cards"
    id: Mapped[int] = mapped_column(primary_key=True)
    chunk_id: Mapped[int] = mapped_column(ForeignKey("chunks.id"))
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id"))
    card_number: Mapped[int] = mapped_column(Integer)
    front_html: Mapped[str] = mapped_column(Text)
    front_text: Mapped[str] = mapped_column(Text)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    extra: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    status: Mapped[CardStatus] = mapped_column(Enum(CardStatus), default=CardStatus.active)
    needs_review: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(default=utcnow, onupdate=utcnow)
    chunk: Mapped["Chunk"] = relationship("Chunk", back_populates="cards")
    document: Mapped["Document"] = relationship("Document", back_populates="cards")

class JobStatus(str, enum.Enum):
    pending = "pending"
    running = "running"
    done = "done"
    failed = "failed"

class GenerationJob(Base):
    __tablename__ = "generation_jobs"
    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id"))
    scope: Mapped[str] = mapped_column(String(20))
    chunk_ids: Mapped[Optional[list]] = mapped_column(JSON, nullable=True)
    rule_set_id: Mapped[int] = mapped_column(ForeignKey("rule_sets.id"))
    model: Mapped[str] = mapped_column(String(100))
    status: Mapped[JobStatus] = mapped_column(Enum(JobStatus), default=JobStatus.pending)
    total_chunks: Mapped[int] = mapped_column(Integer, default=0)
    processed_chunks: Mapped[int] = mapped_column(Integer, default=0)
    total_cards: Mapped[int] = mapped_column(Integer, default=0)
    estimated_cost_usd: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    actual_input_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    actual_output_tokens: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    started_at: Mapped[Optional[datetime]] = mapped_column(nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(nullable=True)
    document: Mapped["Document"] = relationship("Document", back_populates="jobs")
    rule_set: Mapped["RuleSet"] = relationship("RuleSet")


class AIUsageLog(Base):
    __tablename__ = "ai_usage_log"
    id: Mapped[int] = mapped_column(primary_key=True)
    operation: Mapped[str] = mapped_column(String(50))  # chunking / topic_detection / card_generation / card_regen
    model: Mapped[str] = mapped_column(String(100))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    document_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)  # no FK constraint — entity may be deleted
    chunk_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    card_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    job_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utcnow)
