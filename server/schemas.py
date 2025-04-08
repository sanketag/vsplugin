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
