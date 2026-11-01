import { config } from "./config";

/**
 * OAuth authorization-code flow with PKCE. The proxy's confidential-client
 * helper adds the client secret to code and refresh exchanges; tokens are
 * returned to and persisted by the browser.
 *
 * localStorage is a research placeholder: the persistence and protection
 * mechanism is still an open question (see README).
 */

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds; absent for non-expiring tokens (GitHub OAuth Apps). */
  expiresAt?: number;
  refreshExpiresAt?: number;
  scope?: string;
}

interface PendingSignIn {
  state: string;
  verifier: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number | string;
  refresh_token_expires_in?: number | string;
  scope?: string;
}

/** The provider rejected the grant; the user must sign in again. */
export class ReauthenticationRequired extends Error {}

const TOKENS_KEY = `bgit.oauth.${config.oauthClient}.tokens`;
const PENDING_KEY = `bgit.oauth.${config.oauthClient}.pending`;
const REFRESH_MARGIN_MS = 60_000;
const listeners = new Set<(tokens: Tokens | null) => void>();

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function loadTokens(): Tokens | null {
  const raw = localStorage.getItem(TOKENS_KEY);
  return raw ? (JSON.parse(raw) as Tokens) : null;
}

function saveTokens(tokens: Tokens | null): void {
  if (tokens) localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  else localStorage.removeItem(TOKENS_KEY);
  listeners.forEach((listener) => listener(tokens));
}

export function onTokensChanged(listener: (tokens: Tokens | null) => void): void {
  listeners.add(listener);
}

window.addEventListener("storage", (event) => {
  if (event.key === TOKENS_KEY) listeners.forEach((listener) => listener(loadTokens()));
});

export function signOut(): void {
  saveTokens(null);
}

export async function signIn(): Promise<void> {
  if (!config.oauthClientId) throw new Error("VITE_OAUTH_CLIENT_ID is not configured (see .env.example).");
  const pending: PendingSignIn = { state: randomString(), verifier: randomString() };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.verifier));
  sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const url = new URL(config.authorizeUrl);
  url.search = new URLSearchParams({
    client_id: config.oauthClientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    state: pending.state,
    code_challenge: base64url(new Uint8Array(digest)),
    code_challenge_method: "S256",
    ...(config.scope ? { scope: config.scope } : {}),
  }).toString();
  location.assign(url);
}

/** Completes a redirect back to /oauth/callback; returns false on other pages. */
export async function completeSignIn(): Promise<boolean> {
  const callback = new URL(config.redirectUri);
  if (location.pathname !== callback.pathname) return false;
  const params = new URLSearchParams(location.search);
  const pendingRaw = sessionStorage.getItem(PENDING_KEY);
  sessionStorage.removeItem(PENDING_KEY);
  // Remove the code from the address bar and history before anything else.
  history.replaceState(null, "", "/");

  const pending = pendingRaw ? (JSON.parse(pendingRaw) as PendingSignIn) : null;
  if (params.get("error")) {
    throw new Error(`Sign-in was not completed: ${params.get("error_description") || params.get("error")}`);
  }
  const code = params.get("code");
  if (!code || !pending || params.get("state") !== pending.state) {
    throw new Error("Sign-in response did not match a pending sign-in; please try again.");
  }
  saveTokens(
    await tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: pending.verifier,
      redirect_uri: config.redirectUri,
    }),
  );
  return true;
}

async function tokenRequest(body: Record<string, string>, previous?: Tokens): Promise<Tokens> {
  const response = await fetch(`${config.proxyUrl}/oauth/${config.oauthClient}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
  });
  const result = (await response.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
  if (response.status === 400) throw new ReauthenticationRequired(`Token request rejected: ${result.error}`);
  if (!response.ok || !result.access_token) {
    throw new Error(`Token endpoint unavailable (HTTP ${response.status}${result.error ? `, ${result.error}` : ""})`);
  }
  const now = Date.now();
  return {
    accessToken: result.access_token,
    // Some providers omit a rotated refresh token; keep the previous one then.
    refreshToken: result.refresh_token || previous?.refreshToken,
    expiresAt: result.expires_in ? now + Number(result.expires_in) * 1000 : undefined,
    refreshExpiresAt: result.refresh_token_expires_in
      ? now + Number(result.refresh_token_expires_in) * 1000
      : previous?.refreshExpiresAt,
    scope: result.scope,
  };
}

/**
 * Refreshes at most once at a time across tabs: providers such as GitHub
 * invalidate the previous refresh token after a successful refresh.
 */
async function refresh(stale: Tokens): Promise<Tokens> {
  return navigator.locks.request(`bgit-oauth-refresh-${config.oauthClient}`, async () => {
    const current = loadTokens();
    if (!current) throw new ReauthenticationRequired("Signed out");
    if (current.accessToken !== stale.accessToken) return current; // Another tab refreshed.
    if (!current.refreshToken) {
      saveTokens(null);
      throw new ReauthenticationRequired("Access token expired and cannot be refreshed");
    }
    try {
      const next = await tokenRequest({ grant_type: "refresh_token", refresh_token: current.refreshToken }, current);
      saveTokens(next);
      return next;
    } catch (error) {
      // Only discard credentials the provider rejected; keep them on network errors.
      if (error instanceof ReauthenticationRequired) saveTokens(null);
      throw error;
    }
  });
}

/** Returns a valid access token, refreshing it shortly before expiry. */
export async function getAccessToken(): Promise<string> {
  const tokens = loadTokens();
  if (!tokens) throw new ReauthenticationRequired("Not signed in");
  if (tokens.expiresAt && Date.now() > tokens.expiresAt - REFRESH_MARGIN_MS) {
    return (await refresh(tokens)).accessToken;
  }
  return tokens.accessToken;
}

/** Called after the Git host rejected a token; returns a new token if one could be obtained. */
export async function recoverFromRejectedToken(rejected: string): Promise<string | null> {
  const tokens = loadTokens();
  if (!tokens) return null;
  if (tokens.accessToken !== rejected) return tokens.accessToken;
  if (!tokens.refreshToken) {
    saveTokens(null);
    return null;
  }
  try {
    return (await refresh(tokens)).accessToken;
  } catch (error) {
    if (error instanceof ReauthenticationRequired) return null;
    throw error;
  }
}
