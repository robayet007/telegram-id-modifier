"""
MongoDB Cleanup Script - Remove Invalid JWT Tokens
This script removes old JWT tokens that were created with invalid (string) timestamps.
This forces users to re-login and create fresh JWT tokens with proper integer timestamps.
"""

import asyncio
import motor.motor_asyncio

# MongoDB Connection
MONGO_URL = "mongodb+srv://robayet:8WVzWixH4rS1uwBX@cluster0.lrzc2.mongodb.net/?appName=Cluster"
DB_NAME = "telegram_bot_db"

async def cleanup_invalid_jwts():
    """Remove invalid JWT tokens from all users"""
    client = motor.motor_asyncio.AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    users_collection = db["users"]
    
    # Count how many users have JWT tokens
    count_with_jwt = await users_collection.count_documents({"api_id_jwt": {"$exists": True}})
    print(f"Found {count_with_jwt} users with JWT tokens")
    
    if count_with_jwt > 0:
        # Remove the invalid JWT tokens
        result = await users_collection.update_many(
            {"api_id_jwt": {"$exists": True}},
            {"$unset": {"api_id_jwt": "", "api_hash_jwt": ""}}
        )
        print(f"✅ Removed invalid JWT tokens from {result.modified_count} users")
        print("⚠️  Users will need to re-login to create fresh JWT tokens")
    else:
        print("✅ No JWT tokens found")
    
    client.close()
    print("\n🔧 Database cleanup complete!")

if __name__ == "__main__":
    asyncio.run(cleanup_invalid_jwts())
