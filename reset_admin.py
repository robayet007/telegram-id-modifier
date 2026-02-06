import asyncio
from database import admin_collection

async def reset_admin():
    count = await admin_collection.count_documents({})
    print(f"Found {count} admin(s). Clearing...")
    await admin_collection.delete_many({})
    print("Admin collection cleared.")

if __name__ == "__main__":
    asyncio.run(reset_admin())
