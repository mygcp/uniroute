export const SESSION_COOKIE = "uniroute_session";
const SESSION_MAX_AGE = 60 * 60 * 24; // 24 jam

/** Dipakai bila env PASSWORD tidak diset (mode plug & play). */
export const DEFAULT_PASSWORD = "CHANGEME";

let warnedDefaultPassword = false;

const sessions = new Set<string>();

export function createSession(): string {
  const token = crypto.randomUUID();
  sessions.add(token);
  return token;
}

export function isValid(token: string | null | undefined): boolean {
  return !!token && sessions.has(token);
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

export function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  const match = cookie?.match(/(?:^|;\s*)uniroute_session=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Guard untuk route action dan resource loader yang berjalan tanpa root loader.
 * Kembalikan Response 401 jika sesi tidak valid, atau null bila terautentikasi.
 */
export function requireSession(request: Request): Response | null {
  if (!isValid(getSessionToken(request))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export function setSessionCookie(response: Response, token: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.headers.set(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secure}`,
  );
}

export function clearSessionCookie(response: Response): void {
  response.headers.set(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

export function verifyPassword(input: string): boolean {
	const pwd = process.env.PASSWORD?.trim() || DEFAULT_PASSWORD;
	if (!process.env.PASSWORD?.trim() && !warnedDefaultPassword) {
		warnedDefaultPassword = true;
		console.warn(
			"[uniroute] PASSWORD not set — using default 'CHANGEME'. " +
				"Set it in .env for production.",
		);
	}
	if (!input) return false;
	const a = new TextEncoder().encode(input);
	const b = new TextEncoder().encode(pwd);
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}