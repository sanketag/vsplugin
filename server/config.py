from pydantic import BaseSettings


class Settings(BaseSettings):
    redis_host: str = "localhost"
    redis_port: int = 6379
    model_name: str = "qwen2.5-coder:1.5b"
    num_threads: int = 6
    codebase_dir: str = "/u01/pytn/poc/aidi/dev/dags"

    class Config:
        env_file = ".env"


settings = Settings()
