import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from backend.db import engine, Base
from backend.routers import documents, cards, generate, curriculum, rules, export

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(os.path.join(os.path.dirname(__file__), "..", "data", "uploads"), exist_ok=True)
    Base.metadata.create_all(bind=engine)
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
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))
