# Deploy Notes

These files are templates only. Do not commit real server IPs, passwords, private keys, or production `.env` files.

Production environment is read from `/etc/personal-vault.env`.

Required variables:

```bash
VAULT_SECRET_KEY=replace-with-a-long-random-secret
VAULT_PUBLIC_BASE_URL=https://example.com
VAULT_CORS_ORIGIN=https://example.com
VAULT_STORAGE_DIR=/var/lib/personal-vault
VAULT_DATABASE_URL=sqlite:////var/lib/personal-vault/vault.db
VAULT_STORAGE_QUOTA_BYTES=10737418240
VAULT_MAX_UPLOAD_BYTES=536870912
```

Typical update flow after cloning the public repository with HTTPS:

```bash
cd /opt/personal-vault
git pull --ff-only
./deploy/update.sh
```
