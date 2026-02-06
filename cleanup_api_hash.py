"""
MongoDB Cleanup Script - Remove Plain Text API Hash
This script removes the plain text 'api_hash' field from all user documents in MongoDB.
Only JWT-encoded credentials will remain.
"""

import asyncio
import motor.motor_asyncio

# MongoDB Connection
MONGO_URL = "mongodb+srv://robayet:8WVzWixH4rS1uwBX@cluster0.lrzc2.mongodb.net/?appName=Cluster"
DB_NAME = "telegram_bot_db"

async def cleanup_plain_text_hash():
    """Remove plain text api_hash from all users"""
    client = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    users_collection = db["users"]
    
    # Count how many users have plain text api_hash
    count_with_hash = await users_collection.count_documents({"api_hash": {"$exists": True}})
    print(f"Found {count_with_hash} users with plain text api_hash field")
    
    if count_with_hash > 0:
        # Remove the plain text api_hash field from all documents
        result = await users_collection.update_many(
            {"api_hash": {"$exists": True}},
            {"$unset": {"api_hash": ""}}
        )
        print(f"✅ Removed plain text api_hash from {result.modified_count} users")
    else:
        print("✅ No plain text api_hash fields found. All users are using JWT!")
    
    client.close()
    print("\n🔒 Database cleanup complete!")

if __name__ == "__main__":
    asyncio.run(cleanup_plain_text_hash())
