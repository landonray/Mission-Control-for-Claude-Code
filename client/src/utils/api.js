const BASE_URL = '';
const AUTH_TOKEN = import.meta.env.VITE_MC_AUTH_TOKEN;

async function request(method, url, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  }

  const options = {
    method,
    headers,
    cache: 'no-store',
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE_URL}${url}`, options);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body),
  put: (url, body) => request('PUT', url, body),
  delete: (url) => request('DELETE', url),
  uploadFiles: async (files) => {
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }
    const uploadHeaders = {};
    if (AUTH_TOKEN) {
      uploadHeaders['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    }
    const response = await fetch(`${BASE_URL}/api/uploads`, {
      method: 'POST',
      headers: uploadHeaders,
      body: formData,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || 'Upload failed');
    }
    return response.json();
  },
};
