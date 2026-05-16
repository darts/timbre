"""Split text into TTS-sized chunks at sentence boundaries."""
from __future__ import annotations

from dataclasses import dataclass

import pysbd

_PYSBD_LANGUAGES = {
    "am", "ar", "bg", "da", "de", "el", "en", "es", "fa", "fr", "hi", "hy",
    "it", "ja", "kk", "mr", "my", "nl", "pl", "ru", "sk", "ur", "zh",
}
_LANGUAGE_NAME_TO_PYSBD = {
    "chinese": "zh",
    "english": "en",
    "french": "fr",
    "german": "de",
    "italian": "it",
    "japanese": "ja",
    "korean": "ko",
    "portuguese": "pt",
    "russian": "ru",
    "spanish": "es",
}


@dataclass
class TextChunk:
    idx: int
    text: str


def chunk_text(
    text: str,
    *,
    language: str = "en",
    target_chars: int = 200,
    max_chars: int = 280,
) -> list[TextChunk]:
    """Sentence-segment then merge until each chunk approaches target_chars,
    hard-splitting at paragraph boundaries (blank lines)."""
    requested_language = (language or "en").lower()
    normalized_language = _LANGUAGE_NAME_TO_PYSBD.get(
        requested_language,
        requested_language,
    )
    segmenter_language = normalized_language if normalized_language in _PYSBD_LANGUAGES else "en"
    try:
        seg = pysbd.Segmenter(language=segmenter_language, clean=False)
    except Exception:  # noqa: BLE001
        seg = pysbd.Segmenter(language="en", clean=False)
    chunks: list[str] = []
    for paragraph in [p for p in text.split("\n\n") if p.strip()]:
        sentences = seg.segment(paragraph.strip())
        buf = ""
        for s in sentences:
            s = s.strip()
            if not s:
                continue
            if not buf:
                buf = s
            elif len(buf) + 1 + len(s) <= max_chars:
                buf = f"{buf} {s}"
            else:
                chunks.append(buf)
                buf = s
            if len(buf) >= target_chars:
                chunks.append(buf)
                buf = ""
        if buf:
            chunks.append(buf)
    return [TextChunk(idx=i, text=t) for i, t in enumerate(chunks)]
