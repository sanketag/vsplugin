import asyncio
import hashlib
import logging
from typing import Dict, Generator, Optional, List, Any

import psutil
import redis
# Local imports
from exceptions import ModelOverloadError, ValidationError
from fastapi import HTTPException

# Constants
CODING_STANDARDS = """
# Airflow Coding Standards

## DAG Structure
1. **Imports**: Group in this order:
   - Python standard library
   - Core Airflow
   - Other providers
   - Local modules

2. **Default Arguments**:
```python
default_args = {
    'owner': 'team_name',
    'retries': 3,
    'retry_delay': timedelta(minutes=5),
    'sla': timedelta(hours=1)
}
```

## Task Naming
- Use `snake_case`
- Format: `{module}_{action}`  
  Example: `data_validation_check`

## Error Handling
- Always set `retries` and `sla`
- Use `PythonOperator` only with `@task` decorator
- Log exceptions with context

## Performance
- Avoid XCom for large data (>10KB)
- Use `template_searchpath` for common SQL
- Set `pool` for resource-intensive tasks
"""

logger = logging.getLogger("CodeAssistAPI")


def build_completion_prompt(prompt: str, context: str) -> str:
    """Construct LLM prompt with standards"""
    return f"""**[Airflow Coding Standards]**
{CODING_STANDARDS}

**[Existing Code Context]**
{context}

**[Code Completion]**
{prompt}"""


def build_review_prompt(code: str, lang: str) -> str:
    """Construct prompt for code review"""
    return f"""**[Code Review Task]**
Analyze the following {lang} code for issues related to style, performance, and best practices.
Focus on Airflow standards if relevant.

**[Airflow Coding Standards]**
{CODING_STANDARDS}

**[Code to Review]**
```{lang}
{code}
```

Identify issues using the following format:
- line_start: <line number>
- line_end: <line number>
- severity: <"high", "medium", "low">
- type: <"standard", "performance", "security">
- description: <detailed explanation of the issue>
"""


def build_optimization_prompt(code: str, related_code: str) -> str:
    """Construct prompt for code optimization"""
    return f"""**[Code Optimization Task]**
Optimize the following code for better performance, readability, and adherence to Airflow standards.

**[Airflow Coding Standards]**
{CODING_STANDARDS}

**[Code to Optimize]**
```python
{code}
```

**[Related Code Context]**
```python
{related_code}
```

Provide optimized code with explanations of improvements.
"""


def generate_cache_key(*args) -> str:
    """Generate consistent cache key"""
    return hashlib.sha256("".join(str(arg) for arg in args).encode()).hexdigest()[:32]


async def get_cached(cache: redis.Redis, key: str) -> Optional[str]:
    """Retrieve from Redis with timeout"""
    try:
        result = await asyncio.wait_for(
            asyncio.to_thread(cache.get, key),
            timeout=0.01
        )
        if result:
            return result.decode('utf-8')
        return None
    except (redis.TimeoutError, asyncio.TimeoutError):
        return None


async def cache_result(cache: redis.Redis, key: str, value: Any, ttl: int = 3600):
    """Store result with TTL if memory available"""
    mem_info = psutil.virtual_memory()
    if mem_info.available > 10 * 1024 ** 3:  # 10GB free
        if isinstance(value, (dict, list)):
            import json
            value = json.dumps(value)
        await asyncio.to_thread(cache.setex, key, ttl, value)


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


# Helper functions
async def get_relevant_context(vector_store, prompt: str) -> str:
    """Retrieve context from vector store"""
    try:
        # Get similar code snippets
        results = await asyncio.to_thread(
            vector_store.search,
            query=prompt,
            k=3
        )

        # Concatenate relevant context
        context = "\n".join([doc['content'] for doc in results])

        # For the MVP, we're just truncating rather than tokenizing
        return context[:8000]  # Approximate limit to fit context window

    except Exception as e:
        logger.error(f"Context retrieval failed: {str(e)}")
        return ""


async def get_related_code(vector_store, code: str, context_files: List[str]) -> str:
    """Get related code from vector store based on specific files"""
    results = []

    for file in context_files:
        file_results = await asyncio.to_thread(
            vector_store.search,
            query=code,
            k=1,
            file_filter=file
        )
        results.extend(file_results)

    return "\n\n".join([doc['content'] for doc in results])


def parse_review_result(result: str) -> List[Dict]:
    """Parse LLM response into structured issues"""
    # This is a simplified parser - a real implementation would need more robust parsing
    issues = []

    # Simple regex-like parsing for demonstration
    lines = result.split('\n')
    current_issue = {}

    for line in lines:
        line = line.strip()
        if not line:
            continue

        if line.startswith('- line_start:'):
            # Start a new issue
            if current_issue and 'line_start' in current_issue:
                issues.append(current_issue)
                current_issue = {}

            try:
                current_issue['line_start'] = int(line.split(':')[1].strip())
            except:
                current_issue['line_start'] = 0

        elif line.startswith('- line_end:'):
            try:
                current_issue['line_end'] = int(line.split(':')[1].strip())
            except:
                current_issue['line_end'] = current_issue.get('line_start', 0)

        elif line.startswith('- severity:'):
            current_issue['severity'] = line.split(':')[1].strip().lower()

        elif line.startswith('- type:'):
            current_issue['type'] = line.split(':')[1].strip().lower()

        elif line.startswith('- description:'):
            current_issue['description'] = line.split(':', 1)[1].strip()

    # Add the last issue if exists
    if current_issue and 'line_start' in current_issue:
        issues.append(current_issue)

    # Ensure all issues have the required fields
    valid_issues = []
    for issue in issues:
        if all(k in issue for k in ['line_start', 'line_end', 'severity', 'type', 'description']):
            valid_issues.append(issue)

    return valid_issues


async def cache_stream(cache: redis.Redis, key: str, generator: Generator[str, None, None]) -> Generator[
    str, None, None]:
    """Cache streaming response while yielding it"""
    collected = []

    for chunk in generator:
        collected.append(chunk)
        yield chunk

    # Cache the full response
    full_response = "".join(collected)
    if full_response:
        await cache_result(cache, key, full_response)


def generate_metrics() -> str:
    """Generate Prometheus metrics"""
    metrics = []

    # Memory usage metrics
    mem = psutil.virtual_memory()
    metrics.append(f'memory_usage_bytes {mem.used}')
    metrics.append(f'memory_usage_percent {mem.percent}')

    # CPU metrics
    cpu_percent = psutil.cpu_percent(interval=0.1)
    metrics.append(f'cpu_usage_percent {cpu_percent}')

    return "\n".join(metrics)
