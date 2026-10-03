# Frontend build stage: the PWA is served by FastAPI from frontend/dist,
# so the image must contain the built assets, not the source tree.
FROM node:22-slim AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
# TemplateForm.fix-r1.test.tsx typechecks against the real backend template
# data via ../../../app/data/templates.json; mirror it at that path.
COPY app/data/templates.json /app/data/templates.json
RUN npm run build

FROM python:3.13-slim
WORKDIR /srv/autolab
COPY pyproject.toml ./
COPY labcore ./labcore
COPY app ./app
COPY labdata ./labdata
COPY alembic ./alembic
COPY alembic.ini ./
RUN pip install --no-cache-dir ".[labdata]"
COPY --from=frontend /build/dist ./frontend/dist
EXPOSE 8000
CMD ["sh", "-c", "python -m alembic upgrade head && uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000"]
