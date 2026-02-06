
import asyncio
import motor.motor_asyncio
import json
from bson import ObjectId
from datetime import datetime

class JSONEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, ObjectId):
            return str(o)
        if isinstance(o, datetime):
            return o.isoformat()
        return super().default(o)

async def check():
    client = motor.motor_asyncio.AsyncIOMotorClient("mongodb://localhost:27017")
    db = client["telegram_bot_db"]
    
    print("--- USERS ---")
    users = await db["users"].find().to_list(100)
    for u in users:
        print(json.dumps(u, cls=JSONEncoder, indent=2))
        
    print("\n--- SETTINGS ---")
    settings = await db["settings"].find().to_list(100)
    for s in settings:
        print(json.dumps(s, cls=JSONEncoder, indent=2))
        
    print("\n--- KEYWORDS ---")
    keywords = await db["keywords"].find().to_list(100)
    for k in keywords:
        print(json.dumps(k, cls=JSONEncoder, indent=2))

asyncio.run(check())
