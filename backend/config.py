import os
from dotenv import load_dotenv

load_dotenv()

ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/app.db")

MODELS = {
    "claude-sonnet-4-6": {
        "display": "Claude Sonnet 4.6",
        "input_per_1m": 3.0,
        "output_per_1m": 15.0,
    },
    "claude-haiku-4-5-20251001": {
        "display": "Claude Haiku 4.5",
        "input_per_1m": 0.80,
        "output_per_1m": 4.0,
    },
}

DEFAULT_MODEL = "claude-sonnet-4-6"
AVG_OUTPUT_TOKENS_PER_CHUNK = 800
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
