import asyncio
import os
import sys

# Force UTF-8 encoding for Windows console
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except AttributeError:
        pass  # Python < 3.7

from fastapi import FastAPI, HTTPException, Depends, WebSocket, WebSocketDisconnect, Header, Body, UploadFile, File, Form, Request, Response
# from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
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
import time

# Import Database Module
import database as db
from contextlib import asynccontextmanager

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

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
            except Exception as e:
                logger.error(f"WebSocket broadcast error: {e}")

manager = ConnectionManager()
# security = HTTPBearer(auto_error=False)

# --- Configuration & Constants ---
SECRET_KEY = "supersecretkey_change_this_in_production"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

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
    active: bool = True
    auto_reply_text: str = "I am currently unavailable. I will reply to you shortly."
    wait_time: int = 3600

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
    chat_ids: List[int] = []
    message: str
    time: str  # HH:MM
    active: bool = True
    usernames: Optional[List[str]] = []

# --- BotManager ---
class BotManager:
    def __init__(self):
        self.active_bots: Dict[str, TelegramClient] = {}
        self.pending_clients: Dict[str, TelegramClient] = {}
        self.last_reply_times: Dict[str, Dict[int, float]] = {}  # {api_id: {chat_id: timestamp}}
        self.locks: Dict[str, asyncio.Lock] = {}
        self.message_handlers = {}

    def _get_lock(self, api_id: str) -> asyncio.Lock:
        if api_id not in self.locks:
            self.locks[api_id] = asyncio.Lock()
        return self.locks[api_id]

    async def get_client(self, api_id: str, api_hash: str = None) -> TelegramClient:
        async with self._get_lock(api_id):
            # Return if already active
            if api_id in self.active_bots:
                client = self.active_bots[api_id]
                if client.is_connected():
                    return client
            
            # Get API hash if not provided
            if not api_hash:
                api_hash = await db.get_api_hash(api_id)
                if not api_hash:
                    raise ValueError(f"API Hash not found for {api_id}. Please login again.")
            
            # Get session from database
            user_data = await db.get_user_session(api_id)
            session_string = None
            
            if user_data and user_data.get("session_string"):
                session_string = user_data.get("session_string")
                logger.info(f"Found session string for {api_id}")
            else:
                logger.warning(f"No session string found for {api_id}")
            
            # Create client
            try:
                # Always use StringSession. If session_string is None, it creates an empty session.
                session = StringSession(session_string or "")
                client = TelegramClient(session, int(api_id), api_hash)
                logger.info(f"Initialized client for {api_id} using StringSession")
            except Exception as e:
                logger.error(f"Error creating session from string: {e}")
                # Fallback to empty StringSession instead of file
                client = TelegramClient(StringSession(""), int(api_id), api_hash)
            
            # Connect and authenticate
            try:
                if not client.is_connected():
                    await client.connect()
                
                # Check if already authorized
                if not await client.is_user_authorized():
                    logger.warning(f"Client {api_id} not authorized. Need to login.")
                    raise Exception(f"Session not authorized. Please login via Web UI.")
                
                # Start the client
                await client.start()
                
                # Attach handlers if not already attached
                if api_id not in self.message_handlers:
                    self._attach_handlers(client, api_id)
                    self.message_handlers[api_id] = True
                
                # Store and return
                self.active_bots[api_id] = client
                logger.info(f"[SUCCESS] Bot started successfully for {api_id}")
                
                # Get user info and update DB
                try:
                    me = await client.get_me()
                    current_session = client.session.save()
                    await db.register_user_login(
                        api_id, 
                        api_hash, 
                        me.first_name, 
                        me.username, 
                        session_string=current_session
                    )
                except Exception as e:
                    logger.error(f"Error updating user info: {e}")
                
                return client
                
            except Exception as e:
                logger.error(f"Error starting bot {api_id}: {e}")
                if client.is_connected():
                    await client.disconnect()
                raise

    async def request_code(self, api_id: str, api_hash: str, phone: str):
        async with self._get_lock(api_id):
            # Cleanup old pending client
            if api_id in self.pending_clients:
                old_client = self.pending_clients[api_id]
                if old_client.is_connected():
                    await old_client.disconnect()
                del self.pending_clients[api_id]
            
            # Create new client with empty StringSession to prevent file creation
            client = TelegramClient(StringSession(""), int(api_id), api_hash)
            
            try:
                await client.connect()
                
                # Check if already authorized
                if await client.is_user_authorized():
                    await self._start_completed_client(client, api_id, api_hash)
                    return {"status": "authorized", "message": "Already authorized"}
                
                # Request code
                sent = await client.send_code_request(phone)
                self.pending_clients[api_id] = client
                logger.info(f"[SUCCESS] Code sent successfully to {phone}")
                return {"status": "code_sent", "phone_code_hash": sent.phone_code_hash}
                
            except Exception as e:
                error_msg = str(e)
                if "FLOOD_WAIT" in error_msg.upper():
                    logger.warning(f"[WARNING] Flood Wait for {api_id}")
                    raise Exception(f"Telegram flood wait. Please wait and try again.")
                
                logger.error(f"[ERROR] Request Code Error: {e}")
                if client.is_connected():
                    await client.disconnect()
                raise

    async def verify_code(self, api_id: str, phone: str, code: str, phone_code_hash: str):
        async with self._get_lock(api_id):
            if api_id not in self.pending_clients:
                raise Exception("Login session expired. Please request a new code.")
            
            client = self.pending_clients[api_id]
            try:
                # Sign in with code
                await client.sign_in(phone=phone, code=code, phone_code_hash=phone_code_hash)
                
                # Success - complete setup
                del self.pending_clients[api_id]
                await self._start_completed_client(client, api_id, client.api_hash)
                
                me = await client.get_me()
                return {
                    "status": "success",
                    "user": {
                        "id": me.id,
                        "first_name": me.first_name or "",
                        "username": me.username or "",
                        "phone": getattr(me, 'phone', phone)
                    }
                }
                
            except Exception as e:
                error_msg = str(e)
                if "SessionPasswordNeededError" in str(type(e)):
                    logger.info(f"Two-Step Verification required for {api_id}")
                    return {
                        "status": "password_required",
                        "message": "Two-Step Verification is enabled. Please enter your password."
                    }
                
                logger.error(f"[ERROR] Verify Error: {e}")
                raise

    async def verify_password(self, api_id: str, password: str):
        async with self._get_lock(api_id):
            if api_id not in self.pending_clients:
                raise Exception("Login session expired.")
            
            client = self.pending_clients[api_id]
            try:
                await client.sign_in(password=password)
                
                # Success
                del self.pending_clients[api_id]
                await self._start_completed_client(client, api_id, client.api_hash)
                
                me = await client.get_me()
                return {
                    "status": "success",
                    "user": {
                        "id": me.id,
                        "first_name": me.first_name or "",
                        "username": me.username or "",
                        "phone": getattr(me, 'phone', '')
                    }
                }
            except Exception as e:
                logger.error(f"Password Verify Error: {e}")
                raise Exception(f"Incorrect password. Please try again.")

    async def _start_completed_client(self, client, api_id, api_hash):
        """Complete client setup after successful login"""
        try:
            # Start the client
            await client.start()
            
            # Attach handlers
            self._attach_handlers(client, api_id)
            self.message_handlers[api_id] = True
            
            # Store in active bots
            self.active_bots[api_id] = client
            
            # Save session to database
            me = await client.get_me()
            session_str = client.session.save()
            
            await db.register_user_login(
                api_id, 
                api_hash, 
                me.first_name, 
                me.username, 
                session_string=session_str
            )
            
            logger.info(f"[SUCCESS] Client setup completed for {api_id} - {me.first_name}")
            
        except Exception as e:
            logger.error(f"Error in _start_completed_client: {e}")
            raise

    async def start_bot(self, api_id: str, api_hash: str):
        """Start bot with existing session"""
        return await self.get_client(api_id, api_hash)

    async def get_dialogs(self, api_id: str, limit: int = 50):
        client = await self.get_client(api_id)
        dialogs = []
        
        try:
            async for dialog in client.iter_dialogs(limit=limit):
                dialogs.append({
                    "id": dialog.id,
                    "name": dialog.name or "Unknown",
                    "message": dialog.message.text if dialog.message else "",
                    "date": dialog.date.isoformat() if dialog.date else ""
                })
        except Exception as e:
            logger.error(f"Error getting dialogs for {api_id}: {e}")
        
        return dialogs

    async def get_messages(self, api_id: str, chat_id: int, limit: int = 50):
        client = await self.get_client(api_id)
        messages = []
        
        try:
            async for message in client.iter_messages(chat_id, limit=limit):
                sender = await message.get_sender()
                sender_name = "Unknown"
                if sender:
                    sender_name = getattr(sender, 'first_name', '') or getattr(sender, 'title', 'Unknown')
                
                media_info = None
                if message.media:
                    if hasattr(message.media, 'photo'):
                        media_info = {"type": "photo"}
                    elif hasattr(message.media, 'document'):
                        mime_type = message.media.document.mime_type
                        filename = None
                        for attr in message.media.document.attributes:
                            if hasattr(attr, 'file_name'):
                                filename = attr.file_name
                                break
                        media_info = {"type": "document", "mime_type": mime_type, "filename": filename}
                
                messages.append({
                    "id": message.id,
                    "sender_id": message.sender_id,
                    "sender_name": sender_name,
                    "text": message.text or "",
                    "date": message.date.isoformat(),
                    "outgoing": message.out,
                    "media": media_info
                })
        except Exception as e:
            logger.error(f"Error getting messages for {api_id}: {e}")
        
        # Reverse to show newest at bottom
        messages.reverse()
        return messages

    async def download_media(self, api_id: str, chat_id: int, message_id: int):
        """Media download is disabled for local storage safety.
        In a production environment, this should stream directly to the client or use cloud storage."""
        logger.warning(f"Media download requested but local storage is disabled. (Bot: {api_id}, Chat: {chat_id})")
        return None

    async def send_message(self, api_id: str, chat_id: int, text: str, file_path: Optional[str] = None):
        client = await self.get_client(api_id)
        
        try:
            if file_path and os.path.exists(file_path):
                await client.send_file(chat_id, file_path, caption=text)
            else:
                await client.send_message(chat_id, text)
            
            # Broadcast to WebSocket
            await manager.broadcast({
                "type": "message_sent",
                "chat_id": chat_id,
                "text": text,
                "date": datetime.utcnow().isoformat()
            })
            
            return True
        except Exception as e:
            logger.error(f"Error sending message: {e}")
            raise

    def _attach_handlers(self, client, api_id):
        """Attach event handlers to client"""
        
        @client.on(events.NewMessage(incoming=True))
        async def handle_new_message(event):
            try:
                sender_id = event.chat_id
                text = event.message.text or ""
                current_time = time.time()
                
                logger.info(f"[MSG] New message from {sender_id}: '{text[:50]}...' (Bot: {api_id})")
                
                # Get settings
                settings = await db.get_settings(api_id)
                
                if not settings.get("active", True):
                    logger.info(f"Bot {api_id} is inactive, skipping reply")
                    return
                
                # 1. Check keywords first
                keywords = await db.get_keywords(api_id)
                for keyword_data in keywords:
                    keyword = keyword_data.get("keyword", "").lower()
                    if keyword and keyword in text.lower():
                        reply_text = keyword_data.get("reply", "")
                        if reply_text:
                            await event.reply(reply_text)
                            logger.info(f"[SUCCESS] Keyword reply sent for '{keyword}' to {sender_id}")
                            return
                
                # 2. Auto-reply with cooldown
                auto_reply_text = settings.get("auto_reply_text", "")
                wait_time = settings.get("wait_time", 3600)  # Default 1 hour
                
                # Initialize cooldown tracker
                if api_id not in self.last_reply_times:
                    self.last_reply_times[api_id] = {}
                
                last_reply = self.last_reply_times[api_id].get(sender_id, 0)
                time_since_last = current_time - last_reply
                
                if time_since_last > wait_time and auto_reply_text:
                    await event.reply(auto_reply_text)
                    self.last_reply_times[api_id][sender_id] = current_time
                    logger.info(f"[SUCCESS] Auto-reply sent to {sender_id}")
                elif auto_reply_text:
                    logger.info(f"[COOLDOWN] Cooldown active for {sender_id} ({int(wait_time - time_since_last)}s remaining)")
                
                # 3. Broadcast to WebSocket
                sender = await event.get_sender()
                sender_name = getattr(sender, 'first_name', '') or getattr(sender, 'title', 'Unknown')
                
                await manager.broadcast({
                    "type": "new_message",
                    "chat_id": sender_id,
                    "chat_name": sender_name,
                    "text": text,
                    "date": event.message.date.isoformat(),
                    "outgoing": False
                })
                
            except Exception as e:
                logger.error(f"Error in message handler for {api_id}: {e}")

        # Mark as attached
        client._handlers_attached = True
        logger.info(f"[SUCCESS] Handlers attached for bot {api_id}")

    async def get_profile_photo(self, api_id: str, peer_id: int):
        """Profile photo caching is disabled to avoid local storage usage."""
        return None

    async def initial_startup_from_db(self):
        """Start all bots from database on server startup"""
        try:
            logger.info("[STARTUP] Starting bots from database...")
            sessions = await db.get_all_sessions()
            logger.info(f"Found {len(sessions)} sessions in database")
            
            for session_data in sessions:
                api_id = session_data.get("api_id")
                if not api_id:
                    continue
                
                try:
                    # Get API hash
                    api_hash = await db.get_api_hash(api_id)
                    if not api_hash:
                        logger.warning(f"No API hash for {api_id}, skipping")
                        continue
                    
                    # Start bot
                    await self.get_client(api_id, api_hash)
                    logger.info(f"[SUCCESS] Bot started for {api_id}")
                    
                except Exception as e:
                    logger.error(f"❌ Failed to start bot {api_id}: {e}")
            
            logger.info("[SUCCESS] All bots processed")
        except Exception as e:
            logger.error(f"CRITICAL STARTUP ERROR: {e}")

    async def scheduler_loop(self):
        """Background task for scheduled messages"""
        logger.info("[SCHEDULER] Starting scheduler loop...")
        
        while True:
            try:
                now = datetime.now()
                current_time = now.strftime("%H:%M")
                current_date = now.strftime("%Y-%m-%d")
                
                schedules = await db.get_all_active_scheduled_messages()
                
                for schedule in schedules:
                    if schedule.get("time") == current_time:
                        owner_id = schedule.get("owner_id")
                        last_sent = schedule.get("last_sent_date")
                        
                        if last_sent != current_date and owner_id in self.active_bots:
                            client = self.active_bots[owner_id]
                            message = schedule.get("message", "")
                            chat_ids = schedule.get("chat_ids", [])
                            usernames = schedule.get("usernames", [])
                            
                            # Send to chat IDs
                            for chat_id in chat_ids:
                                try:
                                    await client.send_message(chat_id, message)
                                    logger.info(f"📨 Scheduled message sent to {chat_id}")
                                except Exception as e:
                                    logger.error(f"Error sending to {chat_id}: {e}")
                            
                            # Send to usernames
                            for username in usernames:
                                try:
                                    await client.send_message(username, message)
                                    logger.info(f"📨 Scheduled message sent to {username}")
                                except Exception as e:
                                    logger.error(f"Error sending to {username}: {e}")
                            
                            # Mark as sent
                            await db.mark_scheduled_message_sent(str(schedule["_id"]), current_date)
                
                await asyncio.sleep(60)  # Check every minute
                
            except Exception as e:
                logger.error(f"Scheduler error: {e}")
                await asyncio.sleep(60)

    async def stop_all(self):
        """Stop all bots"""
        for api_id, client in self.active_bots.items():
            try:
                if client.is_connected():
                    await client.disconnect()
                    logger.info(f"Bot {api_id} disconnected")
            except Exception as e:
                logger.error(f"Error disconnecting {api_id}: {e}")

bot_manager = BotManager()

# --- Auth Helpers ---
def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

async def get_current_admin(request: Request):
    if not await db.admin_exists():
        return "Unclaimed_Owner"
    
    token = request.cookies.get("admin_token")
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        if not username or payload.get("type") != "admin":
            raise HTTPException(status_code=401, detail="Invalid token")
        return username
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

async def get_current_user(request: Request):
    token = request.cookies.get("user_token")
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        api_id = payload.get("sub")
        token_type = payload.get("type")
        
        if not api_id or token_type != "user":
            raise HTTPException(status_code=401, detail="Invalid token")
        
        return api_id
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
# lifespan
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    print("--- STARTING APPLICATION ---")
    
    try:
        # Initialize database
        print("Initializing DB...")
        success = await db.init_db()
        if not success:
            print("WARNING: Database initialization may have issues")
        else:
            print("DB Initialized.")
        
        # Load and start all bots from DB
        print("Starting Bots from DB...")
        await bot_manager.initial_startup_from_db()
        print("Bots Started.")

        # Start Scheduler
        asyncio.create_task(bot_manager.scheduler_loop())
        print("Scheduler Started.")

        print("--- APPLICATION READY ---")
        yield
        
    except Exception as e:
        print(f"Startup error: {e}")
        import traceback
        traceback.print_exc()
        raise
    
    finally:
        # Shutdown
        print("--- SHUTTING DOWN ---")
        await bot_manager.stop_all()
        print("All bots stopped")

# Initialize FastAPI
app = FastAPI(
    title="Telegram Bot System",
    description="Auto-reply and management system for Telegram",
    version="2.0.0",
    lifespan=lifespan
)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# --- Models ---
class AdminSetupRequest(BaseModel):
    username: str
    password: str

# --- Admin Endpoints ---
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

@app.post("/api/admin/login")
async def admin_login(req: AdminLoginRequest, response: Response):
    user = await db.verify_admin(req.username, req.password)
    if not user:
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    
    access_token = create_access_token(
        data={
            "sub": user["username"],
            "must_change": user.get("must_change_password", False),
            "type": "admin"
        }
    )
    
    # Set cookie
    response = JSONResponse(content={"status": "success"})
    response.set_cookie(
        key="admin_token",
        value=access_token,
        httponly=True,
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        samesite="lax"
    )
    return response

@app.post("/api/admin/logout")
async def admin_logout(response: Response):
    response.delete_cookie("admin_token")
    return {"status": "success"}

@app.put("/api/admin/password")
async def change_admin_password(req: PasswordChangeRequest, response: Response, admin: str = Depends(get_current_admin)):
    # Verify old password
    user = await db.verify_admin(admin, req.old_password)
    if not user:
        raise HTTPException(status_code=400, detail="Old password incorrect")
    
    await db.change_admin_password(admin, req.new_password)
    
    # Issue a NEW token with must_change=False
    access_token = create_access_token(
        data={
            "sub": admin,
            "must_change": False,
            "type": "admin"
        }
    )
    
    response.set_cookie(
        key="admin_token",
        value=access_token,
        httponly=True,
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        samesite="lax"
    )
    
    return {"status": "success"}

@app.get("/api/admin/check-status")
async def check_admin_status(request: Request):
    token = request.cookies.get("admin_token")
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required")
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload.get("sub")
        
        # Check database for actual status to prevent stale JWT redirects
        user = db.admin_collection.find_one({"username": username})
        must_change = user.get("must_change_password", False) if user else payload.get("must_change", False)
        
        return {
            "username": username,
            "must_change": must_change
        }
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

@app.get("/api/admin/users")
async def get_all_users_admin(admin: str = Depends(get_current_admin)):
    users = await db.get_all_users()
    active_ids = bot_manager.active_bots.keys()
    
    for user in users:
        user['is_online'] = user['api_id'] in active_ids
        
    return users

@app.get("/api/admin/users/{api_id}/details")
async def get_user_details_admin(api_id: str, admin: str = Depends(get_current_admin)):
    user_data = await db.decode_user_credentials(api_id)
    if not user_data:
        raise HTTPException(status_code=404, detail="User not found")
    
    keywords = await db.get_keywords(api_id)
    user_info = await db.get_user_session(api_id)
    
    return {
        "api_id": user_data.get("api_id"),
        "api_hash": user_data.get("api_hash", "HIDDEN"),
        "first_name": user_info.get("first_name") if user_info else None,
        "username": user_info.get("username") if user_info else None,
        "last_login": user_info.get("last_login") if user_info else None,
        "keywords": keywords
    }

# --- User Authentication ---
@app.post("/api/auth/check-session")
async def check_session(req: LoginRequest):
    try:
        user_data = await db.get_user_session(req.api_id)
        if user_data and user_data.get("session_string"):
            return {"status": "exists", "has_session": True}
        return {"status": "not_found", "has_session": False}
    except Exception as e:
        logger.error(f"Check session error: {e}")
        return {"status": "error", "has_session": False, "message": str(e)}

@app.post("/api/auth/request-code")
async def request_code(req: AuthRequest):
    try:
        result = await bot_manager.request_code(req.api_id, req.api_hash, req.phone_number)
        return result
    except Exception as e:
        logger.error(f"Request code error: {e}")
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": str(e)}
        )

@app.post("/api/auth/verify-code")
async def verify_code(req: VerifyRequest):
    try:
        result = await bot_manager.verify_code(
            req.api_id, 
            req.phone_number, 
            req.code, 
            req.phone_code_hash
        )
        return result
    except Exception as e:
        logger.error(f"Verify code error: {e}")
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": str(e)}
        )

@app.post("/api/auth/verify-password")
async def verify_password(req: PasswordRequest):
    try:
        result = await bot_manager.verify_password(req.api_id, req.password)
        return result
    except Exception as e:
        logger.error(f"Verify password error: {e}")
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": str(e)}
        )

@app.post("/api/login")
async def user_login(req: LoginRequest, response: Response):
    try:
        # Start the bot
        await bot_manager.start_bot(req.api_id, req.api_hash)
        
        # Generate token
        access_token = create_access_token(
            data={"sub": req.api_id, "type": "user"}
        )
        
        # Get user info
        user_data = await db.get_user_session(req.api_id)
        user_info = {
            "id": req.api_id,
            "first_name": user_data.get("first_name", "User") if user_data else "User",
            "username": user_data.get("username", "") if user_data else "",
            "phone": user_data.get("phone_number", "") if user_data else ""
        }
        
        # Set cookie
        response.set_cookie(
            key="user_token",
            value=access_token,
            httponly=True,
            max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
            samesite="lax"
        )
        return {
            "status": "success",
            "user": user_info
        }
    except Exception as e:
        logger.error(f"Login error: {e}")
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": str(e)}
        )

@app.get("/api/auth/profile")
async def get_user_profile(api_id: str = Depends(get_current_user)):
    user_data = await db.get_user_session(api_id)
    if not user_data:
        raise HTTPException(status_code=404, detail="User not found")
    return {
        "id": api_id,
        "first_name": user_data.get("first_name", "User"),
        "username": user_data.get("username", ""),
        "phone": user_data.get("phone_number", "")
    }

@app.post("/api/logout")
async def user_logout(response: Response):
    response.delete_cookie("user_token")
    return {"status": "success"}

# --- User Settings ---
@app.get("/api/settings")
async def get_user_settings(api_id: str = Depends(get_current_user)):
    return await db.get_settings(api_id)

@app.post("/api/settings")
async def update_user_settings(
    settings: SettingsRequest, 
    api_id: str = Depends(get_current_user)
):
    await db.update_settings(api_id, settings.dict())
    return {"status": "success"}

# --- Keywords ---
@app.get("/api/keywords")
async def get_user_keywords(api_id: str = Depends(get_current_user)):
    return await db.get_keywords(api_id)

@app.post("/api/keywords")
async def add_user_keyword(
    req: KeywordRequest, 
    api_id: str = Depends(get_current_user)
):
    await db.add_keyword(api_id, req.keyword, req.reply)
    return {"status": "success"}

@app.delete("/api/keywords")
async def delete_user_keyword(
    keyword: str, 
    api_id: str = Depends(get_current_user)
):
    await db.delete_keyword(api_id, keyword)
    return {"status": "success"}

# --- Chats ---
@app.get("/api/chats")
async def get_user_chats(api_id: str = Depends(get_current_user)):
    return await bot_manager.get_dialogs(api_id)

@app.get("/api/chats/{chat_id}/messages")
async def get_chat_messages(
    chat_id: int, 
    api_id: str = Depends(get_current_user)
):
    return await bot_manager.get_messages(api_id, chat_id)

@app.post("/api/chats/send")
async def send_chat_message(
    req: ChatMessageRequest, 
    api_id: str = Depends(get_current_user)
):
    await bot_manager.send_message(api_id, req.chat_id, req.message)
    return {"status": "success"}

@app.post("/api/chats/send-media")
async def send_chat_message_media(
    chat_id: int = Form(...),
    message: str = Form(""),
    file: UploadFile = File(...),
    api_id: str = Depends(get_current_user)
):
    # Save uploaded file
    temp_dir = "static/uploads"
    os.makedirs(temp_dir, exist_ok=True)
    file_path = os.path.join(temp_dir, file.filename)
    
    with open(file_path, "wb") as buffer:
        content = await file.read()
        buffer.write(content)
    
    try:
        await bot_manager.send_message(api_id, chat_id, message, file_path)
        return {"status": "success"}
    finally:
        # Cleanup
        try:
            os.remove(file_path)
        except:
            pass

# --- Media ---
@app.get("/api/photos/{peer_id}")
async def get_peer_photo(
    peer_id: int, 
    api_id: str = Depends(get_current_user)
):
    url = await bot_manager.get_profile_photo(api_id, peer_id)
    return {"url": url if url else None}

@app.get("/api/media/{chat_id}/{message_id}")
async def get_message_media(
    chat_id: int, 
    message_id: int, 
    api_id: str = Depends(get_current_user)
):
    file_path = await bot_manager.download_media(api_id, chat_id, message_id)
    if not file_path or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Media not found")
    
    return FileResponse(file_path)

# --- Scheduled Messages ---
@app.get("/api/scheduled-messages")
async def get_scheduled_messages(api_id: str = Depends(get_current_user)):
    return await db.get_scheduled_messages(api_id)

@app.post("/api/scheduled-messages")
async def add_scheduled_message(
    req: ScheduledMessageRequest, 
    api_id: str = Depends(get_current_user)
):
    data = req.dict()
    if data.get("id"):
        data["_id"] = data.pop("id")
    await db.add_scheduled_message(api_id, data)
    return {"status": "success"}

@app.delete("/api/scheduled-messages/{msg_id}")
async def delete_scheduled_message(
    msg_id: str, 
    api_id: str = Depends(get_current_user)
):
    await db.delete_scheduled_message(api_id, msg_id)
    return {"status": "success"}

# --- WebSocket ---
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# --- Static Routes ---
@app.get("/")
async def read_root():
    return FileResponse("static/index.html")

@app.get("/admin")
async def read_admin():
    return FileResponse("static/admin.html")

# --- Entry Point ---
if __name__ == "__main__":
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,
        log_level="info"
    )