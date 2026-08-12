// Heuristic PII masking for anything that might end up in logs (never in
// stored conversation content — that has to stay readable to be useful).
// Regex-based, not a real PII classifier: catches the common, unambiguous
// patterns (email, phone, card-like digit runs) and nothing subtler
// (names, addresses). Good enough to keep obvious PII out of Workers Logs;
// not a compliance-grade redaction guarantee.
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

export function redactPii(text: string): string {
  return text
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(CARD_RE, "[redacted-number]")
    .replace(PHONE_RE, "[redacted-phone]");
}
