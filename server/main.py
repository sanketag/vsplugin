"""
Code Assistance API Main Module
Handles code completion, review, optimization, refactoring, and suggestions
"""

from fastapi import FastAPI, HTTPException, Request, BackgroundTasks
from fastapi.responses import StreamingResponse
from fastapi.middleware import Middleware
from fastapi.concurrency import run_in_threadpool
from typing import Dict, Generator, Optional
import logging
import time
import hashlib
import asyncio
import redis
import os

# Local imports
from ollama_helper import CodeGenerator
from faiss_index import CodeVectorStore

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("CodeAssistAPI")

# Initialize core components
app = FastAPI(
    title="Code Assistance API",
    description="AI-powered code assistant for Airflow DAGs and Python",
    version="1.0",
    middleware=[
        Middleware(PriorityMiddleware)
    ]
)

# Configuration
CONFIG = {
    "max_memory": 55 * 1024**3,  # 55GB
    "max_context_length": 4096,
    "cache_ttl": 3600,  # 1 hour
    "timeouts": {
        "completion": 0.3,
        "review": 0.5,
        "optimize": 0.7
    }
}

# Initialize services
@app.on_event("startup")
async def startup():
    """Initialize critical resources on startup"""
    logger.info("Starting up Code Assistance API")
    
    # Initialize vector store with codebase
    app.state.vector_store = CodeVectorStore(
        index_path="codebase_faiss_index",
        code_dir="codebase/airflow_dags"
    )
    
    # Connect to Redis
    app.state.cache = redis.Redis(
        host=os.getenv("REDIS_HOST", "localhost"),
        max_memory=CONFIG["max_memory"],
        health_check_interval=30
    )
    
    # Warm up model
    logger.info("Warming up model...")
    bg = BackgroundTasks()
    bg.add_task(run_in_threadpool, app.state.generator.warmup)
    await bg()

# Core endpoints
@app.post("/v1/complete", response_class=StreamingResponse)
@handle_errors
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
    if cached := await get_cached(cache_key):
        logger.info("Cache hit for completion")
        return StreamingResponse(cached)
    
    # Context retrieval
    context = await get_relevant_context(
        request.prompt, 
        request.file_path
    )
    
    # Generate streaming response
    stream_generator = app.state.generator.stream(
        prompt=build_completion_prompt(request.prompt, context),
        max_tokens=request.max_tokens,
        temperature=0.1
    )
    
    # Cache and stream
    return StreamingResponse(
        cache_stream(cache_key, stream_generator),
        media_type="text/event-stream"
    )

@app.post("/v1/review")
@handle_errors
async def code_review(request: CodeReviewRequest):
    """
    Code review with standards validation
    {
        "code": "full_code_content",
        "lang": "python",
        "strict_mode": true
    }
    """
    review_prompt = build_review_prompt(request.code, request.lang)
    cache_key = generate_cache_key(review_prompt)
    
    if cached := await get_cached(cache_key):
        return JSONResponse(cached)
    
    # Generate review
    start_time = time.monotonic()
    result = await run_in_threadpool(
        app.state.generator.generate,
        review_prompt,
        max_tokens=512
    )
    
    # Process and validate issues
    issues = parse_review_result(result)
    await cache_result(cache_key, issues)
    
    logger.info(f"Review completed in {time.monotonic() - start_time:.2f}s")
    return {"issues": issues}

@app.post("/v1/optimize")
@handle_errors
async def code_optimization(request: CodeOptimizeRequest):
    """
    Code optimization with pattern matching
    {
        "code": "original_code",
        "context": ["related_file1.py", "related_file2.py"]
    }
    """
    related_code = await get_related_code(request.code, request.context)
    optimization_prompt = build_optimization_prompt(request.code, related_code)
    
    return StreamingResponse(
        app.state.generator.stream(optimization_prompt),
        media_type="text/event-stream"
    )

# Support endpoints
@app.post("/v1/refactor")
async def code_refactoring(request: RefactorRequest):
    """Similar structure to optimization endpoint"""
    # Implementation omitted for brevity

@app.get("/health")
async def health_check():
    """System health monitoring"""
    return {
        "status": "healthy",
        "memory_used": psutil.virtual_memory().used,
        "model_status": app.state.generator.status()
    }

@app.get("/metrics")
async def prometheus_metrics():
    """Prometheus metrics endpoint"""
    return generate_metrics()

# Helper functions
async def get_relevant_context(prompt: str, file_path: str) -> str:
    """Retrieve context from vector store"""
    try:
        # Get similar code snippets
        results = await app.state.vector_store.search(
            query=prompt,
            k=3,
            file_filter=os.path.dirname(file_path)
        )
        
        # Concatenate relevant context
        context = "\n".join([doc.content for doc in results])
        
        # Tokenize and truncate to fit context window
        tokens = tokenize(context)
        return detokenize(tokens[:CONFIG["max_context_length"]])
    
    except Exception as e:
        logger.error(f"Context retrieval failed: {str(e)}")
        return ""

def build_completion_prompt(prompt: str, context: str) -> str:
    """Construct LLM prompt with standards"""
    return f"""**[Airflow Coding Standards]**
{CODING_STANDARDS}

**[Existing Code Context]**
{context}

**[Code Completion]**
{prompt}"""

def generate_cache_key(*args) -> str:
    """Generate consistent cache key"""
    return hashlib.sha256("".join(args).encode()).hexdigest()[:32]

async def get_cached(key: str) -> Optional[str]:
    """Retrieve from Redis with timeout"""
    try:
        return await app.state.cache.get(key, timeout=0.01)
    except redis.TimeoutError:
        return None

async def cache_result(key: str, value: str):
    """Store result with TTL if memory available"""
    mem_info = psutil.virtual_memory()
    if mem_info.available > 10 * 1024**3:  # 10GB free
        await app.state.cache.setex(key, CONFIG["cache_ttl"], value)

# Middleware
class PriorityMiddleware:
    async def __call__(self, request: Request, call_next):
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

# Error handling
def handle_errors(func):
    async def wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)
        except ModelOverloadError as e:
            logger.error(f"Model overload: {str(e)}")
            raise HTTPException(503, "Service overloaded")
        except ValidationError as e:
            logger.warning(f"Validation error: {str(e)}")
            raise HTTPException(422, str(e))
        except Exception as e:
            logger.error(f"Unexpected error: {str(e)}")
            raise HTTPException(500, "Internal server error")
    return wrapper

# Request models
class CodeCompletionRequest(BaseModel):
    prompt: str
    file_path: str
    max_tokens: int = 256

class CodeReviewRequest(BaseModel):
    code: str
    lang: str = "python"
    strict_mode: bool = False

class CodeOptimizeRequest(BaseModel):
    code: str
    context: List[str] = []

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        workers=2,  # Optimal for 8-core CPU
        limit_concurrency=100,
        timeout_keep_alive=30
          )
