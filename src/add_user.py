#!/usr/bin/env python3
import json, sys
from werkzeug.security import generate_password_hash

USERS_FILE = "users.json"

def load():
    try:
        with open(USERS_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"users": []}

def save(d):
    with open(USERS_FILE, "w") as f:
        json.dump(d, f, indent=2)

def main():

    u, p = "", ""
    data = load()
    for usr in data["users"]:
        if usr["username"] == u:
            print("Username already exists.")
            return
    data["users"].append({
        "username": u,
        "password_hash": generate_password_hash(p),
        "role": "user"
    })
    save(data)
    print(f"Added user {u}")

if __name__ == "__main__":
    main()
