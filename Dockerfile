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

# Bundle seed data (copied to /app/data/ by entrypoint on first boot)
RUN mkdir -p /app/seed
COPY data/curriculum.json /app/seed/curriculum.json
COPY data/ai-rules.md     /app/seed/ai-rules.md

# Copy entrypoint
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Copy built frontend static files from stage 1 (vite outDir: ../backend/static)
COPY --from=frontend /app/backend/static/ ./backend/static/

ENV PYTHONPATH=/app

EXPOSE 8000

ENTRYPOINT ["/app/entrypoint.sh"]
