"""
Custom exceptions for the API
"""


class ModelOverloadError(Exception):
    """Raised when the model resources are unavailable"""
    pass


class ValidationError(Exception):
    """Raised when validation fails"""
    pass
