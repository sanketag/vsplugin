"""
FAISS-based vector store for code retrieval with:
- Automatic chunking
- Language-aware parsing
- File-based filtering
"""

import os
from typing import List, Optional, Dict, Any

from langchain_community.document_loaders import DirectoryLoader
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import FAISS
from langchain_text_splitters import Language, RecursiveCharacterTextSplitter


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
        """Create new index with improved chunking"""
        loader = DirectoryLoader(
            self.code_dir,
            glob="**/*.py",
            recursive=True,
            loader_kwargs={'autodetect_encoding': True}
        )
        documents = loader.load()

        # Improved splitting for Python code
        splitter = RecursiveCharacterTextSplitter.from_language(
            language=Language.PYTHON,
            chunk_size=300,  # Smaller chunks for better precision
            chunk_overlap=100,
            add_start_index=True,
            separators=[
                '\nclass ', '\ndef ', '\n\tdef ', '\n\n', '\n',
                ' ', ''  # Fallback separators
            ]
        )

        chunks = splitter.split_documents(documents)

        # Filter out very small chunks
        chunks = [chunk for chunk in chunks if len(chunk.page_content) > 50]

        index = FAISS.from_documents(chunks, self.embeddings)
        index.save_local(self.index_path)
        return index

    def search(
            self,
            query: str,
            k: int = 3,
            file_filter: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Search for relevant code snippets
        Args:
            query: Search query
            k: Number of results
            file_filter: Directory prefix to filter
        Returns:
            List of relevant documents with metadata
        """
        docs_with_scores = self.index.similarity_search_with_score(query, k=k)

        results = []
        for doc, score in docs_with_scores:
            if file_filter and not doc.metadata['source'].startswith(file_filter):
                continue

            results.append({
                'content': doc.page_content,
                'path': doc.metadata['source'],
                'score': float(score)
            })

        return results

    def update_index(self):
        """Refresh index with new code"""
        self.index = self._create_new_index()
