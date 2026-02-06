
import asyncio
import motor.motor_asyncio

async def check():
    client = motor.motor_asyncio.AsyncIOMotorClient("mongodb://localhost:27017")
    db = client["telegram_bot_db"]
    
    user = await db["users"].find_one()
    if user:
        print(f"api_id type: {type(user.get('api_id'))}")
    
    settings = await db["settings"].find_one()
    if settings:
        print(f"owner_id type: {type(settings.get('owner_id'))}")

asyncio.run(check())
