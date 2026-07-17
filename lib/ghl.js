// GHL API client — thin wrapper so all requests share auth headers
// and we have one place to update the base URL or version header.

const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

export async function ghlRequest(method, path, { body, params, token } = {}) {
  if (!token) throw new Error('ghlRequest: token is required — pass the calling client\'s decrypted GHL token');

  const url = new URL(`${BASE_URL}${path}`);

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, value);
    });
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Version': API_VERSION,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return { status: response.status, ok: response.ok, data };
}
