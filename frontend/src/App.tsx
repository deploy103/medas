import {
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileArchive,
  HardDrive,
  Link as LinkIcon,
  LockKeyhole,
  LogOut,
  Plus,
  Search,
  Share2,
  StickyNote,
  Trash2,
  UploadCloud
} from "lucide-react";
import { FormEvent, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createItem,
  createShare,
  deleteItem,
  downloadItem,
  getPublicShare,
  getStorageStats,
  listItems,
  login
} from "./api";
import type { ItemKind, PublicShare, StorageStats, VaultItem } from "./types";

const TOKEN_KEY = "personal-vault-token";
const USERNAME_KEY = "personal-vault-username";

const filters: Array<{ value: ItemKind; label: string }> = [
  { value: "all", label: "전체" },
  { value: "file", label: "파일" },
  { value: "link", label: "링크" },
  { value: "note", label: "메모" }
];

type SortKey = "newest" | "oldest" | "largest" | "smallest" | "title";

const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: "newest", label: "최신순" },
  { value: "oldest", label: "오래된순" },
  { value: "largest", label: "큰 파일순" },
  { value: "smallest", label: "작은 파일순" },
  { value: "title", label: "이름순" }
];

function formatBytes(bytes: number | null): string {
  if (!bytes) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatDate(value: string | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(new Date(value));
}

function formatRemaining(value: string | null): string {
  if (!value) return "만료 없음";
  const diff = new Date(value).getTime() - Date.now();
  if (diff <= 0) return "만료됨";
  const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
  return `${days}일 남음`;
}

function sortItems(items: VaultItem[], sortKey: SortKey): VaultItem[] {
  return [...items].sort((a, b) => {
    if (sortKey === "oldest") {
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    }
    if (sortKey === "largest") {
      return (b.size_bytes ?? 0) - (a.size_bytes ?? 0);
    }
    if (sortKey === "smallest") {
      return (a.size_bytes ?? 0) - (b.size_bytes ?? 0);
    }
    if (sortKey === "title") {
      return a.title.localeCompare(b.title, "ko");
    }
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

function kindIcon(kind: VaultItem["kind"]) {
  if (kind === "file") return <FileArchive size={18} />;
  if (kind === "link") return <LinkIcon size={18} />;
  return <StickyNote size={18} />;
}

function kindLabel(kind: VaultItem["kind"]): string {
  if (kind === "file") return "파일";
  if (kind === "link") return "링크";
  return "메모";
}

function LoginScreen({
  onLogin
}: {
  onLogin: (token: string, username: string) => void;
}) {
  const [error, setError] = useState("");
  const loginMutation = useMutation({
    mutationFn: (payload: { username: string; password: string }) =>
      login(payload.username, payload.password),
    onSuccess: (result) => {
      localStorage.setItem(TOKEN_KEY, result.access_token);
      localStorage.setItem(USERNAME_KEY, result.username);
      onLogin(result.access_token, result.username);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "로그인 실패")
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const formData = new FormData(event.currentTarget);
    loginMutation.mutate({
      username: String(formData.get("username") ?? ""),
      password: String(formData.get("password") ?? "")
    });
  }

  return (
    <main className="login-layout">
      <form className="login-panel" onSubmit={handleSubmit}>
        <div className="brand-row">
          <span className="brand-mark">
            <LockKeyhole size={24} />
          </span>
          <div>
            <h1>Personal Vault</h1>
            <p>개인 자료실</p>
          </div>
        </div>
        <label>
          아이디
          <input name="username" autoComplete="username" required />
        </label>
        <label>
          비밀번호
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error ? <p className="error-text">{error}</p> : null}
        <button className="primary-button" disabled={loginMutation.isPending}>
          {loginMutation.isPending ? "확인 중" : "로그인"}
        </button>
      </form>
    </main>
  );
}

function PublicShareScreen({ token }: { token: string }) {
  const shareQuery = useQuery({
    queryKey: ["public-share", token],
    queryFn: () => getPublicShare(token),
    retry: false
  });

  const share: PublicShare | undefined = shareQuery.data;

  return (
    <main className="share-layout">
      <section className="share-panel">
        <div className="brand-row">
          <span className="brand-mark">
            <FileArchive size={24} />
          </span>
          <div>
            <h1>Personal Vault</h1>
            <p>공유 파일</p>
          </div>
        </div>

        {shareQuery.isLoading ? <p className="empty-text">파일 정보를 불러오는 중입니다.</p> : null}
        {shareQuery.isError ? (
          <div className="share-error">
            <h2>공유 링크를 열 수 없습니다.</h2>
            <p>{shareQuery.error instanceof Error ? shareQuery.error.message : "링크가 만료되었거나 잘못되었습니다."}</p>
          </div>
        ) : null}

        {share ? (
          <>
            <div className="share-file">
              <span className="kind-badge file">
                <FileArchive size={18} />
                파일
              </span>
              <h2>{share.filename}</h2>
              <p>{share.title}</p>
            </div>

            <dl className="share-meta">
              <div>
                <dt>크기</dt>
                <dd>{formatBytes(share.size_bytes)}</dd>
              </div>
              <div>
                <dt>업로드</dt>
                <dd>{formatDateTime(share.uploaded_at)}</dd>
              </div>
              <div>
                <dt>공유 만료</dt>
                <dd>
                  {formatDate(share.expires_at)} · {formatRemaining(share.expires_at)}
                </dd>
              </div>
            </dl>

            <a className="primary-button share-download" href={share.download_url}>
              <Download size={18} />
              다운로드
            </a>
          </>
        ) : null}
      </section>
    </main>
  );
}

function VaultApp() {
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? "");
  const [username, setUsername] = useState(() => localStorage.getItem(USERNAME_KEY) ?? "");
  const [filter, setFilter] = useState<ItemKind>("all");
  const [query, setQuery] = useState("");
  const [draftKind, setDraftKind] = useState<Exclude<ItemKind, "all">>("file");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [shareExpiresDays, setShareExpiresDays] = useState(7);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState("");

  const itemsQuery = useQuery({
    queryKey: ["items", filter, query],
    queryFn: () => listItems(token, filter, query),
    enabled: Boolean(token)
  });

  const storageQuery = useQuery({
    queryKey: ["storage"],
    queryFn: () => getStorageStats(token),
    enabled: Boolean(token)
  });

  const createMutation = useMutation({
    mutationFn: (formData: FormData) => createItem(token, formData, setUploadProgress),
    onMutate: () => {
      setUploadProgress(0);
    },
    onSuccess: () => {
      formRef.current?.reset();
      setNotice("저장했습니다.");
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["storage"] });
    },
    onError: (err) => setNotice(err instanceof Error ? err.message : "저장 실패"),
    onSettled: () => {
      window.setTimeout(() => setUploadProgress(null), 900);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteItem(token, id),
    onSuccess: () => {
      setNotice("삭제했습니다.");
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["storage"] });
    },
    onError: (err) => setNotice(err instanceof Error ? err.message : "삭제 실패")
  });

  const shareMutation = useMutation({
    mutationFn: (id: number) => createShare(token, id, shareExpiresDays),
    onSuccess: async (share) => {
      setNotice(`공유 링크: ${share.share_url}`);
      try {
        await navigator.clipboard.writeText(share.share_url);
      } catch {
        // Clipboard permissions vary by browser and protocol.
      }
    },
    onError: (err) => setNotice(err instanceof Error ? err.message : "공유 실패")
  });

  function handleLogin(nextToken: string, nextUsername: string) {
    setToken(nextToken);
    setUsername(nextUsername);
  }

  function handleLogout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
    setToken("");
    setUsername("");
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("");
    const formData = new FormData(event.currentTarget);
    formData.set("kind", draftKind);
    if (draftKind !== "file") {
      formData.delete("file");
    }
    createMutation.mutate(formData);
  }

  async function handleDownload(item: VaultItem) {
    try {
      await downloadItem(token, item);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "다운로드 실패");
    }
  }

  const rawItems = itemsQuery.data ?? [];
  const items = useMemo(() => sortItems(rawItems, sortKey), [rawItems, sortKey]);
  const storage: StorageStats | undefined = storageQuery.data;
  const fileCount = items.filter((item) => item.kind === "file").length;
  const linkCount = items.filter((item) => item.kind === "link").length;
  const noteCount = items.filter((item) => item.kind === "note").length;
  const usedPercent =
    storage && storage.quota_bytes > 0 ? Math.min(100, Math.round((storage.used_bytes / storage.quota_bytes) * 100)) : 0;

  if (!token) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-row">
          <span className="brand-mark">
            <FileArchive size={23} />
          </span>
          <div>
            <h1>Personal Vault</h1>
            <p>{username}</p>
          </div>
        </div>
        <div className="top-stats">
          <span>파일 {fileCount}</span>
          <span>링크 {linkCount}</span>
          <span>메모 {noteCount}</span>
          {storage ? <span>남은 용량 {formatBytes(storage.remaining_bytes)}</span> : null}
        </div>
        <button className="icon-button" onClick={handleLogout} title="로그아웃">
          <LogOut size={18} />
        </button>
      </header>

      <section className="workspace">
        <aside className="create-panel">
          <div className="section-head">
            <h2>새 자료</h2>
            <span>{createMutation.isPending ? "저장 중" : "대기"}</span>
          </div>

          <div className="kind-tabs" role="tablist" aria-label="자료 종류">
            {(["file", "link", "note"] as const).map((kind) => (
              <button
                key={kind}
                className={draftKind === kind ? "active" : ""}
                onClick={() => setDraftKind(kind)}
                type="button"
              >
                {kindIcon(kind)}
                {kindLabel(kind)}
              </button>
            ))}
          </div>

          {storage ? (
            <div className="quota-box">
              <div>
                <span>
                  <HardDrive size={16} />
                  저장소
                </span>
                <strong>{usedPercent}%</strong>
              </div>
              <progress value={storage.used_bytes} max={storage.quota_bytes} />
              <p>
                {formatBytes(storage.used_bytes)} 사용 · {formatBytes(storage.remaining_bytes)} 남음
              </p>
            </div>
          ) : null}

          <label className="share-duration">
            공유 만료 기간
            <select value={shareExpiresDays} onChange={(event) => setShareExpiresDays(Number(event.target.value))}>
              <option value={1}>1일</option>
              <option value={7}>7일</option>
              <option value={30}>30일</option>
              <option value={90}>90일</option>
              <option value={365}>365일</option>
            </select>
          </label>

          <form ref={formRef} className="item-form" onSubmit={handleCreate}>
            <input name="title" placeholder="제목" required />
            {draftKind === "file" ? (
              <label className="file-drop">
                <UploadCloud size={24} />
                <span>파일 선택</span>
                <input name="file" type="file" required />
              </label>
            ) : null}
            {draftKind === "link" ? <input name="url" placeholder="https://..." required /> : null}
            <textarea name="note" placeholder="메모" rows={draftKind === "note" ? 9 : 5} />
            <input name="tags" placeholder="태그: 문서, 학교, 서버" />
            <button className="primary-button" disabled={createMutation.isPending}>
              <Plus size={18} />
              저장
            </button>
            {uploadProgress !== null ? (
              <div className="upload-progress" aria-live="polite">
                <div>
                  <span>업로드</span>
                  <strong>{uploadProgress}%</strong>
                </div>
                <progress value={uploadProgress} max={100} />
              </div>
            ) : null}
          </form>
        </aside>

        <section className="list-panel">
          <div className="list-toolbar">
            <div className="search-box">
              <Search size={18} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="검색" />
            </div>
            <div className="filter-tabs">
              {filters.map((entry) => (
                <button
                  key={entry.value}
                  className={filter === entry.value ? "active" : ""}
                  onClick={() => setFilter(entry.value)}
                  type="button"
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <label className="sort-control">
              정렬
              <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
                {sortOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {notice ? (
            <div className="notice">
              <span>{notice}</span>
              {notice.startsWith("공유 링크:") ? (
                <button
                  className="mini-button"
                  onClick={() => navigator.clipboard.writeText(notice.replace("공유 링크: ", ""))}
                  title="복사"
                >
                  <Copy size={15} />
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="item-list" aria-live="polite">
            {itemsQuery.isLoading ? <p className="empty-text">불러오는 중입니다.</p> : null}
            {!itemsQuery.isLoading && items.length === 0 ? (
              <p className="empty-text">표시할 자료가 없습니다.</p>
            ) : null}
            {items.map((item) => (
              <article className="item-row" key={item.id}>
                <div className="item-main">
                  <span className={`kind-badge ${item.kind}`}>
                    {kindIcon(item.kind)}
                    {kindLabel(item.kind)}
                  </span>
                  <div className="item-copy">
                    <h3>{item.title}</h3>
                    {item.kind === "link" && item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer">
                        {item.url}
                      </a>
                    ) : null}
                    {item.kind === "file" ? (
                      <p>{item.original_filename} · {formatBytes(item.size_bytes)}</p>
                    ) : null}
                    <p className="item-date">
                      <Clock3 size={13} />
                      업로드 {formatDateTime(item.created_at)}
                    </p>
                    {item.note ? <p>{item.note}</p> : null}
                    {item.tags ? <div className="tags">{item.tags}</div> : null}
                  </div>
                </div>
                <div className="item-actions">
                  {item.kind === "link" && item.url ? (
                    <a className="icon-button" href={item.url} target="_blank" rel="noreferrer" title="열기">
                      <ExternalLink size={17} />
                    </a>
                  ) : null}
                  {item.kind === "file" ? (
                    <>
                      <button className="icon-button" onClick={() => handleDownload(item)} title="다운로드">
                        <Download size={17} />
                      </button>
                      <button
                        className="icon-button"
                        onClick={() => shareMutation.mutate(item.id)}
                        title={`공유 링크 생성, ${shareExpiresDays}일 만료`}
                      >
                        <Share2 size={17} />
                      </button>
                    </>
                  ) : null}
                  <button className="icon-button danger" onClick={() => deleteMutation.mutate(item.id)} title="삭제">
                    <Trash2 size={17} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function App() {
  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const publicShareToken = pathParts[0] === "s" && pathParts[1] && pathParts.length === 2 ? pathParts[1] : "";

  if (publicShareToken) {
    return <PublicShareScreen token={publicShareToken} />;
  }

  return <VaultApp />;
}

export default App;
