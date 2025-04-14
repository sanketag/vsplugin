"""
Custom exceptions for the API
"""


class ModelOverloadError(Exception):
    """Raised when the model resources are unavailable"""
    pass


class ValidationError(Exception):
    """Raised when validation fails"""
    pass


class RateLimitError(Exception):
    """Raised when rate limits are exceeded"""
    pass


class CodeAnalysisError(Exception):
    """Raised when code analysis fails"""
    pass
