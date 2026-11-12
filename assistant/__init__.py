"""TechMart product Q&A assistant (catalog-grounded retrieval + LLM)."""
from .assistant import answer
from .catalog import Product, load_catalog
from .query_parser import QueryPlan, parse_query
from .retrieval import retrieve

__all__ = ["answer", "Product", "load_catalog", "QueryPlan", "parse_query", "retrieve"]
