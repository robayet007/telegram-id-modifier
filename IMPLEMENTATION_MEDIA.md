# Media Support Implementation Plan

## Goal
Enable viewing and sending of images and files (A-z data) within the chat interface.

## Changes

### Backend (`main.py`)
1.  **Updated `BotManager.get_messages`**:
    *   Now extracts `media` information from Telethon message objects.
    *   Returns a `media` dict with `type` (photo/document), `filename`, and `mime_type`.
2.  **Added `BotManager.download_media`**:
    *   Downloads media from Telegram on demand.
    *   Caches downloads in `static/downloads/{api_id}/{chat_id}/` to improve performance.
    *   Handles filename and extension guessing.
3.  **Added `GET /api/media/{chat_id}/{message_id}`**:
    *   Endpoint to retrieve/download the media file for a message.
4.  **Added `POST /api/chats/send-media`**:
    *   New endpoint to handle `multipart/form-data` uploads.
    *   Accepts `file`, `chat_id`, and `message`.
5.  **Updated `BotManager.send_message`**:
    *   Now accepts an optional `file_path` argument to send files via Telethon.

### Frontend (`static/js/app.js`)
1.  **Updated `appendMessage`**:
    *   Checks for `msg.media` property.
    *   Renders `<img>` tags for photos (clicking opens original).
    *   Renders file icons and filenames for documents (clicking opens/downloads).
    *   Uses the new `/api/media/...` endpoint as the source.
2.  **Updated `sendChatMessage`**:
    *   Detects if a file is selected in the UI.
    *   Uses `FormData` and calls `/api/chats/send-media` if a file is present.
    *   Optimistically appends the message with a local preview (based on file type).
3.  **File Handling Logic**:
    *   Added `handleFileSelect` and `clearFile` functions to manage the file input state.
    *   Added `selectedFile` global variable.

### Frontend UI (`static/index.html`)
1.  **Chat Input Area**:
    *   Added a hidden `<input type="file">`.
    *   Added a "Paperclip" icon button to trigger the file input.
    *   Added a dismissible file preview container to show the selected filename before sending.

## usage
- **Viewing**: Images appear automatically in the chat. Files appear as downloadable links.
- **Sending**: Click the attachment icon (paperclip) next to the input box, select a file, and click send. You can add a caption in the text box.
