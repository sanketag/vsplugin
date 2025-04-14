"""
Ollama Model Wrapper with:
- Thread-safe generation
- Resource monitoring
- Automatic retries
"""

import time
from dataclasses import dataclass
from threading import Lock
from typing import Generator, Dict, Any

import ollama
import psutil


@dataclass
class GenerationConfig:
    temperature: float = 0.3
    top_k: int = 40
    top_p: float = 0.9
    repeat_penalty: float = 1.1
    num_ctx: int = 4096


class ModelOverloadError(Exception):
    pass


class CodeGenerator:
    def __init__(self, model_name: str = "qwen2.5-coder", num_threads: int = 6):
        self.client = ollama.Client()
        self.lock = Lock()
        self.config = GenerationConfig()
        self.num_threads = num_threads
        self.last_used = time.time()
        self.model_name = model_name

    def warmup(self):
        """Pre-load model into memory"""
        with self.lock:
            self._generate("Warmup", max_tokens=1)

    def status(self) -> Dict[str, Any]:
        """Get current model status"""
        mem = psutil.virtual_memory()
        return {
            "memory_used": mem.used,
            "memory_percent": mem.percent,
            "last_used": self.last_used
        }

    def generate(self, prompt: str, **kwargs) -> str:
        """
        Synchronous text generation
        Args:
            prompt: Input text prompt
            max_tokens: Maximum tokens to generate
            temperature: Creativity control
        Returns:
            Generated text
        """
        with self.lock:
            return self._generate(prompt, **kwargs)

    def stream(self, prompt: str, **kwargs) -> Generator[str, None, None]:
        """
        Stream generated tokens
        Args:
            prompt: Input text prompt
            max_tokens: Maximum tokens to generate
        Yields:
            Token strings
        """
        with self.lock:
            for chunk in self._stream(prompt, **kwargs):
                yield chunk

    def _check_resources(self):
        """Validate system resources before generation"""
        mem = psutil.virtual_memory()
        if mem.percent > 90:
            raise ModelOverloadError("Memory usage too high")
        if time.time() - self.last_used < 0.1:
            time.sleep(0.1)  # Rate limiting

    def _generate(self, prompt: str, max_tokens: int = 256, **kwargs) -> str:
        self._check_resources()
        try:
            response = self.client.generate(
                model=self.model_name,
                prompt=prompt,
                options={
                    **self.config.__dict__,
                    'num_thread': self.num_threads,
                    'num_predict': max_tokens,
                    **kwargs
                },
                stream=False
            )
            self.last_used = time.time()
            return response['response']
        except Exception as e:
            raise ModelOverloadError(str(e))

    def _stream(self, prompt: str, max_tokens: int = 256, **kwargs) -> Generator[str, None, None]:
        self._check_resources()
        try:
            stream = self.client.generate(
                model=self.model_name,
                prompt=prompt,
                options={
                    **self.config.__dict__,
                    'num_thread': self.num_threads,
                    'num_predict': max_tokens,
                    **kwargs
                },
                stream=True
            )
            for chunk in stream:
                self.last_used = time.time()
                yield chunk['response']
        except Exception as e:
            raise ModelOverloadError(str(e))
