# Personal Vault

개인용 자료실 웹 앱입니다. 파일, 링크, 메모를 저장하고 파일은 만료 시간이 있는 공유 링크로 내려받을 수 있습니다.

## 주요 기능

- DB 사용자 기반 로그인
- 파일, 링크, 메모 등록과 검색
- 파일 업로드 진행률 표시
- 파일 업로드 날짜, 크기, 태그 표시
- 최신순, 오래된순, 파일 크기순, 이름순 정렬
- 저장소 사용량과 남은 용량 표시
- 공유 링크 만료 기간 설정
- 공유 받은 사람용 파일 정보 페이지
- 공개 다운로드는 토큰 검증 후 attachment로만 제공

## 스택

- Frontend: TypeScript, React, Vite, TanStack Query, lucide-react
- Backend: Python, FastAPI, SQLAlchemy, PyJWT
- Storage: SQLite, local filesystem
- Deploy: systemd, Nginx, Let's Encrypt

## 로컬 실행

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

cd frontend
npm install
```

DB 계정 생성:

```bash
cd backend
python -m app.manage_users create admin
```

개발 서버:

```bash
# terminal 1
source .venv/bin/activate
cd backend
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

# terminal 2
cd frontend
npm run dev
```

접속: `http://localhost:5173`

## 환경 변수

앱은 `.env`를 자동 로드하지 않습니다. 운영에서는 systemd `EnvironmentFile` 또는 shell export로 설정합니다.

```bash
VAULT_SECRET_KEY=replace-with-a-long-random-secret
VAULT_PUBLIC_BASE_URL=https://example.com
VAULT_CORS_ORIGIN=https://example.com
VAULT_STORAGE_DIR=/var/lib/personal-vault
VAULT_DATABASE_URL=sqlite:////var/lib/personal-vault/vault.db
VAULT_STORAGE_QUOTA_BYTES=53687091200
VAULT_MAX_UPLOAD_BYTES=536870912
```

## 배포

템플릿은 `deploy/`에 있습니다.

기본 흐름:

```bash
git clone https://github.com/deploy103/medas.git /opt/medas
cd /opt/medas
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt

cd frontend
npm ci
npm run build
```

systemd 서비스 예시는 `deploy/systemd/medas.service`, Nginx 예시는 `deploy/nginx/`를 참고하세요.

업데이트:

```bash
cd /opt/medas
git pull --ff-only
./deploy/update.sh
```

## 보안 메모

- 회원가입 API는 없습니다. 운영자는 DB 사용자만 생성합니다.
- 비밀번호는 PBKDF2 해시로 DB에 저장됩니다.
- 공유 URL은 `/s/{token}`이고, 실제 다운로드는 `/s/{token}/download`입니다.
- 공유 토큰은 허용 문자와 길이를 검증합니다.
- 공개 공유 페이지는 파일명, 크기, 업로드 날짜, 만료일만 보여줍니다.
- 파일은 서버가 생성한 UUID 파일명으로만 저장되며, 원본 파일명은 경로에 사용하지 않습니다.
- 업로드는 quota와 최대 업로드 크기를 넘으면 중단됩니다.

## 커밋 금지 파일

다음 파일은 공개 저장소에 올리지 않습니다.

- `.env`
- `id.txt`
- `server.txt`
- `storage/`
- `*.db`, `*.sqlite`, `*.sqlite3`
- `.venv/`
- `node_modules/`
- `frontend/dist/`
