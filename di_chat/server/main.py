import os
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from sse_starlette.sse import EventSourceResponse
import httpx
from dotenv import load_dotenv
import json
from typing import AsyncGenerator, Dict, Any, List, Optional
from datetime import datetime
import logging
from pydantic import BaseModel, Field, validator
import re
from enum import Enum

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Chat API",
    description="API for streaming chat responses from Ollama with React-friendly formatting",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc"
)

# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust this to your React app's URL in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Constants
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "qwen2.5-coder:0.5b")
MAX_PROMPT_LENGTH = int(os.getenv("MAX_PROMPT_LENGTH", "4096"))
TIMEOUT = float(os.getenv("TIMEOUT", "60.0"))
MAX_RESPONSE_TOKENS = int(os.getenv("MAX_RESPONSE_TOKENS", "2048"))

# Enums for content types
class ContentType(str, Enum):
    TEXT = "text"
    CODE = "code"
    LIST = "list"
    TABLE = "table"
    MATH = "math"
    IMAGE = "image"
    METADATA = "metadata"
    BREAK = "break"
    ERROR = "error"

class ListType(str, Enum):
    BULLET = "bullet"
    NUMBERED = "numbered"
    TASK = "task"

# Models
class MessageItem(BaseModel):
    role: str = Field(..., description="The role of the message sender (user/assistant/system)")
    content: str = Field(..., description="The content of the message")
    images: Optional[List[str]] = Field(None, description="List of base64-encoded images (for multimodal models)")

class GenerateRequest(BaseModel):
    prompt: str = Field(..., description="The user's input prompt")
    model: str = Field(default=DEFAULT_MODEL, description="The model to use for generation")
    temperature: float = Field(default=0.7, ge=0.0, le=2.0, description="Controls randomness (0=deterministic, 2=most random)")
    max_tokens: Optional[int] = Field(default=MAX_RESPONSE_TOKENS, ge=1, le=32768, description="Maximum number of tokens to generate")
    history: Optional[List[MessageItem]] = Field(default=[], description="Previous messages in the conversation")
    format: Optional[str] = Field(default=None, description="Force the model to respond in a specific format (json, markdown, etc.)")
    stream: bool = Field(default=True, description="Whether to stream the response")

    @validator('prompt')
    def validate_prompt_length(cls, v):
        if len(v) > MAX_PROMPT_LENGTH:
            raise ValueError(f"Prompt exceeds maximum length of {MAX_PROMPT_LENGTH}")
        return v

class ChatResponse(BaseModel):
    content: str = Field(..., description="The generated content")
    stop: bool = Field(default=False, description="Whether this is the final chunk of the response")
    model: str = Field(..., description="The model used for generation")
    created_at: str = Field(..., description="ISO timestamp of when the response was created")
    content_type: ContentType = Field(default=ContentType.TEXT, description="Type of content being sent")
    language: Optional[str] = Field(None, description="Programming language for code blocks")
    list_type: Optional[ListType] = Field(None, description="Type of list (bullet/numbered/task)")
    formatting: Optional[Dict[str, Any]] = Field(None, description="Formatting hints for the frontend")
    metrics: Optional[Dict[str, Any]] = Field(None, description="Performance metrics if available")

class FormattingHints(BaseModel):
    bold: Optional[bool] = Field(None, description="Text should be bold")
    italic: Optional[bool] = Field(None, description="Text should be italic")
    header: Optional[int] = Field(None, description="Header level (1-6)")
    link: Optional[str] = Field(None, description="URL for links")
    code: Optional[bool] = Field(None, description="Inline code formatting")
    strikethrough: Optional[bool] = Field(None, description="Text should be strikethrough")
    blockquote: Optional[bool] = Field(None, description="Text is a blockquote")
    color: Optional[str] = Field(None, description="Text color for highlighting")

async def detect_content_type(content: str, current_context: Dict[str, Any]) -> Dict[str, Any]:
    """Detect content type and formatting hints from the text."""
    formatting_hints = {}
    content_type = ContentType.TEXT
    
    # Check for code blocks first (highest priority)
    code_block_match = re.match(r'```(\w*)\n', content)
    if code_block_match or current_context.get('in_code_block'):
        content_type = ContentType.CODE
        language = code_block_match.group(1) if code_block_match else current_context.get('language', '')
        
        # Map common language aliases to standard names
        language_map = {
            "js": "javascript",
            "ts": "typescript",
            "py": "python",
            "rb": "ruby",
            "sh": "bash",
            "c#": "csharp",
            "cpp": "c++",
            "html": "html",
            "css": "css",
            "json": "json",
            "md": "markdown",
            "yaml": "yaml"
        }
        
        language = language_map.get(language.lower(), language)
        return {
            "content_type": content_type,
            "language": language,
            "formatting": formatting_hints
        }
    
    # Check for math blocks (LaTeX)
    if '$$' in content or (content.startswith('$') and content.endswith('$')):
        return {
            "content_type": ContentType.MATH,
            "language": "latex",
            "formatting": formatting_hints
        }
    
    # Check for tables
    if '|' in content and not current_context.get('in_code_block'):
        # Check if this is a table row or separator
        if re.match(r'^\s*\|.+\|\s*$', content) or re.match(r'^[\s\|]*[-:]+[\s\|]*$', content):
            return {
                "content_type": ContentType.TABLE,
                "formatting": formatting_hints
            }
    
    # Check for lists
    if re.match(r'^\s*[\*\-\+]\s', content) and not current_context.get('in_code_block'):
        return {
            "content_type": ContentType.LIST,
            "list_type": ListType.BULLET,
            "formatting": formatting_hints
        }
    
    if re.match(r'^\s*\d+\.\s', content) and not current_context.get('in_code_block'):
        return {
            "content_type": ContentType.LIST,
            "list_type": ListType.NUMBERED,
            "formatting": formatting_hints
        }
    
    if re.match(r'^\s*-\s*\[\s*[x\s]\s*\]\s', content.lower()) and not current_context.get('in_code_block'):
        return {
            "content_type": ContentType.LIST,
            "list_type": ListType.TASK,
            "formatting": formatting_hints
        }
    
    # Check for paragraph breaks
    if content.strip() == "":
        return {
            "content_type": ContentType.BREAK,
            "formatting": formatting_hints
        }
    
    # Check for inline formatting
    if re.search(r'\*\*[^*]+\*\*', content) or re.search(r'__[^_]+__', content):
        formatting_hints['bold'] = True
    
    if re.search(r'\*[^*]+\*', content) or re.search(r'_[^_]+_', content):
        formatting_hints['italic'] = True
    
    if re.search(r'`[^`]+`', content):
        formatting_hints['code'] = True
    
    if re.search(r'~~[^~]+~~', content):
        formatting_hints['strikethrough'] = True
    
    if re.match(r'^#{1,6}\s+', content):
        header_level = len(re.match(r'^(#+)', content).group(1))
        formatting_hints['header'] = min(header_level, 6)  # Limit to h6
    
    if re.search(r'\[([^\]]+)\]\(([^)]+)\)', content):
        formatting_hints['link'] = True
    
    if re.match(r'^>\s+', content):
        formatting_hints['blockquote'] = True
    
    return {
        "content_type": content_type,
        "formatting": formatting_hints if formatting_hints else None
    }

async def generate_stream(request: GenerateRequest) -> AsyncGenerator[Dict[str, Any], None]:
    """Generate a stream of responses from Ollama with proper formatting."""
    text_buffer = ""
    code_buffer = ""
    in_code_block = False
    current_language = None
    last_content_type = ContentType.TEXT
    
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        data = {
            "model": request.model,
            "prompt": request.prompt,
            "stream": True,
            "options": {
                "temperature": request.temperature,
                "num_predict": request.max_tokens
            }
        }
        
        if request.history:
            # Format history as required by Ollama API
            messages = []
            for msg in request.history:
                messages.append({"role": msg.role, "content": msg.content})
            data["messages"] = messages
        
        try:
            async with client.stream(
                "POST",
                f"{OLLAMA_BASE_URL}/api/generate",
                json=data,
                timeout=TIMEOUT
            ) as response:
                response.raise_for_status()

                async for chunk in response.aiter_text():
                    if not chunk:
                        continue
                        
                    try:
                        json_chunk = json.loads(chunk)
                        
                        if "response" in json_chunk:
                            content = json_chunk["response"]
                            
                            # Check for code block markers
                            if "```" in content:
                                # Handle code block transitions
                                if not in_code_block:
                                    # Entering a code block
                                    parts = content.split("```", 1)
                                    
                                    # First send any text before the code block
                                    if parts[0] and text_buffer:
                                        complete_text = text_buffer + parts[0]
                                        text_buffer = ""
                                        
                                        yield {
                                            "content": complete_text,
                                            "content_type": ContentType.TEXT,
                                            "model": request.model,
                                            "created_at": datetime.utcnow().isoformat()
                                        }
                                    
                                    # Now enter code block mode
                                    in_code_block = True
                                    
                                    # Extract language if present
                                    code_part = parts[1] if len(parts) > 1 else ""
                                    lang_match = re.match(r'^(\w+)\n', code_part)
                                    if lang_match:
                                        current_language = lang_match.group(1)
                                        code_buffer = code_part[len(lang_match.group(0)):]
                                    else:
                                        current_language = None
                                        code_buffer = code_part
                                else:
                                    # Exiting a code block
                                    parts = content.split("```", 1)
                                    code_buffer += parts[0]
                                    
                                    # Send the complete code block
                                    yield {
                                        "content": code_buffer,
                                        "content_type": ContentType.CODE,
                                        "language": current_language,
                                        "model": request.model,
                                        "created_at": datetime.utcnow().isoformat()
                                    }
                                    
                                    # Reset code block state
                                    in_code_block = False
                                    code_buffer = ""
                                    current_language = None
                                    
                                    # Handle any text after the code block
                                    if len(parts) > 1:
                                        text_buffer = parts[1]
                            else:
                                # Regular content - accumulate in appropriate buffer
                                if in_code_block:
                                    code_buffer += content
                                else:
                                    text_buffer += content
                                    
                                    # Send text when we reach a sentence ending or newline
                                    if re.search(r'[.!?]\s*$', text_buffer) or '\n' in text_buffer:
                                        if text_buffer.strip():
                                            yield {
                                                "content": text_buffer,
                                                "content_type": ContentType.TEXT,
                                                "model": request.model,
                                                "created_at": datetime.utcnow().isoformat()
                                            }
                                            text_buffer = ""
                                
                        elif "done" in json_chunk and json_chunk["done"]:
                            # Flush any remaining content
                            if in_code_block and code_buffer:
                                yield {
                                    "content": code_buffer,
                                    "content_type": ContentType.CODE,
                                    "language": current_language,
                                    "model": request.model,
                                    "created_at": datetime.utcnow().isoformat()
                                }
                            
                            if text_buffer:
                                yield {
                                    "content": text_buffer,
                                    "content_type": ContentType.TEXT,
                                    "model": request.model,
                                    "created_at": datetime.utcnow().isoformat()
                                }
                            
                            yield {
                                "content": "",
                                "stop": True,
                                "model": request.model,
                                "created_at": datetime.utcnow().isoformat(),
                                "metrics": json_chunk.get("metrics")
                            }
                            return

                    except json.JSONDecodeError:
                        logger.warning("Failed to decode JSON chunk from Ollama")
                        continue

        except httpx.RequestError as e:
            logger.error(f"Ollama request error: {str(e)}")
            yield {
                "content": f"Error connecting to Ollama: {str(e)}",
                "stop": True,
                "model": request.model,
                "created_at": datetime.utcnow().isoformat(),
                "content_type": ContentType.ERROR
            }

@app.get("/api/generate")
@app.post("/api/generate")
async def generate(request: Request, request_data: GenerateRequest = None):
    """Endpoint that streams responses from Ollama with proper formatting for React"""
    try:
        # Handle GET requests with query parameters
        if request.method == "GET":
            query_params = dict(request.query_params)
            try:
                if 'data' in query_params:
                    request_data = GenerateRequest(**json.loads(query_params['data']))
                else:
                    request_data = GenerateRequest(**query_params)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Invalid request parameters: {str(e)}")
        
        # Handle POST requests with JSON body
        elif request.method == "POST":
            if not request_data:
                body = await request.body()
                try:
                    request_data = GenerateRequest(**json.loads(body))
                except Exception as e:
                    raise HTTPException(status_code=400, detail=f"Invalid request body: {str(e)}")
        
        logger.info(f"Received generate request (model: {request_data.model}, prompt length: {len(request_data.prompt)})")
        
        async def event_generator():
            async for chunk in generate_stream(request_data):
                # Ensure the data is properly serialized for SSE
                yield {
                    "event": "message",
                    "data": json.dumps(chunk)
                }
            yield {"event": "end", "data": json.dumps({"status": "completed"})}
        
        return EventSourceResponse(
            event_generator(),
            ping=20,  # Keep connection alive with ping every 20 seconds
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type"
            }
        )
    except Exception as e:
        logger.error(f"Error in generate endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/generate-sync", response_model=ChatResponse)
async def generate_sync(request_data: GenerateRequest):
    """Non-streaming endpoint for synchronous responses with formatting"""
    if request_data.stream:
        raise HTTPException(
            status_code=400,
            detail="Use /api/generate for streaming requests"
        )
    
    try:
        logger.info(f"Received sync generate request (model: {request_data.model})")
        
        # Build the request data
        data = {
            "model": request_data.model,
            "prompt": request_data.prompt,
            "stream": False,
            "options": {
                "temperature": request_data.temperature,
                "num_predict": request_data.max_tokens
            }
        }
        
        if request_data.format:
            data["format"] = request_data.format
        
        if request_data.history:
            # Format history as required by Ollama API
            messages = []
            for msg in request_data.history:
                messages.append({"role": msg.role, "content": msg.content})
            data["messages"] = messages
        
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                f"{OLLAMA_BASE_URL}/api/generate",
                json=data,
                timeout=TIMEOUT
            )
            response.raise_for_status()
            result = response.json()
            
            # Process the complete response for formatting
            content = result.get("response", "")
            detection = await detect_content_type(content, {})
            
            return {
                "content": content,
                "stop": True,
                "model": request_data.model,
                "content_type": detection["content_type"],
                "language": detection.get("language"),
                "list_type": detection.get("list_type"),
                "formatting": detection.get("formatting"),
                "created_at": datetime.utcnow().isoformat(),
                "metrics": result.get("metrics")
            }
    except httpx.RequestError as e:
        logger.error(f"Ollama request error: {str(e)}")
        raise HTTPException(status_code=502, detail=f"Error connecting to Ollama: {str(e)}")
    except Exception as e:
        logger.error(f"Error in generate-sync endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/models")
async def get_models():
    """Get available models from Ollama with enhanced information"""
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
            response.raise_for_status()
            data = response.json()
            
            models = []
            for model in data.get("models", []):
                details = {
                    "name": model["name"],
                    "modified_at": model.get("modified_at", ""),
                    "size": model.get("size", 0),
                    "digest": model.get("digest", ""),
                    "details": model.get("details", {}),
                    "parameters": f"{model.get('details', {}).get('parameter_size', '?')}B",
                    "quantization": model.get("details", {}).get("quantization_level", "unknown")
                }
                models.append(details)
            
            return {"models": sorted(models, key=lambda x: x["name"])}
    except httpx.RequestError as e:
        logger.error(f"Error connecting to Ollama: {str(e)}")
        raise HTTPException(status_code=502, detail=f"Error connecting to Ollama: {str(e)}")
    except Exception as e:
        logger.error(f"Error in get_models endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/model/{model_name}")
async def get_model_details(model_name: str):
    """Get detailed information about a specific model"""
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            # First check if the model exists
            response = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
            response.raise_for_status()
            models_data = response.json()
            
            model_exists = any(m["name"] == model_name for m in models_data.get("models", []))
            if not model_exists:
                raise HTTPException(status_code=404, detail="Model not found")
            
            # Get model details by making a dummy request
            dummy_response = await client.post(
                f"{OLLAMA_BASE_URL}/api/generate",
                json={
                    "model": model_name,
                    "prompt": "Hello",
                    "stream": False
                }
            )
            dummy_response.raise_for_status()
            details = dummy_response.json()
            
            return {
                "name": model_name,
                "parameters": details.get("params"),
                "template": details.get("template"),
                "modelfile": details.get("modelfile"),
                "license": details.get("license")
            }
    except httpx.RequestError as e:
        logger.error(f"Error connecting to Ollama: {str(e)}")
        raise HTTPException(status_code=502, detail=f"Error connecting to Ollama: {str(e)}")
    except Exception as e:
        logger.error(f"Error in get_model_details endpoint: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/health")
async def health_check():
    """Health check endpoint with system status"""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            # Check Ollama connection
            ollama_response = await client.get(f"{OLLAMA_BASE_URL}/api/tags")
            ollama_response.raise_for_status()
            
            # Get system information
            system_info = {
                "platform": os.name,
                "cpus": os.cpu_count(),
                "ollama_version": ollama_response.headers.get("ollama-version", "unknown")
            }
            
            return {
                "status": "healthy",
                "ollama": "connected",
                "timestamp": datetime.utcnow().isoformat(),
                "version": "1.0.0",
                "system": system_info
            }
    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        return {
            "status": "unhealthy",
            "ollama": "disconnected",
            "error": str(e),
            "timestamp": datetime.utcnow().isoformat()
        }

@app.get("/")
async def root():
    """Root endpoint with API information"""
    return {
        "name": "Chat API",
        "description": "API for streaming chat responses from Ollama",
        "version": "1.0.0",
        "endpoints": {
            "streaming_chat": "/api/generate",
            "sync_chat": "/api/generate-sync",
            "list_models": "/api/models",
            "model_details": "/api/model/{model_name}",
            "health_check": "/api/health"
        },
        "documentation": {
            "swagger": "/api/docs",
            "redoc": "/api/redoc"
        }
    }

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=9693,
        reload=True,
        workers=2,
        limit_concurrency=100,
        timeout_keep_alive=30,
        log_level="info"
    )
