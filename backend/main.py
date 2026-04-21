import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from backend.db import engine, Base
from backend.routers import documents, cards, generate, curriculum, rules, export
from backend import models  # noqa

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


def seed_data():
    from sqlalchemy.orm import Session
    from backend.config import DATA_DIR
    with Session(engine) as db:
        if db.query(models.RuleSet).count() == 0:
            rules_path = os.path.join(DATA_DIR, "ai-rules.md")
            if os.path.exists(rules_path):
                with open(rules_path) as f:
                    content = f.read()
                db.add(models.RuleSet(name="Default (ai-rules v1.1)", content=content, is_default=True))
                db.commit()
        if db.query(models.Curriculum).count() == 0:
            import json
            curr_path = os.path.join(DATA_DIR, "curriculum.json")
            if os.path.exists(curr_path):
                with open(curr_path) as f:
                    tree = json.load(f)
                _seed_curriculum(db, tree, parent_id=None, level=0, parent_path="")
                db.commit()

def _seed_curriculum(db, nodes, parent_id, level, parent_path):
    from backend.models import Curriculum
    for node in nodes:
        path = f"{parent_path} > {node['name']}" if parent_path else node["name"]
        c = Curriculum(parent_id=parent_id, name=node["name"], level=level, path=path)
        db.add(c)
        db.flush()
        if node.get("children"):
            _seed_curriculum(db, node["children"], c.id, level + 1, path)


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(os.path.join(os.path.dirname(__file__), "..", "data", "uploads"), exist_ok=True)
    Base.metadata.create_all(bind=engine)
    seed_data()
    yield

app = FastAPI(title="EOR Card Studio", lifespan=lifespan)

app.include_router(documents.router, prefix="/api/documents", tags=["documents"])
app.include_router(cards.router, prefix="/api/cards", tags=["cards"])
app.include_router(generate.router, prefix="/api/generate", tags=["generate"])
app.include_router(curriculum.router, prefix="/api/curriculum", tags=["curriculum"])
app.include_router(rules.router, prefix="/api/rules", tags=["rules"])
app.include_router(export.router, prefix="/api/export", tags=["export"])

if os.path.exists(STATIC_DIR) and os.listdir(STATIC_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def spa_fallback(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404)
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))
