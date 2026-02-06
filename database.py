import os
from passlib.context import CryptContext
from datetime import datetime
from bson.objectid import ObjectId
from jose import jwt
from typing import Optional

# PyMongo ব্যবহার করুন (motor এর পরিবর্তে)
try:
    from pymongo import MongoClient
    from pymongo.errors import ConnectionFailure
    USE_MOTOR = False
except ImportError:
    USE_MOTOR = False
    print("Warning: pymongo not available")

# MongoDB Connection String
MONGO_URL = "mongodb+srv://robayet:8WVzWixH4rS1uwBX@cluster0.lrzc2.mongodb.net/?appName=Cluster"
DB_NAME = "telegram_bot_db"

# PyMongo client (sync)
client = MongoClient(MONGO_URL)
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
    """Initialize database - async version"""
    try:
        # Check connection
        client.admin.command('ping')
        print("Database connection successful")
        
        # Create indexes
        users_collection.create_index("api_id", unique=True)
        keywords_collection.create_index([("owner_id", 1), ("keyword", 1)], unique=True)
        settings_collection.create_index("owner_id", unique=True)
        print("Database indexes created")
        return True
    except Exception as e:
        print(f"Database initialization error: {e}")
        return False

async def admin_exists():
    count = admin_collection.count_documents({})
    return count > 0

async def create_initial_admin(username, password):
    if await admin_exists():
        raise Exception("Admin already exists")
    
    password_hash = pwd_context.hash(password)
    admin_collection.insert_one({
        "username": username,
        "password_hash": password_hash,
        "must_change_password": False,
        "created_at": datetime.utcnow()
    })
    return True

# --- Admin Operations ---
async def verify_admin(username, password):
    user = admin_collection.find_one({"username": username})
    if not user:
        return None
    if not pwd_context.verify(password, user["password_hash"]):
        return None
    return user

async def change_admin_password(username, new_password):
    new_hash = pwd_context.hash(new_password)
    admin_collection.update_one(
        {"username": username},
        {"$set": {"password_hash": new_hash, "must_change_password": False}}
    )

async def get_all_users():
    cursor = users_collection.find({}, {"_id": 0})
    return list(cursor)

# --- User/Bot Operations ---
async def register_user_login(api_id, api_hash, first_name=None, username=None, phone_number=None, session_string=None):
    """Update last login for a user"""
    print(f"🔥 Saving user {api_id} to database")
    
    # Encode credentials as JWT
    encoded_creds = encode_credentials(api_id, api_hash)
    
    update_data = {
        "api_id": api_id,
        "api_id_jwt": encoded_creds["api_id_jwt"],
        "api_hash_jwt": encoded_creds["api_hash_jwt"],
        "first_name": first_name,
        "username": username,
        "last_login": datetime.utcnow(),
        "updated_at": datetime.utcnow()
    }
    
    if phone_number:
        update_data["phone_number"] = phone_number
    if session_string:
        update_data["session_string"] = session_string
        print(f"[SUCCESS] Session saved to DB for {api_id}")
    
    try:
        result = users_collection.update_one(
            {"api_id": api_id},
            {"$set": update_data},
            upsert=True
        )
        print(f"[SUCCESS] User {api_id} saved/updated")
        return True
    except Exception as e:
        print(f"[ERROR] Error saving user {api_id}: {e}")
        return False

async def get_user_session(api_id):
    user = users_collection.find_one({"api_id": api_id})
    if user:
        print(f"📥 Fetched user session for {api_id}")
    return user

async def get_api_hash(api_id: str) -> Optional[str]:
    """Get decrypted API hash for a user"""
    decoded = await decode_user_credentials(api_id)
    if decoded:
        return decoded.get("api_hash")
    
    # Fallback to direct storage
    user = users_collection.find_one({"api_id": api_id})
    if user and "api_hash" in user:
        return user["api_hash"]
    return None

async def decode_user_credentials(api_id: str) -> Optional[dict]:
    """Get and decode user credentials from JWT"""
    user = users_collection.find_one({"api_id": api_id})
    if not user:
        print(f"[ERROR] User {api_id} not found in database")
        return None
    
    # Try JWT encoded credentials first
    if "api_id_jwt" in user and "api_hash_jwt" in user:
        try:
            decoded = decode_credentials(user["api_id_jwt"], user["api_hash_jwt"])
            if decoded:
                return decoded
        except Exception as e:
            print(f"[WARNING] JWT decode failed: {e}")
    
    # Fallback to plain text storage
    return {
        "api_id": user.get("api_id"),
        "api_hash": user.get("api_hash")  # May be None
    }

async def get_all_sessions():
    """Retrieve all users who have a saved session string"""
    cursor = users_collection.find({"session_string": {"$ne": None, "$ne": ""}}, {"_id": 0})
    return list(cursor)

# --- Settings Per User ---
async def get_settings(owner_id: str):
    owner_id = str(owner_id)
    settings = settings_collection.find_one({"owner_id": owner_id}, {"_id": 0})
    if not settings:
        # Default settings
        default_settings = {
            "active": True,
            "auto_reply_text": "I am currently unavailable. I will reply to you shortly.",
            "wait_time": 3600,  # 1 hour in seconds
            "owner_id": owner_id,
            "created_at": datetime.utcnow()
        }
        settings_collection.insert_one(default_settings)
        return default_settings
    return settings

async def update_settings(owner_id: str, new_settings: dict):
    owner_id = str(owner_id)
    new_settings["owner_id"] = owner_id
    new_settings["updated_at"] = datetime.utcnow()
    
    settings_collection.update_one(
        {"owner_id": owner_id},
        {"$set": new_settings},
        upsert=True
    )
    return await get_settings(owner_id)

# --- Keywords Per User ---
async def get_keywords(owner_id: str):
    owner_id = str(owner_id)
    cursor = keywords_collection.find({"owner_id": owner_id}, {"_id": 0})
    return list(cursor)

async def add_keyword(owner_id: str, keyword: str, reply: str):
    owner_id = str(owner_id)
    keyword = keyword.lower().strip()
    
    keywords_collection.update_one(
        {"owner_id": owner_id, "keyword": keyword},
        {
            "$set": {
                "owner_id": owner_id,
                "keyword": keyword,
                "reply": reply,
                "created_at": datetime.utcnow()
            }
        },
        upsert=True
    )

async def delete_keyword(owner_id: str, keyword: str):
    owner_id = str(owner_id)
    keyword = keyword.lower().strip()
    
    keywords_collection.delete_one({"owner_id": owner_id, "keyword": keyword})

# --- Scheduled Messages ---
async def get_scheduled_messages(owner_id: str):
    owner_id = str(owner_id)
    cursor = scheduled_messages_collection.find({"owner_id": owner_id})
    messages = list(cursor)
    
    # Convert ObjectId to string for JSON
    for msg in messages:
        msg["id"] = str(msg["_id"])
        del msg["_id"]
    
    return messages

async def add_scheduled_message(owner_id: str, data: dict):
    owner_id = str(owner_id)
    data["owner_id"] = owner_id
    data["last_sent_date"] = None
    data["created_at"] = datetime.utcnow()
    
    if "_id" in data:
        msg_id = data.pop("_id")
        scheduled_messages_collection.update_one(
            {"_id": ObjectId(msg_id), "owner_id": owner_id},
            {"$set": data}
        )
    else:
        scheduled_messages_collection.insert_one(data)

async def delete_scheduled_message(owner_id: str, msg_id: str):
    owner_id = str(owner_id)
    scheduled_messages_collection.delete_one(
        {"_id": ObjectId(msg_id), "owner_id": owner_id}
    )

async def get_all_active_scheduled_messages():
    cursor = scheduled_messages_collection.find({"active": True})
    return list(cursor)

async def mark_scheduled_message_sent(msg_id: str, date_str: str):
    scheduled_messages_collection.update_one(
        {"_id": ObjectId(msg_id)},
        {"$set": {"last_sent_date": date_str}}
    )