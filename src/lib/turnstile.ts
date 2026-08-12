interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

// Verifies a Turnstile token server-side. If TURNSTILE_SECRET_KEY is unset
// (local dev without a real Cloudflare-issued widget), verification is
// skipped — see the caller for where that boundary is enforced per
// environment.
export async function verifyTurnstileToken(
  secretKey: string,
  token: string,
  remoteIp?: string,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const body = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) return false;

  const data = (await res.json()) as SiteverifyResponse;
  return data.success === true;
}
