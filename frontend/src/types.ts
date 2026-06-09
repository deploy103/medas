export type ItemKind = "all" | "file" | "link" | "note";

export interface VaultItem {
  id: number;
  kind: Exclude<ItemKind, "all">;
  title: string;
  url: string | null;
  note: string | null;
  tags: string | null;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string;
  updated_at: string | null;
}

export interface ShareLink {
  id: number;
  token: string;
  item_id: number;
  share_url: string;
  download_count: number;
  file_count: number;
  total_size_bytes: number;
  zip_size_bytes: number | null;
  download_all_url: string;
  files: ShareFile[];
  created_at: string;
  expires_at: string | null;
}

export interface ShareFile {
  id: number;
  item_id: number;
  title: string;
  filename: string;
  size_bytes: number;
  mime_type: string | null;
  uploaded_at: string;
  download_count: number;
  download_url: string;
}

export interface PublicShare {
  token: string;
  file_count: number;
  total_size_bytes: number;
  zip_size_bytes: number | null;
  files: ShareFile[];
  shared_at: string;
  expires_at: string | null;
  download_count: number;
  download_all_url: string;
}

export interface StorageStats {
  used_bytes: number;
  quota_bytes: number;
  remaining_bytes: number;
  file_count: number;
  disk_free_bytes: number;
}

export interface LoginResponse {
  access_token: string;
  token_type: "bearer";
  username: string;
}
