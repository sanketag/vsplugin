import os
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
from schemas import *
import random
import string
import asyncio


"""
Pydantic models for API request/response validation
"""

from pydantic import BaseModel
from typing import List, Optional

class CodeCompletionRequest(BaseModel):
    prompt: str
    file_path: str
    max_tokens: Optional[int] = 256

class CodeReviewRequest(BaseModel):
    code: str
    lang: Optional[str] = "python"
    strict_mode: Optional[bool] = False

class CodeOptimizeRequest(BaseModel):
    code: str
    context: Optional[List[str]] = []

class RefactorRequest(BaseModel):
    code: str
    target_version: Optional[str] = "airflow2.6"

class CodeIssue(BaseModel):
    line_start: int
    line_end: int
    severity: str  # "high", "medium", "low"
    type: str      # "standard", "performance", "security"
    description: str

class CodeReviewResponse(BaseModel):
    issues: List[CodeIssue]

class OptimizationSuggestion(BaseModel):
    original: str
    optimized: str
    improvement: str  # "readability", "performance", "maintainability"



app = FastAPI(title="Dummy Code Assistance API", version="1.0")

# Random dummy text generator
def generate_dummy_text(length=50):
    return ''.join(random.choices(string.ascii_letters + string.digits + ' ', k=length))


@app.post("/v1/complete")
async def code_completion(request: CodeCompletionRequest):
    print(request)
    async def fake_stream():
        for _ in range(5):
            await asyncio.sleep(0.1)
            yield generate_dummy_text(50)
    return StreamingResponse(fake_stream(), media_type="text/event-stream")


@app.post("/v1/chat")
async def chat_with_context(request: dict):
    print(request)
    async def fake_chat():
        for _ in range(50):
            await asyncio.sleep(0.01)
            yield generate_dummy_text(1)
    return StreamingResponse(fake_chat(), media_type="text/event-stream")


@app.post("/v1/review", response_model=CodeReviewResponse)
async def code_review(request: CodeReviewRequest):
    print(request)
    issues = [
        {
            "line_start": 1,
            "line_end": 1,
            "severity": "low",
            "type": "standard",
            "description": generate_dummy_text(30)
        }
    ]
    return {"issues": issues}


@app.post("/v1/optimize")
async def code_optimization(request: CodeOptimizeRequest):
    print(request)
    async def fake_optimize():
        for _ in range(3):
            await asyncio.sleep(0.1)
            yield generate_dummy_text(70)
    return StreamingResponse(fake_optimize(), media_type="text/event-stream")


@app.post("/v1/refactor")
async def code_refactoring(request: RefactorRequest):
    print(request)
    async def fake_refactor():
        for _ in range(4):
            await asyncio.sleep(0.1)
            yield generate_dummy_text(60)
    return StreamingResponse(fake_refactor(), media_type="text/event-stream")


@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "cpu_only": True,
        "dummy_mode": True
    }


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
