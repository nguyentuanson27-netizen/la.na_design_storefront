FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    GFLOW_CLI_HOME=/data/gflow \
    GFLOW_CLI_HEADLESS=false \
    GFLOW_CLI_HISTORY_PROMPTS=redacted \
    GFLOW_CLI_UPDATE_CHECK=false \
    FLOW_WORKER_HOST=0.0.0.0 \
    FLOW_WORKER_PORT=8787

RUN apt-get update \
 && apt-get install -y --no-install-recommends xvfb xauth ca-certificates curl gnupg \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir "gflow-cli==0.82.1" \
 && useradd --create-home --uid 10001 flow \
 && mkdir -p /app /data/gflow \
 && chown -R flow:flow /app /data

WORKDIR /app
COPY --chown=flow:flow flow_worker ./flow_worker

USER flow
EXPOSE 8787

CMD ["xvfb-run", "-a", "python", "-m", "flow_worker.server"]
