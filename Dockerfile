FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt
COPY server /app/server
COPY static /app/static
ENV PORT=8787 PARTY_DB=/data/party.sqlite PYTHONUNBUFFERED=1
RUN useradd --uid 10001 --create-home party && mkdir /data && chown party:party /data
USER party
EXPOSE 8787
CMD ["python", "-m", "server.app"]
