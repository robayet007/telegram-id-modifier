
import motor.motor_asyncio
import os
from passlib.context import CryptContext
from datetime import datetime
from bson.objectid import ObjectId
from jose import jwt
from typing import Optional

# MongoDB Connection String
MONGO_URL = "mongodb+srv://robayet:8WVzWixH4rS1uwBX@cluster0.lrzc2.mongodb.net/?appName=Cluster"
DB_NAME = "telegram_bot_db"

client = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

# Collections
admin_collection = db["admin"]
users_collection = db["users"]
keywords_collection = db["keywords"]
settings_collection = db["settings"]
scheduled_messages_collection = db["scheduled_messages"]

# Password Hashing
pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")

# JWT Configuration for Credentials Encoding
CREDENTIALS_SECRET = "credentials_secret_key_change_in_production_2026"
CREDENTIALS_ALGORITHM = "HS256"

def encode_credentials(api_id: str, api_hash: str) -> dict:
    """Encode API credentials as JWT tokens"""
    # Use integer timestamp for JWT iat claim
    issued_at = int(datetime.utcnow().timestamp())
    
    payload_id = {
        "data": api_id,
        "type": "api_id",
        "iat": issued_at
    }
    payload_hash = {
        "data": api_hash,
        "type": "api_hash",
        "iat": issued_at
    }
    
    encoded_id = jwt.encode(payload_id, CREDENTIALS_SECRET, algorithm=CREDENTIALS_ALGORITHM)
    encoded_hash = jwt.encode(payload_hash, CREDENTIALS_SECRET, algorithm=CREDENTIALS_ALGORITHM)
    
    return {
        "api_id_jwt": encoded_id,
        "api_hash_jwt": encoded_hash
    }

def decode_credentials(api_id_jwt: str, api_hash_jwt: str) -> Optional[dict]:
    """Decode JWT tokens to get original credentials"""
    try:
        decoded_id = jwt.decode(api_id_jwt, CREDENTIALS_SECRET, algorithms=[CREDENTIALS_ALGORITHM])
        decoded_hash = jwt.decode(api_hash_jwt, CREDENTIALS_SECRET, algorithms=[CREDENTIALS_ALGORITHM])
        
        return {
            "api_id": decoded_id["data"],
            "api_hash": decoded_hash["data"]
        }
    except Exception as e:
        print(f"Error decoding credentials: {e}")
        return None




async def init_db():
    """Initialize database"""
    # We no longer seed admin here. Admin setup is dynamic.
    pass

async def admin_exists():
    count = await admin_collection.count_documents({})
    return count > 0

async def create_initial_admin(username, password):
    if await admin_exists():
        raise Exception("Admin already exists")
    
    password_hash = pwd_context.hash(password)
    await admin_collection.insert_one({
        "username": username,
        "password_hash": password_hash,
        "must_change_password": False
    })
    return True

# --- Admin Operations ---
async def verify_admin(username, password):
    user = await admin_collection.find_one({"username": username})
    if not user:
        return None
    if not pwd_context.verify(password, user["password_hash"]):
        return None
    return user

async def change_admin_password(username, new_password):
    new_hash = pwd_context.hash(new_password)
    await admin_collection.update_one(
        {"username": username},
        {"$set": {"password_hash": new_hash, "must_change_password": False}}
    )

async def get_all_users():
    cursor = users_collection.find({}, {"_id": 0})
    return await cursor.to_list(length=1000)

async def get_all_keywords_for_admin():
    """Get all keywords with their owners"""
    cursor = keywords_collection.find({}, {"_id": 0})
    return await cursor.to_list(length=1000)

# --- User/Bot Operations ---
async def register_user_login(api_id, api_hash, first_name=None, username=None, phone_number=None, session_string=None):
    """Update last login for a user"""
    # Encode credentials as JWT
    encoded_creds = encode_credentials(api_id, api_hash)
    
    update_data = {
        "api_id": api_id,  # Keep plain text for lookups
        "api_id_jwt": encoded_creds["api_id_jwt"],  # JWT encoded
        "api_hash_jwt": encoded_creds["api_hash_jwt"],  # JWT encoded
        "first_name": first_name,
        "username": username,
        "last_login": datetime.utcnow()
    }
    if phone_number:
        update_data["phone_number"] = phone_number
    if session_string:
        update_data["session_string"] = session_string

    print(f"DEBUG: Saving user {api_id} to DB with JWT-encoded credentials. Session String Length: {len(session_string) if session_string else 0}")

    await users_collection.update_one(
        {"api_id": api_id},
        {"$set": update_data},
        upsert=True
    )

async def get_user_session(api_id):
    user = await users_collection.find_one({"api_id": api_id}, {"session_string": 1, "api_id_jwt": 1, "api_hash_jwt": 1})
    return user

async def get_api_hash(api_id: str) -> Optional[str]:
    """Get decrypted API hash for a user"""
    decoded = await decode_user_credentials(api_id)
    if decoded:
        return decoded.get("api_hash")
    return None

async def decode_user_credentials(api_id: str) -> Optional[dict]:
    """Get and decode user credentials from JWT"""
    user = await users_collection.find_one({"api_id": api_id})
    if not user:
        return None
    
    # Check if JWT encoded credentials exist
    if "api_id_jwt" in user and "api_hash_jwt" in user:
        decoded = decode_credentials(user["api_id_jwt"], user["api_hash_jwt"])
        if decoded:
            return decoded
    
    # Fallback for old format - return only api_id
    # api_hash should be re-entered on next login
    return {
        "api_id": user.get("api_id"),
        "api_hash": None  # Don't return plain text hash
    }

async def get_all_sessions():
    """Retrieve all users who have a saved session string"""
    cursor = users_collection.find({"session_string": {"$ne": None}}, {"_id": 0})
    return await cursor.to_list(length=1000)

# --- Settings Per User ---
async def get_settings(owner_id: str):
    owner_id = str(owner_id)
    settings = await settings_collection.find_one({"owner_id": owner_id}, {"_id": 0})
    if not settings:
        return {
            "active": True,
            "auto_reply_text": "I am currently unavailable. I will reply to you shortly.",
            "wait_time": 10,
            "owner_id": owner_id
        }
    return settings

async def update_settings(owner_id: str, new_settings: dict):
    owner_id = str(owner_id)
    new_settings["owner_id"] = owner_id
    await settings_collection.update_one(
        {"owner_id": owner_id},
        {"$set": new_settings},
        upsert=True
    )
    return await get_settings(owner_id)

# --- Keywords Per User ---
async def get_keywords(owner_id: str):
    owner_id = str(owner_id)
    cursor = keywords_collection.find({"owner_id": owner_id}, {"_id": 0})
    return await cursor.to_list(length=1000)

async def add_keyword(owner_id: str, keyword: str, reply: str):
    owner_id = str(owner_id)
    await keywords_collection.update_one(
        {"owner_id": owner_id, "keyword": keyword.lower()},
        {"$set": {"owner_id": owner_id, "keyword": keyword.lower(), "reply": reply}},
        upsert=True
    )

async def delete_keyword(owner_id: str, keyword: str):
    owner_id = str(owner_id)
    await keywords_collection.delete_one({"owner_id": owner_id, "keyword": keyword.lower()})

# --- Scheduled Messages ---
async def get_scheduled_messages(owner_id: str):
    owner_id = str(owner_id)
    cursor = scheduled_messages_collection.find({"owner_id": owner_id})
    return await cursor.to_list(length=1000)

async def add_scheduled_message(owner_id: str, data: dict):
    owner_id = str(owner_id)
    data["owner_id"] = owner_id
    data["last_sent_date"] = None # Format: YYYY-MM-DD
    if "_id" in data:
        msg_id = data.pop("_id")
        await scheduled_messages_collection.update_one({"_id": ObjectId(msg_id), "owner_id": owner_id}, {"$set": data})
    else:
        await scheduled_messages_collection.insert_one(data)

async def delete_scheduled_message(owner_id: str, msg_id: str):
    owner_id = str(owner_id)
    await scheduled_messages_collection.delete_one({"_id": ObjectId(msg_id), "owner_id": owner_id})

async def get_all_active_scheduled_messages():
    cursor = scheduled_messages_collection.find({"active": True})
    return await cursor.to_list(length=1000)

async def mark_scheduled_message_sent(msg_id: str, date_str: str):
    await scheduled_messages_collection.update_one(
        {"_id": ObjectId(msg_id)},
        {"$set": {"last_sent_date": date_str}}
    )
