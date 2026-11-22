from langchain_text_splitters import RecursiveCharacterTextSplitter


text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=150,
    separators=["\n\n", "\n", ". ", " ", ""]
)


def split_text(text: str):
    if not text or not text.strip():
        return []
    chunks = text_splitter.split_text(text)
    return [c.strip() for c in chunks if c.strip()]