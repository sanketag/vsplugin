"""
FAISS-based vector store for code retrieval with:
- Automatic chunking
- Language-aware parsing
- File-based filtering
"""

from langchain.text_splitter import Language
from langchain_community.document_loaders import DirectoryLoader
from langchain_text_splitters import LanguageParser
from langchain_community.vectorstores import FAISS
from langchain.embeddings import HuggingFaceEmbeddings
from typing import List, Optional
import os

class CodeVectorStore:
    def __init__(self, index_path: str, code_dir: str):
        self.index_path = index_path
        self.code_dir = code_dir
        self.embeddings = HuggingFaceEmbeddings(
            model_name="all-MiniLM-L6-v2",
            model_kwargs={'device': 'cpu'}
        )
        self.index = self._load_or_create_index()

    def _load_or_create_index(self):
        """Load existing index or create new one"""
        if os.path.exists(self.index_path):
            return FAISS.load_local(
                self.index_path,
                self.embeddings,
                allow_dangerous_deserialization=True
            )
        return self._create_new_index()

    def _create_new_index(self):
        """Create new index from codebase"""
        loader = DirectoryLoader(
            self.code_dir,
            glob="**/*.py",
            recursive=True
        )
        documents = loader.load()

        splitter = LanguageParser(
            language=Language.PYTHON,
            parser_threshold=500
        )
        chunks = splitter.split_documents(documents)

        index = FAISS.from_documents(chunks, self.embeddings)
        index.save_local(self.index_path)
        return index

    def search(
        self,
        query: str,
        k: int = 3,
        file_filter: Optional[str] = None
    ) -> List[dict]:
        """
        Search for relevant code snippets
        Args:
            query: Search query
            k: Number of results
            file_filter: Directory prefix to filter
        Returns:
            List of relevant documents with metadata
        """
        docs = self.index.similarity_search(query, k=k)
        
        if file_filter:
            docs = [
                doc for doc in docs
                if doc.metadata['source'].startswith(file_filter)
            ]
        
        return [{
            'content': doc.page_content,
            'path': doc.metadata['source'],
            'score': doc.metadata.get('score', 0)
        } for doc in docs]

    def update_index(self):
        """Refresh index with new code"""
        self.index = self._create_new_index()
