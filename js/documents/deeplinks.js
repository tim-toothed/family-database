export const DOCUMENT_SNIPPET_RE = /\[\[doc:([A-Za-z0-9_-]+)\|(\d+)\|(\d+)(?:\|([A-Za-z0-9_-]+))?\]\]/giu;

export function buildDocumentSnippet({ documentId, start, end, headingId = '' }) {
  const safeDocumentId = String(documentId || '').trim();
  const safeStart = Number(start);
  const safeEnd = Number(end);
  const safeHeadingId = String(headingId || '').trim();

  if (!safeDocumentId || !Number.isFinite(safeStart) || !Number.isFinite(safeEnd) || safeEnd <= safeStart) {
    return '';
  }

  return safeHeadingId
    ? `[[doc:${safeDocumentId}|${safeStart}|${safeEnd}|${safeHeadingId}]]`
    : `[[doc:${safeDocumentId}|${safeStart}|${safeEnd}]]`;
}

export function parseDocumentSnippet(value) {
  const match = String(value || '').trim().match(/^\[\[doc:([A-Za-z0-9_-]+)\|(\d+)\|(\d+)(?:\|([A-Za-z0-9_-]+))?\]\]$/iu);
  if (!match) return null;

  return {
    documentId: match[1],
    start: Number(match[2]),
    end: Number(match[3]),
    headingId: match[4] || '',
  };
}

export function buildDocumentHref({ documentId, start, end, headingId = '' }) {
  const params = new URLSearchParams();
  params.set('doc', String(documentId || '').trim());
  params.set('start', String(Number(start)));
  params.set('end', String(Number(end)));

  const hash = String(headingId || '').trim();
  return `./documents.html?${params.toString()}${hash ? `#${encodeURIComponent(hash)}` : ''}`;
}

export function collectDocumentSnippetTokens(value) {
  const source = String(value || '');
  const matches = [];
  let match;

  DOCUMENT_SNIPPET_RE.lastIndex = 0;
  while ((match = DOCUMENT_SNIPPET_RE.exec(source))) {
    matches.push({
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
      documentId: match[1],
      headingId: match[4] || '',
      rangeStart: Number(match[2]),
      rangeEnd: Number(match[3]),
    });
  }

  return matches;
}
