import type { ItemKind, LoginResponse, PublicShare, ShareLink, StorageStats, VaultItem } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

async function parseError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    return body.detail ?? response.statusText;
  } catch {
    return response.statusText;
  }
}

export async function apiFetch<T>(
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

export async function login(username: string, password: string): Promise<LoginResponse> {
  const response = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return response.json() as Promise<LoginResponse>;
}

export function listItems(token: string, kind: ItemKind, query: string): Promise<VaultItem[]> {
  const params = new URLSearchParams({ kind, q: query });
  return apiFetch<VaultItem[]>(`/api/items?${params.toString()}`, token);
}

export function getStorageStats(token: string): Promise<StorageStats> {
  return apiFetch<StorageStats>("/api/storage", token);
}

export function createItem(
  token: string,
  formData: FormData,
  onProgress?: (percent: number) => void
): Promise<VaultItem> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${API_BASE}/api/items`);
    request.setRequestHeader("Authorization", `Bearer ${token}`);

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    };

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress?.(100);
        resolve(JSON.parse(request.responseText) as VaultItem);
        return;
      }
      try {
        const body = JSON.parse(request.responseText) as { detail?: string };
        reject(new Error(body.detail ?? request.statusText));
      } catch {
        reject(new Error(request.statusText || "저장 실패"));
      }
    };

    request.onerror = () => reject(new Error("네트워크 오류"));
    request.send(formData);
  });
}

export function deleteItem(token: string, id: number): Promise<void> {
  return apiFetch<void>(`/api/items/${id}`, token, { method: "DELETE" });
}

export function createShare(token: string, id: number, expiresDays: number): Promise<ShareLink> {
  const params = new URLSearchParams({ expires_days: String(expiresDays) });
  return apiFetch<ShareLink>(`/api/items/${id}/shares?${params.toString()}`, token, { method: "POST" });
}

export async function getPublicShare(token: string): Promise<PublicShare> {
  const response = await fetch(`${API_BASE}/api/public/shares/${encodeURIComponent(token)}`);
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  return response.json() as Promise<PublicShare>;
}

export async function downloadItem(token: string, item: VaultItem): Promise<void> {
  const response = await fetch(`${API_BASE}/api/items/${item.id}/download`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(await parseError(response));
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = item.original_filename ?? item.title;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}
