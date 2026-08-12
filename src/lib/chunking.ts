// Paragraph-aware chunking: packs whole paragraphs up to maxChars, carrying
// a small overlap into the next chunk so a fact split across a chunk
// boundary is still findable from either side. A paragraph longer than
// maxChars on its own is hard-split, since no chunk can ever exceed the
// embedding input budget regardless of source formatting.
export function chunkText(text: string, maxChars = 2000, overlapChars = 200): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
  };

  for (const paragraph of paragraphs) {
    let remaining = paragraph;

    while (remaining.length > maxChars) {
      if (current) {
        flush();
        current = "";
      }
      chunks.push(remaining.slice(0, maxChars));
      remaining = remaining.slice(maxChars - overlapChars);
    }

    if (current.length + remaining.length + 2 > maxChars && current) {
      flush();
      current = current.slice(Math.max(0, current.length - overlapChars));
    }
    current = current ? current + "\n\n" + remaining : remaining;
  }

  flush();
  return chunks;
}
