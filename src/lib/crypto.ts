// SHA-256 hex digest, used so raw API keys are never stored or logged —
// only their hash is persisted in api_keys.key_hash.
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 24 random bytes (192 bits), base64url-encoded, prefixed so keys are
// recognizable in logs/UI without revealing anything about their value.
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `sk_live_${base64}`;
}
