from argparse import ArgumentParser
from getpass import getpass
import sys

from .auth import hash_password
from .database import Base, SessionLocal, engine
from .models import User
from .storage import ensure_storage_dirs


def ensure_tables() -> None:
    ensure_storage_dirs()
    Base.metadata.create_all(bind=engine)


def create_user(username: str, password: str, replace: bool) -> int:
    ensure_tables()
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.username == username).first()
        if existing is not None and not replace:
            print(f"user already exists: {username}", file=sys.stderr)
            return 1
        if existing is None:
            db.add(User(username=username, password_hash=hash_password(password), is_active=True))
        else:
            existing.password_hash = hash_password(password)
            existing.is_active = True
        db.commit()
        print(f"user ready: {username}")
        return 0
    finally:
        db.close()


def disable_user(username: str) -> int:
    ensure_tables()
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username).first()
        if user is None:
            print(f"user not found: {username}", file=sys.stderr)
            return 1
        user.is_active = False
        db.commit()
        print(f"user disabled: {username}")
        return 0
    finally:
        db.close()


def list_users() -> int:
    ensure_tables()
    db = SessionLocal()
    try:
        users = db.query(User).order_by(User.username.asc()).all()
        for user in users:
            state = "active" if user.is_active else "disabled"
            print(f"{user.username}\t{state}")
        return 0
    finally:
        db.close()


def main() -> int:
    parser = ArgumentParser(description="Manage Medas users. This is not a signup flow.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create_parser = subparsers.add_parser("create", help="create or update a DB user")
    create_parser.add_argument("username")
    create_parser.add_argument("--password", help="omit to enter it interactively")
    create_parser.add_argument("--replace", action="store_true", help="replace password if the user exists")

    disable_parser = subparsers.add_parser("disable", help="disable an existing DB user")
    disable_parser.add_argument("username")

    subparsers.add_parser("list", help="list DB users")

    args = parser.parse_args()

    if args.command == "create":
        password = args.password
        if password is None:
            password = getpass("Password: ")
            confirm = getpass("Confirm password: ")
            if password != confirm:
                print("passwords do not match", file=sys.stderr)
                return 1
        return create_user(args.username, password, args.replace)
    if args.command == "disable":
        return disable_user(args.username)
    if args.command == "list":
        return list_users()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
