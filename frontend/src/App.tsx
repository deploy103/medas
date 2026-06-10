import {
  Check,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileArchive,
  Files,
  HardDrive,
  Link as LinkIcon,
  LockKeyhole,
  LogOut,
  Plus,
  Search,
  Share2,
  StickyNote,
  Trash2,
  UploadCloud,
  X
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createItem,
  createShare,
  deleteItem,
  deleteShare,
  downloadItem,
  getPublicShare,
  getStorageStats,
  isAuthError,
  listItems,
  listShares,
  login
} from "./api";
import type { ItemKind, PublicShare, ShareLink, StorageStats, VaultItem } from "./types";

const TOKEN_KEY = "personal-vault-token";
const USERNAME_KEY = "personal-vault-username";
const LAST_ACTIVITY_KEY = "personal-vault-last-activity";
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const IDLE_SESSION_MESSAGE = "1시간 동안 활동이 없어 자동 로그아웃되었습니다.";

function removeStoredSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USERNAME_KEY);
  localStorage.removeItem(LAST_ACTIVITY_KEY);
}

function hasStoredSessionTimedOut(): boolean {
  const storedToken = localStorage.getItem(TOKEN_KEY);
  const lastActivity = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
  return Boolean(
    storedToken &&
      Number.isFinite(lastActivity) &&
      lastActivity > 0 &&
      Date.now() - lastActivity >= IDLE_TIMEOUT_MS
  );
}

const filters: Array<{ value: ItemKind; label: string }> = [
  { value: "all", label: "전체" },
  { value: "file", label: "파일" },
  { value: "link", label: "링크" },
  { value: "note", label: "메모" }
];

type SortKey = "newest" | "oldest" | "largest" | "smallest" | "title";
type AppTab = "items" | "shares";

const sortOptions: Array<{ value: SortKey; label: string }> = [
  { value: "newest", label: "최신순" },
  { value: "oldest", label: "오래된순" },
  { value: "largest", label: "큰 파일순" },
  { value: "smallest", label: "작은 파일순" },
  { value: "title", label: "이름순" }
];

const shareExpiryOptions = [
  { hours: 1, label: "1시간" },
  { hours: 3, label: "3시간" },
  { hours: 5, label: "5시간" },
  { hours: 12, label: "12시간" },
  { hours: 24, label: "1일" },
  { hours: 72, label: "3일" },
  { hours: 120, label: "5일" },
  { hours: 168, label: "7일" },
  { hours: 336, label: "14일" }
];

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "-";
  if (bytes === 0) return "0 B";
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
  const minutes = Math.ceil(diff / (1000 * 60));
  if (minutes < 60) return `${minutes}분 남음`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours}시간 남음`;
  return `${Math.ceil(hours / 24)}일 남음`;
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

function Modal({
  title,
  children,
  onClose,
  wide = false
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className={`modal-panel ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} title="닫기" type="button">
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function LoginScreen({
  message,
  onLogin
}: {
  message?: string;
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
            <h1>Medas</h1>
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
        {message ? <p className="session-text">{message}</p> : null}
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
      <section className="share-panel public-share-panel">
        <div className="brand-row">
          <span className="brand-mark">
            <Files size={24} />
          </span>
          <div>
            <h1>Medas</h1>
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
                <Files size={18} />
                파일 {share.file_count}개
              </span>
              <h2>{share.file_count === 1 ? share.files[0]?.filename : `공유 파일 ${share.file_count}개`}</h2>
              <p>총 {formatBytes(share.total_size_bytes)} · 압축 {formatBytes(share.zip_size_bytes)}</p>
            </div>

            <dl className="share-meta">
              <div>
                <dt>공유일</dt>
                <dd>{formatDateTime(share.shared_at)}</dd>
              </div>
              <div>
                <dt>공유 만료</dt>
                <dd>
                  {formatDate(share.expires_at)} · {formatRemaining(share.expires_at)}
                </dd>
              </div>
            </dl>

            <a className="primary-button share-download" href={share.download_all_url}>
              <Download size={18} />
              모두 다운로드
            </a>

            <div className="public-file-list">
              {share.files.map((file) => (
                <article className="public-file-row" key={file.id}>
                  <div>
                    <h3>{file.filename}</h3>
                    <p>
                      {formatBytes(file.size_bytes)} · 업로드 {formatDateTime(file.uploaded_at)}
                    </p>
                  </div>
                  <a className="secondary-button" href={file.download_url}>
                    <Download size={16} />
                    다운로드
                  </a>
                </article>
              ))}
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}

function VaultApp() {
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const lastActivityWriteRef = useRef(0);
  const [initialIdleExpired] = useState(() => hasStoredSessionTimedOut());
  const [token, setToken] = useState(() => {
    if (initialIdleExpired) {
      removeStoredSession();
      return "";
    }
    return localStorage.getItem(TOKEN_KEY) ?? "";
  });
  const [username, setUsername] = useState(() => (initialIdleExpired ? "" : localStorage.getItem(USERNAME_KEY) ?? ""));
  const [activeTab, setActiveTab] = useState<AppTab>("items");
  const [filter, setFilter] = useState<ItemKind>("all");
  const [query, setQuery] = useState("");
  const [draftKind, setDraftKind] = useState<Exclude<ItemKind, "all">>("file");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [selectedFileIds, setSelectedFileIds] = useState<number[]>([]);
  const [shareDraftIds, setShareDraftIds] = useState<number[]>([]);
  const [shareExpiresHours, setShareExpiresHours] = useState(24);
  const [shareResult, setShareResult] = useState<ShareLink | null>(null);
  const [shareError, setShareError] = useState("");
  const [detailsShare, setDetailsShare] = useState<ShareLink | null>(null);
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadComplete, setUploadComplete] = useState(false);
  const [notice, setNotice] = useState("");
  const [authMessage, setAuthMessage] = useState(initialIdleExpired ? IDLE_SESSION_MESSAGE : "");

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

  const sharesQuery = useQuery({
    queryKey: ["shares"],
    queryFn: () => listShares(token),
    enabled: Boolean(token)
  });

  const hasAuthQueryError = [itemsQuery.error, storageQuery.error, sharesQuery.error].some(isAuthError);

  useEffect(() => {
    if (hasAuthQueryError) {
      handleAuthExpired();
    }
  }, [hasAuthQueryError]);

  useEffect(() => {
    if (!token) return;

    let idleTimerId: number | undefined;
    const activityEvents = ["click", "keydown", "mousemove", "pointerdown", "scroll", "touchstart", "input"];

    function readLastActivity(): number {
      const timestamp = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
      return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
    }

    function expireIfIdle(): boolean {
      const lastActivity = readLastActivity();
      if (Date.now() - lastActivity < IDLE_TIMEOUT_MS) return false;
      handleIdleExpired();
      return true;
    }

    function scheduleIdleCheck() {
      window.clearTimeout(idleTimerId);
      const elapsed = Date.now() - readLastActivity();
      const remaining = Math.max(IDLE_TIMEOUT_MS - elapsed, 0);
      idleTimerId = window.setTimeout(() => {
        if (!expireIfIdle()) {
          scheduleIdleCheck();
        }
      }, remaining);
    }

    function recordActivity() {
      if (expireIfIdle()) return;
      const now = Date.now();
      if (now - lastActivityWriteRef.current < 1000) return;
      lastActivityWriteRef.current = now;
      localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
      scheduleIdleCheck();
    }

    const savedActivity = Number(localStorage.getItem(LAST_ACTIVITY_KEY));
    if (Number.isFinite(savedActivity) && savedActivity > 0) {
      lastActivityWriteRef.current = savedActivity;
    } else {
      lastActivityWriteRef.current = Date.now();
      localStorage.setItem(LAST_ACTIVITY_KEY, String(lastActivityWriteRef.current));
    }

    if (expireIfIdle()) return;
    scheduleIdleCheck();
    activityEvents.forEach((eventName) => window.addEventListener(eventName, recordActivity, { passive: true }));

    return () => {
      window.clearTimeout(idleTimerId);
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, recordActivity));
    };
  }, [token]);

  const rawItems = itemsQuery.data ?? [];
  const items = useMemo(() => sortItems(rawItems, sortKey), [rawItems, sortKey]);
  const fileItems = rawItems.filter((item) => item.kind === "file");
  const selectedFiles = useMemo(() => {
    const byId = new Map(rawItems.map((item) => [item.id, item]));
    return selectedFileIds
      .map((id) => byId.get(id))
      .filter((item): item is VaultItem => Boolean(item && item.kind === "file"));
  }, [rawItems, selectedFileIds]);
  const shareDraftFiles = useMemo(() => {
    const byId = new Map(rawItems.map((item) => [item.id, item]));
    return shareDraftIds
      .map((id) => byId.get(id))
      .filter((item): item is VaultItem => Boolean(item && item.kind === "file"));
  }, [rawItems, shareDraftIds]);
  const selectedFileIdSet = useMemo(() => new Set(selectedFileIds), [selectedFileIds]);
  const visibleFiles = items.filter((item) => item.kind === "file");
  const allVisibleSelected =
    visibleFiles.length > 0 && visibleFiles.every((item) => selectedFileIdSet.has(item.id));
  const storage: StorageStats | undefined = storageQuery.data;
  const shares = sharesQuery.data ?? [];
  const fileCount = fileItems.length;
  const linkCount = rawItems.filter((item) => item.kind === "link").length;
  const noteCount = rawItems.filter((item) => item.kind === "note").length;
  const selectedTotalBytes = selectedFiles.reduce((total, item) => total + (item.size_bytes ?? 0), 0);
  const shareDraftTotalBytes = shareDraftFiles.reduce((total, item) => total + (item.size_bytes ?? 0), 0);
  const usedPercent =
    storage && storage.quota_bytes > 0 ? Math.min(100, Math.round((storage.used_bytes / storage.quota_bytes) * 100)) : 0;

  const createMutation = useMutation({
    mutationFn: (formData: FormData) =>
      createItem(token, formData, formData.get("kind") === "file" ? setUploadProgress : undefined),
    onMutate: (formData) => {
      setUploadProgress(formData.get("kind") === "file" ? 0 : null);
      setUploadComplete(false);
    },
    onSuccess: (_item, formData) => {
      formRef.current?.reset();
      if (formData.get("kind") === "file") {
        setUploadProgress(100);
        setUploadComplete(true);
      } else {
        setIsUploadOpen(false);
        setUploadProgress(null);
        setUploadComplete(false);
      }
      setNotice("저장했습니다.");
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["storage"] });
    },
    onError: (err) => {
      setUploadComplete(false);
      if (isAuthError(err)) {
        handleAuthExpired();
        return;
      }
      setNotice(err instanceof Error ? err.message : "저장 실패");
    },
    onSettled: (_data, error) => {
      if (error) {
        window.setTimeout(() => setUploadProgress(null), 900);
      }
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteItem(token, id),
    onSuccess: () => {
      setNotice("삭제했습니다.");
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["storage"] });
      queryClient.invalidateQueries({ queryKey: ["shares"] });
    },
    onError: (err) => {
      if (isAuthError(err)) {
        handleAuthExpired();
        return;
      }
      setNotice(err instanceof Error ? err.message : "삭제 실패");
    }
  });

  const shareMutation = useMutation({
    mutationFn: () => createShare(token, shareDraftIds, shareExpiresHours),
    onMutate: () => {
      setShareError("");
      setShareResult(null);
    },
    onSuccess: async (share) => {
      setShareResult(share);
      setSelectedFileIds([]);
      queryClient.invalidateQueries({ queryKey: ["shares"] });
      try {
        await navigator.clipboard.writeText(share.share_url);
      } catch {
        // Clipboard permissions vary by browser and protocol.
      }
    },
    onError: (err) => {
      if (isAuthError(err)) {
        handleAuthExpired();
        return;
      }
      setShareError(err instanceof Error ? err.message : "공유 실패");
    }
  });

  const deleteShareMutation = useMutation({
    mutationFn: (id: number) => deleteShare(token, id),
    onSuccess: () => {
      setNotice("공유 링크를 삭제했습니다.");
      setDetailsShare(null);
      queryClient.invalidateQueries({ queryKey: ["shares"] });
    },
    onError: (err) => {
      if (isAuthError(err)) {
        handleAuthExpired();
        return;
      }
      setNotice(err instanceof Error ? err.message : "공유 삭제 실패");
    }
  });

  function clearSession(message = "") {
    removeStoredSession();
    queryClient.removeQueries({ queryKey: ["items"] });
    queryClient.removeQueries({ queryKey: ["storage"] });
    queryClient.removeQueries({ queryKey: ["shares"] });
    setToken("");
    setUsername("");
    setSelectedFileIds([]);
    setShareDraftIds([]);
    setShareResult(null);
    setShareError("");
    setDetailsShare(null);
    setIsUploadOpen(false);
    setIsShareOpen(false);
    setUploadProgress(null);
    setUploadComplete(false);
    setNotice("");
    setAuthMessage(message);
  }

  function handleAuthExpired() {
    clearSession("세션이 만료되었습니다. 다시 로그인해 주세요.");
  }

  function handleIdleExpired() {
    clearSession(IDLE_SESSION_MESSAGE);
  }

  function handleLogin(nextToken: string, nextUsername: string) {
    const now = Date.now();
    localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
    lastActivityWriteRef.current = now;
    setAuthMessage("");
    setToken(nextToken);
    setUsername(nextUsername);
  }

  function handleLogout() {
    clearSession();
  }

  function openUploadModal() {
    setUploadProgress(null);
    setUploadComplete(false);
    setIsUploadOpen(true);
  }

  function closeUploadModal() {
    setIsUploadOpen(false);
    setUploadProgress(null);
    setUploadComplete(false);
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
      if (isAuthError(err)) {
        handleAuthExpired();
        return;
      }
      setNotice(err instanceof Error ? err.message : "다운로드 실패");
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("복사했습니다.");
    } catch {
      setNotice("복사 권한이 없어 직접 복사해야 합니다.");
    }
  }

  function toggleFileSelection(id: number, checked: boolean) {
    setSelectedFileIds((current) => {
      if (checked) return current.includes(id) ? current : [...current, id];
      return current.filter((entry) => entry !== id);
    });
  }

  function toggleVisibleFiles() {
    const visibleIds = visibleFiles.map((item) => item.id);
    setSelectedFileIds((current) => {
      if (allVisibleSelected) {
        return current.filter((id) => !visibleIds.includes(id));
      }
      const next = new Set(current);
      visibleIds.forEach((id) => next.add(id));
      return [...next];
    });
  }

  function openShareModal(files: VaultItem[]) {
    const ids = files.filter((item) => item.kind === "file").map((item) => item.id);
    if (ids.length === 0) return;
    setShareDraftIds(ids);
    setShareResult(null);
    setShareError("");
    setShareExpiresHours(24);
    setIsShareOpen(true);
  }

  if (!token) {
    return <LoginScreen message={authMessage} onLogin={handleLogin} />;
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-row">
          <span className="brand-mark">
            <FileArchive size={23} />
          </span>
          <div>
            <h1>Medas</h1>
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
        <aside className="create-panel action-panel">
          <div className="section-head">
            <h2>작업</h2>
            <span>{createMutation.isPending ? "업로드 중" : "대기"}</span>
          </div>

          <button className="primary-button full-button" onClick={openUploadModal} type="button">
            <Plus size={18} />
            파일 추가
          </button>
          <button
            className="secondary-button full-button"
            disabled={selectedFiles.length === 0}
            onClick={() => openShareModal(selectedFiles)}
            type="button"
          >
            <Share2 size={18} />
            선택 공유
          </button>

          <div className="selection-box">
            <span>선택한 파일</span>
            <strong>{selectedFiles.length}개</strong>
            <p>{formatBytes(selectedTotalBytes)}</p>
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
        </aside>

        <section className="list-panel">
          <div className="main-tabs" role="tablist" aria-label="보기">
            <button className={activeTab === "items" ? "active" : ""} onClick={() => setActiveTab("items")} type="button">
              <Files size={17} />
              자료
            </button>
            <button className={activeTab === "shares" ? "active" : ""} onClick={() => setActiveTab("shares")} type="button">
              <Share2 size={17} />
              공유됨
            </button>
          </div>

          {activeTab === "items" ? (
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
              <div className="bulk-actions">
                <button className="secondary-button" disabled={visibleFiles.length === 0} onClick={toggleVisibleFiles} type="button">
                  <Check size={16} />
                  {allVisibleSelected ? "선택 해제" : "표시 파일 선택"}
                </button>
                <button className="primary-button" disabled={selectedFiles.length === 0} onClick={() => openShareModal(selectedFiles)} type="button">
                  <Share2 size={16} />
                  공유
                </button>
              </div>
            </div>
          ) : (
            <div className="list-toolbar share-toolbar">
              <div>
                <h2>공유된 링크</h2>
                <p>{shares.length}개 링크</p>
              </div>
            </div>
          )}

          {notice ? (
            <div className="notice">
              <span>{notice}</span>
            </div>
          ) : null}

          {activeTab === "items" ? (
            <div className="item-list" aria-live="polite">
              {itemsQuery.isLoading ? <p className="empty-text">불러오는 중입니다.</p> : null}
              {!itemsQuery.isLoading && items.length === 0 ? (
                <p className="empty-text">표시할 자료가 없습니다.</p>
              ) : null}
              {items.map((item) => (
                <article className="item-row" key={item.id}>
                  {item.kind === "file" ? (
                    <label className="item-select" title="선택">
                      <input
                        type="checkbox"
                        checked={selectedFileIdSet.has(item.id)}
                        onChange={(event) => toggleFileSelection(item.id, event.target.checked)}
                      />
                    </label>
                  ) : (
                    <span className="item-select-placeholder" />
                  )}
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
                        <button className="icon-button" onClick={() => openShareModal([item])} title="공유 링크 생성">
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
          ) : (
            <div className="share-list" aria-live="polite">
              {sharesQuery.isLoading ? <p className="empty-text">공유 링크를 불러오는 중입니다.</p> : null}
              {!sharesQuery.isLoading && shares.length === 0 ? (
                <p className="empty-text">공유된 링크가 없습니다.</p>
              ) : null}
              {shares.map((share) => (
                <article className="share-row" key={share.id}>
                  <div className="share-row-main">
                    <span className="kind-badge file">
                      <Share2 size={17} />
                      공유
                    </span>
                    <div>
                      <h3>{share.file_count === 1 ? share.files[0]?.filename : `파일 ${share.file_count}개`}</h3>
                      <p>
                        {formatBytes(share.total_size_bytes)} · 만료 {formatRemaining(share.expires_at)}
                      </p>
                      <p className="share-url">{share.share_url}</p>
                    </div>
                  </div>
                  <div className="item-actions">
                    <button className="icon-button" onClick={() => copyText(share.share_url)} title="링크 복사">
                      <Copy size={17} />
                    </button>
                    <button className="icon-button" onClick={() => setDetailsShare(share)} title="자세히">
                      <Eye size={17} />
                    </button>
                    <button className="icon-button danger" onClick={() => deleteShareMutation.mutate(share.id)} title="공유 삭제">
                      <Trash2 size={17} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </section>

      {isUploadOpen ? (
        <Modal title="자료 추가" onClose={closeUploadModal}>
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
            <button className="primary-button" disabled={createMutation.isPending || uploadComplete}>
              {uploadComplete ? <Check size={18} /> : <Plus size={18} />}
              {uploadComplete ? "저장 완료" : createMutation.isPending ? "저장 중" : "저장"}
            </button>
            {uploadProgress !== null ? (
              <div className="upload-progress" aria-live="polite">
                <div>
                  <span>{uploadComplete ? "업로드 완료" : "업로드"}</span>
                  <strong>{uploadProgress}%</strong>
                </div>
                <progress value={uploadProgress} max={100} />
                {uploadComplete ? (
                  <button className="primary-button full-button" onClick={closeUploadModal} type="button">
                    <Check size={18} />
                    완료
                  </button>
                ) : null}
              </div>
            ) : null}
          </form>
        </Modal>
      ) : null}

      {isShareOpen ? (
        <Modal title={shareResult ? "공유 링크" : "공유 설정"} onClose={() => setIsShareOpen(false)} wide>
          {shareResult ? (
            <div className="share-result">
              <div className="share-link-box">
                <input value={shareResult.share_url} readOnly />
                <button className="secondary-button" onClick={() => copyText(shareResult.share_url)} type="button">
                  <Copy size={16} />
                  복사
                </button>
              </div>
              <dl className="share-meta compact">
                <div>
                  <dt>파일</dt>
                  <dd>{shareResult.file_count}개</dd>
                </div>
                <div>
                  <dt>전체 크기</dt>
                  <dd>{formatBytes(shareResult.total_size_bytes)}</dd>
                </div>
                <div>
                  <dt>만료</dt>
                  <dd>{formatRemaining(shareResult.expires_at)}</dd>
                </div>
              </dl>
              <a className="primary-button" href={shareResult.share_url} target="_blank" rel="noreferrer">
                <ExternalLink size={16} />
                링크 열기
              </a>
            </div>
          ) : (
            <>
              <div className="share-summary-box">
                <strong>{shareDraftFiles.length}개 파일</strong>
                <span>{formatBytes(shareDraftTotalBytes)}</span>
              </div>
              <div className="selected-file-list">
                {shareDraftFiles.map((item) => (
                  <div key={item.id}>
                    <span>{item.original_filename}</span>
                    <strong>{formatBytes(item.size_bytes)}</strong>
                  </div>
                ))}
              </div>
              <label>
                링크 만료
                <select value={shareExpiresHours} onChange={(event) => setShareExpiresHours(Number(event.target.value))}>
                  {shareExpiryOptions.map((option) => (
                    <option key={option.hours} value={option.hours}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {shareError ? <p className="error-text">{shareError}</p> : null}
              <div className="modal-actions">
                <button className="secondary-button" onClick={() => setIsShareOpen(false)} type="button">
                  취소
                </button>
                <button className="primary-button" disabled={shareMutation.isPending || shareDraftFiles.length === 0} onClick={() => shareMutation.mutate()} type="button">
                  <Share2 size={16} />
                  {shareMutation.isPending ? "압축 중" : "공유하기"}
                </button>
              </div>
            </>
          )}
        </Modal>
      ) : null}

      {detailsShare ? (
        <Modal title="공유 상세" onClose={() => setDetailsShare(null)} wide>
          <div className="share-result">
            <div className="share-link-box">
              <input value={detailsShare.share_url} readOnly />
              <button className="secondary-button" onClick={() => copyText(detailsShare.share_url)} type="button">
                <Copy size={16} />
                복사
              </button>
            </div>
            <dl className="share-meta compact">
              <div>
                <dt>파일</dt>
                <dd>{detailsShare.file_count}개</dd>
              </div>
              <div>
                <dt>크기</dt>
                <dd>{formatBytes(detailsShare.total_size_bytes)}</dd>
              </div>
              <div>
                <dt>만료</dt>
                <dd>{formatRemaining(detailsShare.expires_at)}</dd>
              </div>
            </dl>
            <div className="selected-file-list">
              {detailsShare.files.map((file) => (
                <div key={file.id}>
                  <span>{file.filename}</span>
                  <strong>{formatBytes(file.size_bytes)}</strong>
                </div>
              ))}
            </div>
            <a className="primary-button" href={detailsShare.download_all_url}>
              <Download size={16} />
              모두 다운로드
            </a>
          </div>
        </Modal>
      ) : null}
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
