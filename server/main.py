"""
Code Assistance API Main Module
Handles code completion, review, optimization, refactoring, and suggestions
"""

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Callable, Union

import psutil
import redis
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from exceptions import ValidationError
from faiss_index import CodeVectorStore
# Local imports
from ollama_helper import CodeGenerator, ModelOverloadError
from schemas import *
from utils import (
    get_relevant_context, get_cached,
    generate_cache_key, build_completion_prompt, build_review_prompt,
    build_optimization_prompt, parse_review_result, cache_stream,
    generate_metrics, get_related_code
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("CodeAssistAPI")

# Configuration
CONFIG = {
    "max_memory": int(os.getenv("MAX_MEMORY", "20GB").replace("GB", "")) * 1024 ** 3,
    "max_context_length": 4096,
    "cache_ttl": 3600,  # 1 hour
    "timeouts": {
        "completion": 0.3,
        "review": 0.5,
        "optimize": 0.7
    }
}


# Middleware
class PriorityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable):
        # Assign priority based on endpoint
        if "/complete" in request.url.path:
            request.state.priority = 1
        elif "/review" in request.url.path:
            request.state.priority = 2
        else:
            request.state.priority = 3

        # Add timing headers
        start_time = time.time()
        response = await call_next(request)
        process_time = time.time() - start_time
        response.headers["X-Process-Time"] = str(process_time)
        return response


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize critical resources on startup"""
    logger.info("Starting up Code Assistance API")

    # Initialize vector store with codebase
    app.state.vector_store = CodeVectorStore(
        index_path="codebase_faiss_index",
        code_dir=os.getenv("CODEBASE_DIR", "/u01/pytn/poc/aidi/dev/dags")
    )

    # Connect to Redis
    app.state.cache = redis.Redis(
        host=os.getenv("REDIS_HOST", "localhost"),
        port=int(os.getenv("REDIS_PORT", "6379")),
        db=0
    )

    # Initialize model
    app.state.generator = CodeGenerator(
        model_name=os.getenv("MODEL_NAME", "qwen2.5-coder:1.5b"),
        num_threads=int(os.getenv("NUM_THREADS", "6"))
    )

    # Warm up model
    logger.info("Warming up model...")
    try:
        await asyncio.to_thread(app.state.generator.warmup)
        logger.info("Model warm-up complete")
    except Exception as e:
        logger.error(f"Model warm-up failed: {e}")

    yield

    # Shutdown
    logger.info("Shutting down Code Assistance API")
    # Redis connection cleanup
    app.state.cache.close()


# Initialize app
app = FastAPI(
    title="Code Assistance API",
    description="AI-powered code assistant for Airflow DAGs and Python",
    version="1.0",
    lifespan=lifespan
)

# Add middleware
app.add_middleware(PriorityMiddleware)


# Core endpoints
@app.post("/v1/complete", response_class=StreamingResponse)
# @handle_errors
async def code_completion(request: CodeCompletionRequest):
    """
    Real-time code completion with context awareness
    {
        "prompt": "partial code",
        "file_path": "dag_processing.py",
        "max_tokens": 256
    }
    """
    cache_key = generate_cache_key(request.prompt, request.file_path)

    # Cache check (fast path)
    cached = await get_cached(app.state.cache, cache_key)
    if cached:
        logger.info("Cache hit for completion")

        async def yield_cached():
            yield cached

        return StreamingResponse(yield_cached(), media_type="text/event-stream")

    # Context retrieval
    context = await get_relevant_context(
        app.state.vector_store,
        request.prompt
    )

    # Generate streaming response
    stream_generator = app.state.generator.stream(
        prompt=build_completion_prompt(request.prompt, context),
        max_tokens=request.max_tokens,
        temperature=0.1
    )

    # Cache and stream
    return StreamingResponse(
        cache_stream(app.state.cache, cache_key, stream_generator),
        media_type="text/event-stream"
    )


@app.post("/v1/chat")
async def chat_with_context(request: dict):
    """
    Enhanced chat endpoint with code context
    {
        "message": "user message",
        "context": {
            "file_path": "current_file.py",
            "code": "current code content",
            "language": "python",
            "selection": "selected code if any"
        },
        "model": "gpt-4"
    }
    """
    try:
        # First try to find relevant code from vector store
        relevant_code = await get_relevant_context(
            app.state.vector_store,
            request.get("message", "") + "\n" + request.get("context", {}).get("code", "")
        )

        # Build prompt with context
        prompt = f"""**[Code Context]**
File: {request.get('context', {}).get('file_path', 'N/A')}
Language: {request.get('context', {}).get('language', 'N/A')}

**[Relevant Code from Repository]**
{relevant_code if relevant_code else 'No similar code found in repository'}

**[User Message]**
{request.get('message', '')}

**[Current Code Context]**
{request.get('context', {}).get('code', '')}

Please provide a helpful response considering both the existing codebase and the current file context.
"""

        # Generate response
        stream_generator = app.state.generator.stream(
            prompt=prompt,
            max_tokens=1024,
            temperature=0.3
        )

        return StreamingResponse(
            stream_generator,
            media_type="text/event-stream"
        )

    except Exception as e:
        logger.error(f"Chat error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/v1/review", response_model=CodeReviewResponse)
# @handle_errors
async def code_review(request: CodeReviewRequest):
    # First search vector DB for similar code patterns
    similar_code_results = await asyncio.to_thread(
        app.state.vector_store.search,
        query=request.code,
        k=3,
        file_filter=os.path.dirname(request.file_path) if request.file_path else None
    )

    # If we find highly similar code (low score = better match)
    relevant_issues = []
    for doc in similar_code_results:
        if doc['score'] < 0.3:  # Threshold for strong similarity
            # Extract any known issues from similar code
            review_prompt = build_review_prompt(doc['content'], request.lang)
            cached_review = await get_cached(app.state.cache, generate_cache_key(review_prompt))

            if cached_review:
                relevant_issues.extend(cached_review['issues'])

    if relevant_issues:
        return {"issues": relevant_issues, "source": "existing_code"}

    # Fall back to LLM only if no good matches found
    review_prompt = build_review_prompt(request.code, request.lang)
    result = await asyncio.to_thread(
        app.state.generator.generate,
        review_prompt,
        max_tokens=512
    )

    issues = parse_review_result(result)
    return {"issues": issues, "source": "generated"}


@app.post("/v1/optimize")
# @handle_errors
async def code_optimization(request: CodeOptimizeRequest):
    """
    Code optimization with pattern matching
    {
        "code": "original_code",
        "context": ["related_file1.py", "related_file2.py"]
    }
    """
    related_code = await get_related_code(
        app.state.vector_store,
        request.code,
        request.context or []
    )
    optimization_prompt = build_optimization_prompt(request.code, related_code)

    # Generate streaming response
    stream_generator = app.state.generator.stream(
        prompt=optimization_prompt,
        max_tokens=1024,
        temperature=0.2
    )

    return StreamingResponse(
        stream_generator,
        media_type="text/event-stream"
    )


# Support endpoints
@app.post("/v1/refactor")
# @handle_errors
async def code_refactoring(request: RefactorRequest):
    """
    Code refactoring for Airflow version compatibility
    {
        "code": "original_code",
        "target_version": "airflow2.6"
    }
    """
    refactor_prompt = f"""**[Code Refactoring Task]**
Refactor the following code to make it compatible with Airflow {request.target_version}.
Focus on using the latest best practices and features.

**[Code to Refactor]**
```python
{request.code}
```

Provide refactored code with explanations of the changes made.
"""

    # Generate streaming response
    stream_generator = app.state.generator.stream(
        prompt=refactor_prompt,
        max_tokens=1024,
        temperature=0.1
    )

    return StreamingResponse(
        stream_generator,
        media_type="text/event-stream"
    )


@app.get("/health")
async def health_check():
    """System health monitoring"""
    return {
        "status": "healthy",
        "memory_usage": {
            "total": psutil.virtual_memory().total,
            "used": psutil.virtual_memory().used,
            "percent": psutil.virtual_memory().percent
        },
        "model_status": app.state.generator.status(),
        "cache_connected": app.state.cache.ping()
    }


@app.get("/metrics")
async def prometheus_metrics():
    """Prometheus metrics endpoint"""
    return Response(
        content=generate_metrics(),
        media_type="text/plain"
    )


@app.middleware("http")
async def error_middleware(request: Request, call_next):
    try:
        return await call_next(request)
    except ModelOverloadError:
        return JSONResponse(
            {"error": "Model overloaded - try again later"},
            status_code=503
        )
    except ValidationError as e:
        return JSONResponse(
            {"error": str(e)},
            status_code=422
        )
    except Exception as e:
        logger.exception("Unexpected error")
        return JSONResponse(
            {"error": "Internal server error"},
            status_code=500
        )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=9693,
        workers=int(os.getenv("WORKERS", "2")),
        limit_concurrency=100,
        timeout_keep_alive=30
    )
