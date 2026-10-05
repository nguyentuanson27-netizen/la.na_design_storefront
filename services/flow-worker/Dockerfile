ARG PYTHON_IMAGE=python:3.13.14-slim@sha256:9662417aace5ae7b8e2609cce472b72a8958e134ba372808abe9cc1a0c0125e6

FROM ${PYTHON_IMAGE} AS lock-export
ARG UV_VERSION=0.10.0
RUN pip install --no-cache-dir --no-deps "uv==${UV_VERSION}"

WORKDIR /lock
COPY gflow-lock/pyproject.toml gflow-lock/uv.lock ./
RUN uv export \
      --frozen \
      --no-dev \
      --no-emit-project \
      --format requirements.txt \
      --output-file /tmp/gflow-runtime.txt \
 && printf '\ngflow-cli==0.82.1 --hash=sha256:12eb15c20d5b366cbdc471056351914e5e6be6e04893ba081e4d49c74fbce845\n' \
      >> /tmp/gflow-runtime.txt

FROM ${PYTHON_IMAGE}
ARG GOOGLE_CHROME_VERSION=154.0.8037.97-1

ENV PYTHONUNBUFFERED=1 \
    GFLOW_CLI_HOME=/data/gflow \
    GFLOW_CLI_DB_PATH=/tmp/gflow-auth.db \
    GFLOW_CLI_HEADLESS=false \
    GFLOW_CLI_HISTORY_PROMPTS=redacted \
    GFLOW_CLI_UPDATE_CHECK=false \
    FLOW_WORKER_HOST=0.0.0.0 \
    FLOW_WORKER_PORT=8787

COPY --from=lock-export /tmp/gflow-runtime.txt /tmp/gflow-runtime.txt

RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb xauth ca-certificates curl gnupg \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends "google-chrome-stable=${GOOGLE_CHROME_VERSION}" \
 && pip install --no-cache-dir --require-hashes -r /tmp/gflow-runtime.txt \
 && python -m pip check \
 && rm -f /tmp/gflow-runtime.txt \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 flow \
 && mkdir -p /app /data/gflow \
 && chown -R flow:flow /app /data

WORKDIR /app
COPY --chown=flow:flow flow_worker ./flow_worker

USER flow
EXPOSE 8787

CMD ["xvfb-run", "-a", "python", "-m", "flow_worker.server"]
