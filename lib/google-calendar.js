// Google OAuth + Calendar API client — thin fetch wrapper, same style as lib/ghl.js.
// No googleapis dependency; the OAuth token endpoint and Calendar REST API are
// simple enough to call directly.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is not set`);
  return value;
}

function redirectUri() {
  const base = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return `${base}/api/settings/google/callback`;
}

// state carries the GHL locationId through the OAuth round trip so the callback
// knows which Client row to save tokens on — same trust model as the rest of
// this app (location_id is already treated as the bearer identifier everywhere,
// there's no session layer to sign it against).
export function getAuthUrl(locationId) {
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', requireEnv('GOOGLE_CLIENT_ID'));
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'https://www.googleapis.com/auth/calendar.events');
  url.searchParams.set('access_type', 'offline');
  // Forces Google to return a refresh_token even if this business connected
  // before — without this, reconnecting after a disconnect silently omits it.
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', locationId);
  return url.toString();
}

export async function exchangeCodeForTokens(code) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: requireEnv('GOOGLE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data; // { access_token, refresh_token, expires_in, ... }
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: requireEnv('GOOGLE_CLIENT_ID'),
      client_secret: requireEnv('GOOGLE_CLIENT_SECRET'),
      grant_type: 'refresh_token',
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Google token refresh failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data; // { access_token, expires_in, ... } — no new refresh_token issued
}

export async function getUserEmail(accessToken) {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const data = await response.json();
  return data.email ?? null;
}

// Returns a currently-valid access token for this client, refreshing and
// persisting a new one first if the stored one has expired. Callers pass in
// the already-decrypted refresh token plus a save callback so this module
// stays free of any db/crypto imports (kept in lib/google-calendar-sync.js).
export async function getValidAccessToken({ accessToken, refreshToken, expiry, onRefreshed }) {
  const expiresSoon = !expiry || new Date(expiry).getTime() - Date.now() < 60_000;
  if (!expiresSoon) return accessToken;

  const refreshed = await refreshAccessToken(refreshToken);
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000);
  await onRefreshed({ accessToken: refreshed.access_token, expiry: newExpiry });
  return refreshed.access_token;
}

export async function createCalendarEvent({ accessToken, summary, description, startDateTime, endDateTime, timeZone }) {
  const response = await fetch(`${CALENDAR_API}/calendars/primary/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: startDateTime, timeZone },
      end: { dateTime: endDateTime, timeZone },
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Google Calendar event create failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data; // includes .id
}
