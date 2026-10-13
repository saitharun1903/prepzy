# Private inference service (Ollama). Deploy as a PRIVATE service: it must never get a public URL.
# Models are pulled on first start into /root/.ollama (mount a persistent disk there).
FROM ollama/ollama:0.40.3
ENV OLLAMA_HOST=0.0.0.0:11434 \
    OLLAMA_KEEP_ALIVE=30m \
    OLLAMA_NUM_PARALLEL=1 \
    OLLAMA_MAX_LOADED_MODELS=2 \
    ELEVATE_LLM_MODEL=qwen2.5:3b \
    ELEVATE_EMBED_MODEL=nomic-embed-text
COPY infrastructure/ollama/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 11434
ENTRYPOINT ["/entrypoint.sh"]
