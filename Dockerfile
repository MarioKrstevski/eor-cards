# Stage 1: Build frontend
FROM node:20-slim AS frontend

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


# Stage 2: Final image
FROM python:3.12-slim

WORKDIR /app

# Install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend source
COPY backend/ ./backend/

# Copy built frontend static files from stage 1 (vite outDir: ../backend/static)
COPY --from=frontend /app/backend/static/ ./backend/static/

# Create data directories (DB and uploads persisted via volume mount)
RUN mkdir -p /app/data/uploads /app/data/chunk_images

ENV PYTHONPATH=/app

EXPOSE 8000

CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
