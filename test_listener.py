
# import asyncio
# from telethon import TelegramClient, events
# import os
# from dotenv import load_dotenv

# load_dotenv()

# API_ID = 37118739
# API_HASH = "d02baf67c4f5d2e0586236c24e1248d1"
# SESSION_PATH = "sessions/37118739.session"

# async def main():
#     print(f"Testing listener for {API_ID}...")
#     client = TelegramClient(SESSION_PATH, API_ID, API_HASH)
    
#     @client.on(events.NewMessage())
#     async def handler(event):
#         print(f"!!! RECEIVED MESSAGE: {event.message.message} from {event.chat_id}")

#     await client.connect()
#     if not await client.is_user_authorized():
#         print("Not authorized!")
#         return
    
#     print("Logged in successfully. Listening for 60 seconds...")
#     await client.start()
    
#     # Keep it running
#     await asyncio.sleep(60)
#     print("Test finished.")
#     await client.disconnect()

# asyncio.run(main())
