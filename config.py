"""
কনফিগারেশন ফাইল - সব সেটিংস এক জায়গায়
"""

import os
from dotenv import load_dotenv

# .env ফাইল থেকে ভেরিয়েবল লোড করুন
load_dotenv()

# ===== API তথ্য =====
API_ID = int(os.environ["TG_API_ID"]) if os.environ.get("TG_API_ID") else None
API_HASH = os.environ.get("TG_API_HASH")
PHONE_NUMBER = os.environ.get("TG_PHONE")

# ===== বট সেটিংস =====
SESSION_NAME = os.environ.get("TG_SESSION_NAME", "autoreply_session")
WAIT_TIME = int(os.environ.get("WAIT_TIME", "10"))  # সেকেন্ডে
ACTIVE = True

# ===== অটো-রিপ্লাই মেসেজ =====
AUTO_REPLY_TEXT = os.environ.get("AUTO_REPLY_TEXT", "😴 Boss sleeping, keep wait for boss.")

# ===== টাইম সেটিংস =====
SLEEP_START_HOUR = 22  # রাত ১০টা
SLEEP_END_HOUR = 8     # সকাল ৮টা

# ===== এক্সক্লুডেড ইউজারদের ID =====
# যাদেরকে অটো-রিপ্লাই দেবে না
EXCLUDED_USERS = []  # খালি রাখুন, পরে যোগ করতে পারেন

# ===== লগিং সেটিংস =====
LOG_TO_FILE = True
LOG_FILE = 'bot_log.txt'