import asyncio
import os
import sys

# Force UTF-8 encoding for Windows console
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except AttributeError:
        pass # Python < 3.7 or not customizable

from fastapi import FastAPI, HTTPException, Depends, WebSocket, WebSocketDisconnect, Header, Body, UploadFile, File, Form
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse, FileResponse
from pydantic import BaseModel
import uvicorn
from telethon import TelegramClient, events, types, custom
from telethon.sessions import StringSession
import logging
from typing import Dict, List, Optional, Any
from jose import JWTError, jwt
from datetime import datetime, timedelta
# from passlib.context import CryptContext
# If we use db.verify, we might not need CryptContext here.
# Let's keep common ones.


# Import Database Module
import database as db
from contextlib import asynccontextmanager

# --- WebSocket Manager ---
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except:
                pass

manager = ConnectionManager()
security = HTTPBearer(auto_error=False)

# --- Configuration & Constants ---
SECRET_KEY = "supersecretkey_change_this_in_production"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60

# --- Pydantic Models ---
class LoginRequest(BaseModel):
    api_id: str
    api_hash: str

class AdminLoginRequest(BaseModel):
    username: str
    password: str

class PasswordChangeRequest(BaseModel):
    old_password: str
    new_password: str

class SettingsRequest(BaseModel):
    active: bool
    auto_reply_text: str
    wait_time: int
    # Owner ID is inferred from session/header in real apps, 
    # but for simplicity we rely on the client sending the API ID as a header for user actions
    # OR we just use the single-login assumption per browser.
    # Let's enforce "api-id" header for user actions.

class KeywordRequest(BaseModel):
    keyword: str
    reply: str

class ChatMessageRequest(BaseModel):
    chat_id: int
    message: str

class Token(BaseModel):
    access_token: str
    token_type: str

class AuthRequest(BaseModel):
    api_id: str
    api_hash: str
    phone_number: str

class VerifyRequest(BaseModel):
    api_id: str
    phone_number: str
    code: str
    phone_code_hash: str

class PasswordRequest(BaseModel):
    api_id: str
    password: str

class ScheduledMessageRequest(BaseModel):
    id: Optional[str] = None
    chat_ids: List[int]
    message: str
    time: str # HH:MM
    active: bool = True
    usernames: Optional[List[str]] = []

# --- BotManager ---
class BotManager:
    def __init__(self):
        self.active_bots: Dict[str, TelegramClient] = {}
        self.pending_clients: Dict[str, TelegramClient] = {}
        self.last_reply_times: Dict[str, Dict[int, datetime]] = {} # {api_id: {chat_id: last_time}}
        self.locks: Dict[str, asyncio.Lock] = {}

    def _get_lock(self, api_id: str) -> asyncio.Lock:
        if api_id not in self.locks:
            self.locks[api_id] = asyncio.Lock()
        return self.locks[api_id]

    async def get_client(self, api_id: str, api_hash: str = None) -> TelegramClient:
        async with self._get_lock(api_id):
            if api_id in self.active_bots:
                return self.active_bots[api_id]
            
            if not api_hash:
                api_hash = await db.get_api_hash(api_id)
                
            if not api_hash:
                 raise ValueError(f"API Hash not found for {api_id}. Please login again.")

            user_data = await db.get_user_session(api_id)
            session = f"session_{api_id}"
            
            if user_data and user_data.get("session_string"):
                 session = StringSession(user_data.get("session_string"))
            
            client = TelegramClient(session, int(api_id), api_hash)
            await client.connect() 
            self.active_bots[api_id] = client
            return client

    async def get_profile_photo(self, api_id: str, peer_id: int):
        client = await self.get_client(api_id)
        if not client or not client.is_connected():
            return None
            
        encoded_peer = str(peer_id).replace("-", "m")
        file_path = f"static/photos/{encoded_peer}.jpg"
        
        if os.path.exists(file_path):
            return f"/static/photos/{encoded_peer}.jpg"
            
        try:
            entity = await client.get_input_entity(peer_id)
            path = await client.download_profile_photo(entity, file=file_path)
            if path:
                return f"/static/photos/{encoded_peer}.jpg"
        except Exception as e:
            print(f"Error downloading photo for {peer_id}: {e}")
            
        return None

    async def request_code(self, api_id: str, api_hash: str, phone: str):
        async with self._get_lock(api_id):
            if api_id in self.active_bots:
                return {"status": "authorized", "message": "Already authorized"}
            
            # Cleanup old pending client if exists
            if api_id in self.pending_clients:
                old_client = self.pending_clients[api_id]
                if old_client.is_connected():
                    await old_client.disconnect()
                del self.pending_clients[api_id]
                
            session_name = f"session_{api_id}"
            client = TelegramClient(session_name, int(api_id), api_hash)
            
            try:
                await client.connect()
                
                if await client.is_user_authorized():
                    await self._start_completed_client(client, api_id, api_hash)
                    return {"status": "authorized", "message": "Already authorized"}

                sent = await client.send_code_request(phone)
                self.pending_clients[api_id] = client
                print(f"Code sent successfully to {phone}")
                return {"status": "code_sent", "phone_code_hash": sent.phone_code_hash}
            except Exception as e:
                if client.is_connected():
                    await client.disconnect()
                
                error_msg = str(e)
                if "FLOOD_WAIT" in error_msg.upper():
                    print(f"⚠️ Flood Wait detected for {api_id}")
                    raise Exception(f"Telegram has temporarily blocked login attempts for this number/API. Please wait a few minutes and try again. ({error_msg})")
                
                print(f"❌ Request Code Error: {e}")
                raise e

    async def verify_code(self, api_id: str, phone: str, code: str, phone_code_hash: str):
        async with self._get_lock(api_id):
            if api_id not in self.pending_clients:
                print(f"❌ Pending client not found for {api_id}")
                raise Exception("Login session expired or server restarted. Please go back and request a new code.")
                
            client = self.pending_clients[api_id]
            try:
                print(f"Verifying code {code} for {api_id}...")
                await client.sign_in(phone=phone, code=code, phone_code_hash=phone_code_hash)
                
                # Success! Complete the login
                del self.pending_clients[api_id]
                me = await client.get_me()
                self.active_bots[api_id] = client
                self._attach_handlers(client, api_id)
                
                # CRITICAL: Save session string to DB
                session_str = client.session.save()
                
                # Get the actual API Hash used by the client
                api_hash = await db.get_api_hash(api_id)
                if not api_hash:
                    api_hash = "UNKNOWN"

                print(f"Code verified for {me.first_name}. Saving session...")
                await db.register_user_login(api_id, str(api_hash), me.first_name, me.username, session_string=session_str)
                
                return {
                    "status": "success",
                    "user": {
                        "id": me.id,
                        "first_name": me.first_name,
                        "username": me.username,
                        "phone": getattr(me, 'phone', phone)
                    }
                }
            except Exception as e:
                error_msg = str(e)
                # Check if Two-Step Verification password is required
                if "SessionPasswordNeededError" in str(type(e)) or "password" in error_msg.lower():
                    print(f"Two-Step Verification required for {api_id}")
                    return {
                        "status": "password_required",
                        "message": "Two-Step Verification is enabled. Please enter your password."
                    }
                
                print(f"❌ Verify Error: {e}")
                raise e

    async def verify_password(self, api_id: str, password: str):
        async with self._get_lock(api_id):
            if api_id not in self.pending_clients:
                raise Exception("Login session expired. Please start the login process again.")
            
            client = self.pending_clients[api_id]
            try:
                await client.sign_in(password=password)
                
                # Success! Complete the login
                del self.pending_clients[api_id]
                me = await client.get_me()
                self.active_bots[api_id] = client
                self._attach_handlers(client, api_id)
                
                # Save session string to DB
                session_str = client.session.save()
                await db.register_user_login(api_id, "HIDDEN", me.first_name, me.username, session_string=session_str)
                
                return {
                    "status": "success",
                    "user": {
                        "id": me.id,
                        "first_name": me.first_name,
                        "username": me.username,
                        "phone": getattr(me, 'phone', '')
                    }
                }
            except Exception as e:
                print(f"Password Verify Error: {e}")
                raise Exception(f"Incorrect password. Please try again. ({str(e)})")

    async def start_bot(self, api_id: str, api_hash: str):
        async with self._get_lock(api_id):
            if api_id in self.active_bots:
                return await self.active_bots[api_id].get_me()
            
            if api_id in self.pending_clients:
                client = self.pending_clients[api_id]
            else:
                user_data = await db.get_user_session(api_id)
                session = f"session_{api_id}"
                if user_data and user_data.get("session_string"):
                    session = StringSession(user_data.get("session_string"))
                client = TelegramClient(session, int(api_id), api_hash)

            if not client.is_connected():
                # For User Bots, start() handles connecting and basic auth check
                # If specialized auth is needed it should happen via Web UI first
                await client.connect()
                
            if not await client.is_user_authorized():
                 if api_id not in self.pending_clients:
                     await client.disconnect()
                 raise Exception("Session not authorized. Please login via Web UI first.")
            
            # Start the client (starts internal update loops)
            await client.start()
            
            if api_id in self.pending_clients:
                del self.pending_clients[api_id]
                
            await self._start_completed_client(client, api_id, api_hash)
            return await client.get_me()

    async def _start_completed_client(self, client, api_id, api_hash):
        self.active_bots[api_id] = client
        self._attach_handlers(client, api_id)
        
        me = await client.get_me()
        session_str = client.session.save()
        print(f"Bot Started for User: {me.first_name} (ID: {api_id})")
        await db.register_user_login(api_id, api_hash, me.first_name, me.username, session_string=session_str)

    async def get_dialogs(self, api_id: str, limit: int = 20):
        client = await self.get_client(api_id)
        if not client or not client.is_connected():
            return []
        
        dialogs = []
        async for d in client.iter_dialogs(limit=limit):
            dialogs.append({
                "id": d.id,
                "name": d.name,
                "message": d.message.message if d.message else "",
                "date": d.date.isoformat() if d.date else ""
            })
        return dialogs

    async def get_messages(self, api_id: str, chat_id: int, limit: int = 50):
        client = await self.get_client(api_id)
        if not client or not client.is_connected():
            return []

        messages = []
        async for m in client.iter_messages(chat_id, limit=limit):
            sender = await m.get_sender()
            sender_name = "Unknown"
            if sender:
                sender_name = getattr(sender, 'first_name', '') or getattr(sender, 'title', 'Unknown')

            media_info = None
            if m.media:
                if hasattr(m.media, 'photo') and m.media.photo:
                    media_info = {"type": "photo"}
                elif hasattr(m.media, 'document') and m.media.document:
                    mime_type = m.media.document.mime_type
                    filename = None
                    for attr in m.media.document.attributes:
                        if hasattr(attr, 'file_name'):
                            filename = attr.file_name
                            break
                    media_info = {"type": "document", "mime_type": mime_type, "filename": filename}

            messages.append({
                "id": m.id,
                "sender_id": m.sender_id,
                "sender_name": sender_name,
                "text": m.text,
                "date": m.date.isoformat(),
                "outgoing": m.out,
                "media": media_info
            })
        return messages

    async def download_media(self, api_id: str, chat_id: int, message_id: int):
        client = await self.get_client(api_id)
        if not client or not client.is_connected():
            return None

        message = await client.get_messages(chat_id, ids=message_id)
        if not message or not message.media:
            return None

        # Create cache directory
        cache_dir = f"static/downloads/{api_id}/{chat_id}"
        os.makedirs(cache_dir, exist_ok=True)
        
        # Determine filename
        filename = f"{message_id}"
        if hasattr(message.media, 'document') and message.media.document:
             for attr in message.media.document.attributes:
                if hasattr(attr, 'file_name') and attr.file_name:
                    filename = f"{message_id}_{attr.file_name}"
                    break
             # Try to guess extension from mime type if no filename
             if filename == str(message_id):
                  import mimetypes
                  ext = mimetypes.guess_extension(message.media.document.mime_type)
                  if ext:
                      filename += ext

        if hasattr(message.media, 'photo'):
             filename += ".jpg"

        file_path = os.path.join(cache_dir, filename)
        
        if os.path.exists(file_path):
            return file_path

        await client.download_media(message, file_path)
        return file_path

    async def send_message(self, api_id: str, chat_id: int, text: str, file_path: Optional[str] = None):
        client = await self.get_client(api_id)
        if not client or not client.is_connected():
            raise Exception("Bot not connected")
        
        if file_path:
             await client.send_message(chat_id, text, file=file_path)
        else:
             await client.send_message(chat_id, text)

    def _attach_handlers(self, client, api_id):
        # Fix: Prevent double handlers
        if getattr(client, "_handlers_attached", False):
            return

        @client.on(events.Raw())
        async def raw_handler(event):
            # Very verbose but helps see if ANY update is coming
            pass

        @client.on(events.NewMessage(incoming=True))
        async def handler(event):
            sender_id = event.chat_id
            text = event.message.message or ""
            
            print(f"\n[HANDLER] New Message from {sender_id}: '{text}' (Bot ID: {api_id})")
            
            # Fetch settings once for both keywords and auto-reply
            try:
                api_id_str = str(api_id)
                settings = await db.get_settings(api_id_str)
                is_active = settings.get('active', True)
                print(f"Bot {api_id_str} - System Active: {is_active}")

                # If global toggle is OFF, do nothing except broadcast to UI
                if is_active:
                    # 1. Keywords (Priority 1)
                    keywords = await db.get_keywords(api_id_str)
                    print(f"Checking {len(keywords)} keywords for message: '{text}'")
                    for k in keywords:
                        kw = k['keyword'].lower()
                        if kw and kw in text.lower():
                            print(f"Match found! Keyword: '{kw}', Reply: '{k['reply']}'")
                            await event.reply(k['reply'])
                            print(f"Keyword reply sent to {sender_id}")
                            return
                    
                    # 2. Auto Reply (Priority 2)
                    auto_reply_text = settings.get('auto_reply_text', "I am currently unavailable.")
                    wait_time = settings.get('wait_time', 10) # Now treated as Seconds
                    
                    # Initialize cooldown tracker for this bot
                    if api_id_str not in self.last_reply_times:
                        self.last_reply_times[api_id_str] = {}
                        
                    last_time = self.last_reply_times[api_id_str].get(sender_id)
                    now = datetime.utcnow()
                    
                    cooldown_ok = not last_time or (now - last_time).total_seconds() > wait_time
                    print(f"Cooldown Check: last_time={last_time}, wait_time={wait_time}s, ok={cooldown_ok}")

                    if cooldown_ok:
                        await event.reply(auto_reply_text)
                        self.last_reply_times[api_id_str][sender_id] = now
                        print(f"Auto-reply sent to {sender_id}")
                    else:
                        print(f"Cooldown active for {sender_id}, skipping auto-reply")
                else:
                    print(f"Bot {api_id_str} is inactive, skipping auto-replies")
            except Exception as e:
                print(f"Error in handler for {api_id_str}: {e}")
                import traceback
                traceback.print_exc()

            # 3. Always Broadcast to UI (even if inactive)
            try:
                sender = await event.get_sender()
                name = "Unknown"
                if sender:
                    name = getattr(sender, 'first_name', '') or getattr(sender, 'title', 'Unknown')
                    
                await manager.broadcast({
                    "type": "new_message",
                    "chat_id": sender_id,
                    "chat_name": name,
                    "text": text,
                    "date": event.message.date.isoformat(),
                    "outgoing": False
                })
            except Exception as e:
                print(f"Broadcast Error: {e}")

        client._handlers_attached = True

    async def initial_startup_from_db(self):
        """Restart all bot sessions saved in DB on server boot"""
        try:
            print("Fetching sessions from database...")
            sessions = await db.get_all_sessions()
            print(f"Found {len(sessions)} sessions in database.")
            for session_data in sessions:
                api_id = str(session_data.get("api_id"))
                api_hash = await db.get_api_hash(api_id)
                print(f"Starting bot for API ID: {api_id}...")
                if api_id and api_hash:
                    try:
                        await self.start_bot(api_id, api_hash)
                        print(f"Successfully started bot {api_id}")
                    except Exception as e:
                        print(f"Failed to autostart bot {api_id}: {e}")
            print("All bots processed from DB.")
        except Exception as e:
            print(f"CRITICAL STARTUP ERROR: {e}")
            import traceback
            traceback.print_exc()

    async def get_active_users(self):
        return list(self.active_bots.keys())
    
    async def stop_all(self):
        for client in self.active_bots.values():
            await client.disconnect()

    async def scheduler_loop(self):
        """Background task to send scheduled messages"""
        print("Starting Scheduled Message Loop...")
        while True:
            try:
                now = datetime.now() # Use local time as user likely sets it in their local time
                current_time = now.strftime("%H:%M")
                current_date = now.strftime("%Y-%m-%d")
                
                active_schedules = await db.get_all_active_scheduled_messages()
                
                for sched in active_schedules:
                    if sched.get("time") == current_time and sched.get("last_sent_date") != current_date:
                        owner_id = sched.get("owner_id")
                        if owner_id in self.active_bots:
                            client = self.active_bots[owner_id]
                            message = sched.get("message")
                            
                            # Send to chat IDs
                            for chat_id in sched.get("chat_ids", []):
                                try:
                                    await client.send_message(chat_id, message)
                                    print(f"Scheduled message sent to {chat_id} by {owner_id}")
                                except Exception as e:
                                    print(f"Error sending scheduled msg to {chat_id}: {e}")
                                    
                            # Send to usernames/prefixes
                            for username in sched.get("usernames", []):
                                try:
                                    await client.send_message(username, message)
                                    print(f"Scheduled message sent to {username} by {owner_id}")
                                except Exception as e:
                                    print(f"Error sending scheduled msg to {username}: {e}")

                            # Mark as sent for today
                            await db.mark_scheduled_message_sent(str(sched["_id"]), current_date)
            
            except Exception as e:
                print(f"Error in scheduler loop: {e}")
                import traceback
                traceback.print_exc()
            
            await asyncio.sleep(60) # Poll every minute

bot_manager = BotManager()

# --- Auth Helpers ---
def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt



async def get_current_admin(auth: HTTPAuthorizationCredentials = Depends(security)):
    # Check if any admin exists - if NOT, allow access to claim ownership
    if not await db.admin_exists():
        return "Unclaimed_Owner"

    if not auth:
        raise HTTPException(status_code=401, detail="Authentication required")
    token = auth.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        return username
    except JWTError as e:
        print(f"DEBUG: Admin JWT Error: {e}")
        raise HTTPException(status_code=401, detail="Invalid token")

async def get_current_user(auth: HTTPAuthorizationCredentials = Depends(security)):
    if not auth:
        raise HTTPException(status_code=401, detail="Authentication required")
    token = auth.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        api_id: str = payload.get("sub")
        token_type = payload.get("type", "user")
        if api_id is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        if token_type != "user":
            raise HTTPException(status_code=401, detail="Invalid user token")
        return str(api_id)
    except JWTError as e:
        print(f"DEBUG: User JWT Error: {e}")
        raise HTTPException(status_code=401, detail="Invalid token")

# --- Lifespan ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("--- LIFESPAN START ---")
    # Startup
    print("Initializing DB...")
    await db.init_db()
    print("DB Initialized.")
    
    # Load and start all bots from DB
    print("Starting Bots from DB...")
    await bot_manager.initial_startup_from_db()
    print("Bots Started.")

    # Start Scheduler
    asyncio.create_task(bot_manager.scheduler_loop())
    print("Scheduler Started.")

    print("--- LIFESPAN READY ---")
    yield
    # Shutdown
    print("--- LIFESPAN SHUTDOWN ---")
    await bot_manager.stop_all()

# Initialize FastAPI
app = FastAPI(lifespan=lifespan)

# Mount Static Files
app.mount("/static", StaticFiles(directory="static"), name="static")

# --- Admin Setup Models & Endpoints ---
class AdminSetupRequest(BaseModel):
    username: str
    password: str

@app.get("/api/admin/setup-check")
async def check_admin_setup():
    exists = await db.admin_exists()
    return {"setup_required": not exists}

@app.post("/api/admin/setup")
async def setup_admin(req: AdminSetupRequest):
    if await db.admin_exists():
        raise HTTPException(status_code=400, detail="Admin already exists")
    
    await db.create_initial_admin(req.username, req.password)
    return {"status": "success"}

# --- Routes ---

@app.get("/")
async def read_root():
    return FileResponse(os.path.join('static', 'index.html'))

@app.get("/admin")
async def read_admin():
    return FileResponse(os.path.join('static', 'admin.html'))

# 1. Auth Flow
@app.post("/api/auth/check-session")
async def check_session(req: LoginRequest):
    """Check if a valid session exists (in DB or locally)"""
    try:
        api_id = req.api_id.strip()
        api_hash = req.api_hash.strip()
        
        # 1. Check database first
        user_data = await db.get_user_session(api_id)
        has_db_session = user_data and user_data.get("session_string")
        
        # 2. Check local file if not in DB
        local_session_path = f"session_{api_id}.session"
        has_local_session = os.path.exists(local_session_path)

        if has_db_session or has_local_session:
            try:
                # Verify api_hash matches (decode from JWT)
                stored_hash = await db.get_api_hash(api_id) if user_data else None
                if stored_hash and stored_hash != api_hash:
                     print(f"⚠️ Hash mismatch for {api_id}")
                     return {"status": "not_found", "has_session": False}

                # Try to connect and verify
                client = await bot_manager.get_client(api_id, api_hash)
                if client and await client.is_user_authorized():
                    # If it was a local session or HIDDEN hash, update DB now 
                    if not has_db_session or stored_hash == "HIDDEN":
                        me = await client.get_me()
                        session_str = client.session.save()
                        print(f"Updating DB session for {api_id} with real data...")
                        await db.register_user_login(api_id, api_hash, me.first_name, me.username, session_string=session_str)
                    return {"status": "exists", "has_session": True}
            except Exception as e:
                print(f"Session validation failed for {api_id}: {e}")
        
        return {"status": "not_found", "has_session": False}
    except Exception as e:
        print(f"Check Session Error: {e}")
        return {"status": "error", "has_session": False, "message": str(e)}

@app.post("/api/auth/request-code")
async def request_code(req: AuthRequest):
    try:
        result = await bot_manager.request_code(req.api_id.strip(), req.api_hash.strip(), req.phone_number.strip())
        return result
    except Exception as e:
        print(f"Auth Error: {e}")
        return JSONResponse(status_code=400, content={"status": "error", "message": str(e)})

@app.post("/api/auth/verify-code")
async def verify_code(req: VerifyRequest):
    try:
        result = await bot_manager.verify_code(req.api_id.strip(), req.phone_number.strip(), req.code.strip(), req.phone_code_hash)
        return result
    except Exception as e:
        print(f"Verify Error: {e}")
        return JSONResponse(status_code=400, content={"status": "error", "message": str(e)})

@app.post("/api/auth/verify-password")
async def verify_password(req: PasswordRequest):
    try:
        result = await bot_manager.verify_password(req.api_id.strip(), req.password)
        return result
    except Exception as e:
        print(f"Password Verify Error: {e}")
        return JSONResponse(status_code=400, content={"status": "error", "message": str(e)})

# 4. Chat Interface
@app.get("/api/chats")
async def get_chats(api_id: str = Depends(get_current_user)):
    return await bot_manager.get_dialogs(api_id)

@app.get("/api/chats/{chat_id}/messages")
async def get_chat_messages(chat_id: int, api_id: str = Depends(get_current_user)):
    return await bot_manager.get_messages(api_id, chat_id)

@app.get("/api/photos/{peer_id}")
async def get_peer_photo(peer_id: int, api_id: str = Depends(get_current_user)):
    url = await bot_manager.get_profile_photo(api_id, peer_id)
    return {"url": url}

@app.get("/api/media/{chat_id}/{message_id}")
async def get_message_media(chat_id: int, message_id: int, api_id: str = Depends(get_current_user)):
    file_path = await bot_manager.download_media(api_id, chat_id, message_id)
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Media not found or failed to download")
    
    # Return file response
    return FileResponse(file_path)

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# --- Routes ---
# ...


@app.post("/api/chats/send")
async def send_chat_message(req: ChatMessageRequest, api_id: str = Depends(get_current_user)):
    await bot_manager.send_message(api_id, req.chat_id, req.message)
    return {"status": "success"}

@app.post("/api/chats/send-media")
async def send_chat_message_media(
    chat_id: int = Form(...),
    message: str = Form(""),
    file: UploadFile = File(...),
    api_id: str = Depends(get_current_user)
):
    # Save uploaded file temporarily
    temp_dir = "static/uploads"
    os.makedirs(temp_dir, exist_ok=True)
    file_path = os.path.join(temp_dir, file.filename)
    
    with open(file_path, "wb") as buffer:
        import shutil
        shutil.copyfileobj(file.file, buffer)
        
    try:
        await bot_manager.send_message(api_id, chat_id, message, file_path)
    finally:
        # Cleanup? Maybe keep for history? Let's keep for now or clean up later.
        # telethon sends the file, we can probably delete it after sending if we want to save space.
        # But for now let's just leave it or maybe delete.
        # await asyncio.to_thread(os.remove, file_path)
        pass

    return {"status": "success"}

# Legacy Login (Repurposed for Session Check / Connect)
@app.post("/api/login")
async def user_login(req: LoginRequest):
    try:
        # Start the bot for this user (assumes session exists)
        me = await bot_manager.start_bot(req.api_id.strip(), req.api_hash.strip())
        
        # If successful, generate token
        access_token = create_access_token(data={"sub": req.api_id.strip(), "type": "user"})
        
        user_info = {
            "id": getattr(me, 'id', None),
            "first_name": getattr(me, 'first_name', 'User'),
            "username": getattr(me, 'username', ''),
            "phone": getattr(me, 'phone', None)
        }

        return {
            "status": "success", 
            "message": "Bot connected successfully",
            "access_token": access_token,
            "token_type": "bearer",
            "user": user_info
        }
    except Exception as e:
        return JSONResponse(status_code=400, content={"status": "error", "message": str(e)})

# 2. User Settings (Requires Valid Token)
@app.get("/api/settings")
async def get_settings(api_id: str = Depends(get_current_user)):
    return await db.get_settings(api_id)

@app.post("/api/settings")
async def update_settings(settings: SettingsRequest, api_id: str = Depends(get_current_user)):
    await db.update_settings(api_id, settings.dict())
    return {"status": "success"}

# 3. User Keywords
@app.get("/api/keywords")
async def get_keywords(api_id: str = Depends(get_current_user)):
    return await db.get_keywords(api_id)

@app.post("/api/keywords")
async def add_keyword(req: KeywordRequest, api_id: str = Depends(get_current_user)):
    await db.add_keyword(api_id, req.keyword, req.reply)
    return {"status": "success"}

@app.delete("/api/keywords")
async def delete_keyword(keyword: str, api_id: str = Depends(get_current_user)):
    await db.delete_keyword(api_id, keyword)
    return {"status": "success"}

# 5. Scheduled Messages
@app.get("/api/scheduled-messages")
async def get_scheduled_messages(api_id: str = Depends(get_current_user)):
    msgs = await db.get_scheduled_messages(api_id)
    # Convert ObjectId to string
    for m in msgs:
        m["id"] = str(m["_id"])
        del m["_id"]
    return msgs

@app.post("/api/scheduled-messages")
async def add_scheduled_message(req: ScheduledMessageRequest, api_id: str = Depends(get_current_user)):
    data = req.dict()
    if data.get("id"):
        data["_id"] = data.pop("id")
    await db.add_scheduled_message(api_id, data)
    return {"status": "success"}

@app.delete("/api/scheduled-messages/{msg_id}")
async def delete_scheduled_message(msg_id: str, api_id: str = Depends(get_current_user)):
    await db.delete_scheduled_message(api_id, msg_id)
    return {"status": "success"}


# --- Admin Routes ---

@app.post("/api/admin/login", response_model=Token)
async def admin_login(req: AdminLoginRequest):
    user = await db.verify_admin(req.username, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    
    access_token = create_access_token(
        data={"sub": user["username"], "must_change": user.get("must_change_password", False)}
    )
    return {"access_token": access_token, "token_type": "bearer"}

@app.put("/api/admin/password")
async def change_password(req: PasswordChangeRequest, admin: str = Depends(get_current_admin)):
    # Verify old password
    user = await db.verify_admin(admin, req.old_password)
    if not user:
         raise HTTPException(status_code=400, detail="Old password incorrect")
    
    await db.change_admin_password(admin, req.new_password)
    return {"status": "success", "message": "Password updated"}

@app.get("/api/admin/check-status")
async def check_admin_status(auth: HTTPAuthorizationCredentials = Depends(security)):
    token = auth.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return {
            "username": payload.get("sub"),
            "must_change": payload.get("must_change")
        }
    except Exception:
         raise HTTPException(status_code=401, detail="Invalid token")

@app.get("/api/admin/users")
async def get_all_users_admin(admin: str = Depends(get_current_admin)):
    """Get all users from DB + their online status"""
    users = await db.get_all_users()
    active_ids = bot_manager.active_bots.keys()
    
    for u in users:
        u['is_online'] = u['api_id'] in active_ids
        
    return users

@app.get("/api/admin/users/{target_api_id}/keywords")
async def get_user_keywords_admin(target_api_id: str, admin: str = Depends(get_current_admin)):
    return await db.get_keywords(target_api_id)

@app.get("/api/admin/users/{target_api_id}/details")
async def get_user_details_admin(target_api_id: str, admin: str = Depends(get_current_admin)):
    """Get full user details including decoded API credentials"""
    user_data = await db.get_user_session(target_api_id)
    
    if not user_data:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Decode credentials from JWT
    decoded = await db.decode_user_credentials(target_api_id)
    
    # Get keywords
    keywords = await db.get_keywords(target_api_id)
    
    if decoded:
        return {
            "api_id": decoded.get("api_id"),
            "api_hash": decoded.get("api_hash"),
            "first_name": user_data.get("first_name"),
            "username": user_data.get("username"),
            "last_login": user_data.get("last_login"),
            "keywords": keywords
        }
    else:
        # Fallback for users stored before JWT implementation
        return {
            "api_id": user_data.get("api_id"),
            "api_hash": user_data.get("api_hash", "HIDDEN"),
            "first_name": user_data.get("first_name"),
            "username": user_data.get("username"),
            "last_login": user_data.get("last_login"),
            "keywords": keywords
        }

# Must be LAST
@app.get("/{full_path:path}")
async def catch_devtools(full_path: str):
    if "appspecific/com.chrome.devtools.json" in full_path:
        return JSONResponse({})
    # Return 404 for actually missing files
    raise HTTPException(status_code=404, detail="Not Found")

# --- Entry Point ---
if __name__ == "__main__":
    if sys.platform == 'win32':
        import warnings
        warnings.filterwarnings("ignore", category=DeprecationWarning)
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=False)