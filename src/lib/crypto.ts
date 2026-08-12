// SHA-256 hex digest, used so raw API keys are never stored or logged —
// only their hash is persisted in api_keys.key_hash.
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
