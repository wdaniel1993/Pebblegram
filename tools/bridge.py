#!/usr/bin/env python3
"""
Pebblegram bridge.

Default mode is an in-memory mock so the watch app can be developed and tested
without Telegram credentials. If Telethon is installed and TELEGRAM_API_ID,
TELEGRAM_API_HASH, and TELEGRAM_PHONE are set, the same HTTP API uses your
personal Telegram account.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

try:
    from PIL import Image, ImageDraw, ImageOps
except ImportError:  # pragma: no cover - bridge can still serve mock text data
    Image = None
    ImageDraw = None
    ImageOps = None


MOCK_PHOTO_PATH = Path(__file__).resolve().parents[1] / "store" / "screenshots" / "1280px-Gioconda_(copia_del_Museo_del_Prado_restaurada).png"

MOCK_CHATS = [
    {
        "id": "family",
        "title": "Family Group",
        "preview": "Jamie: My favorite painting.",
        "unread": True,
    },
    {
        "id": "house",
        "title": "House Chat",
        "preview": "Morgan: The plumber moved the appointment to 4:30.",
        "unread": False,
    },
    {
        "id": "workbench",
        "title": "Workbench Friends",
        "preview": "Sam: I pushed a cleaner build for the round screen.",
        "unread": True,
    },
    {
        "id": "bookclub",
        "title": "Book Club",
        "preview": "Nina: Chapter six finally made the whole thing click.",
        "unread": False,
    },
    {
        "id": "coffee",
        "title": "Coffee Tomorrow",
        "preview": "Priya: 8:15 still works if the train is on time.",
        "unread": True,
    },
    {
        "id": "parents",
        "title": "Parents",
        "preview": "Mom: Send the photo when you get a chance.",
        "unread": False,
    },
    {
        "id": "studio",
        "title": "Studio Notes",
        "preview": "Leo: The smaller crop looks better on the watch.",
        "unread": False,
    },
]

MOCK_MESSAGES = {
    "family": [
        {"id": "m1", "sender": "Alex", "text": "Museum day was a good call. The renovated wing is much easier to walk through now.", "outgoing": False},
        {"id": "m2", "sender": "You", "text": "Agreed. I still want to go back when it is less crowded.", "outgoing": True},
        {
            "id": "m3",
            "sender": "Jamie",
            "text": "My favorite painting.",
            "outgoing": False,
            "image_token": "mock-photo",
        },
        {"id": "m4", "sender": "Alex", "text": "That one looked incredible in person. The colors are warmer than I expected.", "outgoing": False},
        {"id": "m5", "sender": "You", "text": "Send me the restaurant address too. I will meet you there after work.", "outgoing": True},
        {"id": "m6", "sender": "Jamie", "text": "Done. Reservation is under my name for 7:30.", "outgoing": False},
    ],
    "house": [
        {"id": "h1", "sender": "Morgan", "text": "The plumber moved the appointment to 4:30, so I left the side gate unlocked.", "outgoing": False},
        {"id": "h2", "sender": "You", "text": "Thanks. I will check the invoice when I get home.", "outgoing": True},
        {"id": "h3", "sender": "Morgan", "text": "Also, the package is inside on the bench by the door.", "outgoing": False},
    ],
    "workbench": [
        {"id": "w1", "sender": "Sam", "text": "I pushed a cleaner build for the round screen. The chat list feels much less cramped now.", "outgoing": False},
        {"id": "w2", "sender": "You", "text": "Nice. The photo preview and action menu are the two screenshots I want to show off.", "outgoing": True},
        {"id": "w3", "sender": "Mara", "text": "The Diorite version looks surprisingly readable in black and white.", "outgoing": False},
    ],
}


WATCH_EMOJI_ALIASES = {
    "\u2709\ufe0f": ":envelope:",
    "\u2709": ":envelope:",
    "\u260e\ufe0f": ":phone:",
    "\u260e": ":phone:",
    "\u23f0": ":alarm_clock:",
    "\u231b": ":hourglass:",
    "\u23f3": ":hourglass:",
    "\u2714\ufe0f": ":check_mark:",
    "\u2714": ":check_mark:",
    "\u274c": ":x:",
    "\u2b55": ":o:",
    "\u26a0\ufe0f": ":warning:",
    "\u26a0": ":warning:",
    "\u2600\ufe0f": ":sun:",
    "\u2600": ":sun:",
    "\u2601\ufe0f": ":cloud:",
    "\u2601": ":cloud:",
    "\u2614": ":umbrella:",
    "\u26c5": ":partly_sunny:",
    "\u26a1": ":zap:",
    "\u2744\ufe0f": ":snowflake:",
    "\u2744": ":snowflake:",
    "\u2615": ":coffee:",
    "\u26fd": ":fuelpump:",
    "\u2708\ufe0f": ":airplane:",
    "\u2708": ":airplane:",
    "\u26f5": ":sailboat:",
    "\u26bd": ":soccer:",
    "\u26be": ":baseball:",
    "\u26f3": ":golf:",
    "\u2665\ufe0f": ":heart:",
    "\u2665": ":heart:",
    "\u2660\ufe0f": ":spades:",
    "\u2660": ":spades:",
    "\u2663\ufe0f": ":clubs:",
    "\u2663": ":clubs:",
    "\u2666\ufe0f": ":diamonds:",
    "\u2666": ":diamonds:",
    "\u267b\ufe0f": ":recycle:",
    "\u267b": ":recycle:",
    "\u00a9\ufe0f": ":copyright:",
    "\u00ae\ufe0f": ":registered:",
    "\u2122\ufe0f": ":tm:",
    "\u270a": ":fist:",
    "\U0001f434": ":horse:",
    "\U0001f40e": ":racehorse:",
    "\U0001f984": ":unicorn:",
    "\U0001f436": ":dog:",
    "\U0001f415": ":dog:",
    "\U0001f431": ":cat:",
    "\U0001f408": ":cat:",
    "\U0001f42d": ":mouse:",
    "\U0001f439": ":hamster:",
    "\U0001f430": ":rabbit:",
    "\U0001f98a": ":fox:",
    "\U0001f43b": ":bear:",
    "\U0001f43c": ":panda:",
    "\U0001f428": ":koala:",
    "\U0001f42f": ":tiger:",
    "\U0001f981": ":lion:",
    "\U0001f42e": ":cow:",
    "\U0001f437": ":pig:",
    "\U0001f438": ":frog:",
    "\U0001f435": ":monkey:",
    "\U0001f648": ":see_no_evil:",
    "\U0001f649": ":hear_no_evil:",
    "\U0001f64a": ":speak_no_evil:",
    "\U0001f414": ":chicken:",
    "\U0001f427": ":penguin:",
    "\U0001f426": ":bird:",
    "\U0001f986": ":duck:",
    "\U0001f989": ":owl:",
    "\U0001f43a": ":wolf:",
    "\U0001f41d": ":bee:",
    "\U0001f41b": ":bug:",
    "\U0001f98b": ":butterfly:",
    "\U0001f40c": ":snail:",
    "\U0001f41e": ":lady_beetle:",
    "\U0001f41c": ":ant:",
    "\U0001f422": ":turtle:",
    "\U0001f40d": ":snake:",
    "\U0001f419": ":octopus:",
    "\U0001f980": ":crab:",
    "\U0001f420": ":fish:",
    "\U0001f42c": ":dolphin:",
    "\U0001f433": ":whale:",
    "\U0001f988": ":shark:",
    "\U0001f418": ":elephant:",
    "\U0001f992": ":giraffe:",
    "\U0001f308": ":rainbow:",
    "\U0001f680": ":rocket:",
    "\U0001f346": ":eggplant:",
    "\U0001f351": ":peach:",
    "\U0001f34e": ":apple:",
    "\U0001f34c": ":banana:",
    "\U0001f349": ":watermelon:",
    "\U0001f347": ":grapes:",
    "\U0001f353": ":strawberry:",
    "\U0001f352": ":cherries:",
    "\U0001f34d": ":pineapple:",
    "\U0001f951": ":avocado:",
    "\U0001f33d": ":corn:",
    "\U0001f955": ":carrot:",
    "\U0001f966": ":broccoli:",
    "\U0001f345": ":tomato:",
    "\U0001f344": ":mushroom:",
    "\U0001f336": ":hot_pepper:",
    "\U0001f35e": ":bread:",
    "\U0001f950": ":croissant:",
    "\U0001f9c0": ":cheese:",
    "\U0001f95a": ":egg:",
    "\U0001f373": ":cooking:",
    "\U0001f95e": ":pancakes:",
    "\U0001f953": ":bacon:",
    "\U0001f354": ":burger:",
    "\U0001f35f": ":fries:",
    "\U0001f355": ":pizza:",
    "\U0001f32d": ":hot_dog:",
    "\U0001f32e": ":taco:",
    "\U0001f32f": ":burrito:",
    "\U0001f37f": ":popcorn:",
    "\U0001f363": ":sushi:",
    "\U0001f35c": ":ramen:",
    "\U0001f35d": ":spaghetti:",
    "\U0001f366": ":ice_cream:",
    "\U0001f369": ":donut:",
    "\U0001f36a": ":cookie:",
    "\U0001f382": ":cake:",
    "\U0001f370": ":cake:",
    "\U0001f36b": ":chocolate:",
    "\U0001f36c": ":candy:",
    "\U0001f36d": ":lollipop:",
    "\U0001f377": ":wine:",
    "\U0001f378": ":cocktail:",
    "\U0001f379": ":tropical_drink:",
    "\U0001f942": ":champagne:",
    "\U0001f44c": ":ok_hand:",
    "\U0001f44a": ":fist:",
    "\U0001f44b": ":wave:",
    "\U0001f44f": ":clap:",
    "\U0001f64c": ":raised_hands:",
    "\U0001f48b": ":kiss_mark:",
    "\U0001f525": ":fire:",
    "\U0001f914": ":thinking:",
    "\U0001f92f": ":exploding_head:",
    "\U0001f937": ":shrug:",
    "\U0001f926": ":facepalm:",
    "\U0001f91e": ":crossed_fingers:",
    "\U0001faf6": ":heart_hands:",
}

WATCH_SUPPORTED_EMOJI = set(
    "⌚☺☠⚧✅✋✌✨❎❗❣❤⭐🌙🌟🌷🌸🌺🍀🍺🍻🎉🎶🏳🐥👀👍👎"
    "💀💓💔💕💖💗💘💙💚💛💜💝💞💟💡💣💥💩💯🖤"
    "😀😁😂😃😄😅😆😇😈😉😊😋😌😍😎😏😐😑😒😓😔😕😖😗😘😙😚"
    "😛😜😝😞😟😠😡😢😣😤😥😦😧😨😩😪😫😬😭😮😯😰😱😲😳😴😵😶😷"
    "🙃🙄🙏🤗🤘🤝🤣🤤🤩🤪🤬🤮🥰🥺"
)

WATCH_EMOJI_PATTERN = re.compile("|".join(re.escape(key) for key in WATCH_EMOJI_ALIASES))
WATCH_SURROGATE_EMOJI_PATTERN = re.compile("[\U00010000-\U0010ffff]")
WATCH_FORMAT_PATTERN = re.compile("[\u200b-\u200f\ufe00-\ufe0f\ufeff]")
WATCH_LINK_PATTERN = re.compile(
    r"\b((?:https?://|www\.)[^\s<>\"']+|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:/[^\s<>\"']*)?)",
    re.IGNORECASE,
)
WATCH_LINK_TLDS = {
    "app",
    "biz",
    "ca",
    "co",
    "com",
    "dev",
    "edu",
    "gov",
    "info",
    "io",
    "me",
    "net",
    "org",
    "tv",
    "uk",
    "us",
}
WATCH_TECHNICAL_TOKEN_PATTERN = re.compile(
    r"\b[A-Za-z_$][A-Za-z0-9_$]*(?:[.$][A-Za-z_$][A-Za-z0-9_$]*){2,}(?::\d+)?"
)


def likely_bare_link_host(host: str) -> bool:
    parts = (host or "").lower().split(".")
    return len(parts) > 1 and parts[-1] in WATCH_LINK_TLDS


def shorten_watch_links(text: str) -> str:
    def replace(match: re.Match[str]) -> str:
        url = match.group(0)
        if match.start() > 0 and text[match.start() - 1] == "@":
            return url
        stripped = url.rstrip(".,!?;:)]}")
        trailer = url[len(stripped) :]
        host_match = re.match(r"^(?:https?://)?(?:www\.)?([^/?#]+)", stripped, re.IGNORECASE)
        if (
            host_match
            and "://" not in stripped
            and not stripped.lower().startswith("www.")
            and not likely_bare_link_host(host_match.group(1))
        ):
            return url
        return ("[Link] " + host_match.group(1) if host_match else "[Link]") + trailer

    return WATCH_LINK_PATTERN.sub(replace, text)


def summarize_watch_stack_trace(text: str) -> str:
    text = text.replace("\r\n", "\n")
    text = re.sub(r"\n\s+at\s+[^\n]+", " [trace]", text)
    text = re.sub(r"\n\s*\.\.\.\s+\d+\s+more", " [trace]", text)
    return re.sub(r"(?:\s+\[trace\]){2,}", " [trace]", text)


def shorten_technical_token(match: re.Match[str]) -> str:
    token = match.group(0)
    stripped = token.rstrip(".,!?;:)]}")
    trailer = token[len(stripped) :]
    parts = stripped.split(".")
    short = ".".join(parts[-2:]) if len(parts) > 2 else stripped
    if len(short) > 24 and len(parts) > 1:
        short = parts[-1]
    if len(short) > 24:
        short = short[:21] + "..."
    return short + trailer


def shorten_watch_technical_tokens(text: str) -> str:
    text = re.sub(r"\br8-map-id-[A-Za-z0-9-]+(?::\d+)?", "r8-map", text)
    return WATCH_TECHNICAL_TOKEN_PATTERN.sub(shorten_technical_token, text)


def watch_text(value: Any) -> str:
    text = "" if value is None else str(value)
    text = WATCH_EMOJI_PATTERN.sub(lambda match: WATCH_EMOJI_ALIASES[match.group(0)], text)
    text = WATCH_FORMAT_PATTERN.sub("", text)
    text = WATCH_SURROGATE_EMOJI_PATTERN.sub(
        lambda match: match.group(0) if match.group(0) in WATCH_SUPPORTED_EMOJI else ":emoji:",
        text,
    )
    return shorten_watch_technical_tokens(shorten_watch_links(summarize_watch_stack_trace(text)))


class Backend:
    async def chats(self, limit: int) -> list[dict[str, Any]]:
        raise NotImplementedError

    async def messages(self, chat_id: str, limit: int, before_id: str | None = None) -> list[dict[str, Any]]:
        raise NotImplementedError

    async def image_png(self, chat_id: str, message_id: str, width: int, height: int, colors: int = 64) -> bytes:
        raise NotImplementedError

    async def send_message(self, chat_id: str, text: str, reply_to: str | None) -> None:
        raise NotImplementedError

    async def delete_message(self, chat_id: str, message_id: str) -> None:
        raise NotImplementedError


class MockBackend(Backend):
    async def chats(self, limit: int) -> list[dict[str, Any]]:
        return [
            {**chat, "preview": watch_text(chat.get("preview", ""))}
            for chat in MOCK_CHATS[:limit]
        ]

    async def messages(self, chat_id: str, limit: int, before_id: str | None = None) -> list[dict[str, Any]]:
        messages = MOCK_MESSAGES.get(chat_id, [])
        if before_id:
            for index, message in enumerate(messages):
                if str(message.get("id", "")) == before_id:
                    return [
                        {**message, "text": watch_text(message.get("text", ""))}
                        for message in messages[max(0, index - limit):index]
                    ]
            return []
        return [
            {**message, "text": watch_text(message.get("text", ""))}
            for message in messages[-limit:]
        ]

    async def image_png(self, chat_id: str, message_id: str, width: int, height: int, colors: int = 64) -> bytes:
        if MOCK_PHOTO_PATH.exists():
            return make_thumbnail_png(MOCK_PHOTO_PATH.read_bytes(), width, height, colors)
        return make_mock_photo_png(width, height, colors)

    async def send_message(self, chat_id: str, text: str, reply_to: str | None) -> None:
        messages = MOCK_MESSAGES.setdefault(chat_id, [])
        messages.append(
            {
                "id": f"local-{len(messages) + 1}",
                "sender": "You",
                "text": text,
                "outgoing": True,
                "reply_to": reply_to,
            }
        )

    async def delete_message(self, chat_id: str, message_id: str) -> None:
        messages = MOCK_MESSAGES.setdefault(chat_id, [])
        MOCK_MESSAGES[chat_id] = [message for message in messages if message["id"] != message_id]


class TelethonBackend(Backend):
    def __init__(
        self,
        session: str,
        api_id: int,
        api_hash: str,
        phone: str,
        allow_read_content: bool,
        allow_send: bool,
        allow_delete: bool,
    ) -> None:
        try:
            from telethon import TelegramClient
            from telethon.tl.types import Chat, User
        except ImportError as exc:
            raise RuntimeError("Telethon is not installed. Run: python3 -m pip install telethon") from exc

        self._telegram_client_cls = TelegramClient
        self._chat_type = Chat
        self._user_type = User
        self._client = TelegramClient(session, api_id, api_hash)
        self._phone = phone
        self._allow_read_content = allow_read_content
        self._allow_send = allow_send
        self._allow_delete = allow_delete
        self._entity_cache: dict[str, Any] = {}
        self._sender_cache: dict[int, str] = {}
        self._image_cache: dict[tuple[str, str, int, int], bytes] = {}

    async def start(self) -> None:
        print("Starting Telegram session. First run may ask for the login code.", flush=True)
        await self._client.start(phone=self._phone)

    async def _ensure_connected(self) -> None:
        if not self._client.is_connected():
            await self._client.connect()
        if not await self._client.is_user_authorized():
            await self._client.start(phone=self._phone)

    async def chats(self, limit: int) -> list[dict[str, Any]]:
        await self._ensure_connected()
        dialogs = await self._client.get_dialogs(limit=limit * 3)
        result: list[dict[str, Any]] = []
        for dialog in dialogs:
            entity = dialog.entity
            if getattr(dialog, "archived", False):
                continue
            kind = entity.__class__.__name__
            # Include private chats and regular groups. Skip channels for phase 1.
            if not getattr(entity, "megagroup", False) and kind not in ("Chat", "User"):
                continue
            chat_id = str(entity.id)
            self._entity_cache[chat_id] = entity
            preview = ""
            if self._allow_read_content and dialog.message:
                preview = getattr(dialog.message, "message", None) or ""
                if not preview and (getattr(dialog.message, "photo", None) or getattr(dialog.message, "media", None)):
                    preview = "[Photo]"
            result.append(
                {
                    "id": chat_id,
                    "title": self._display_name(dialog, entity),
                    "preview": watch_text(preview)[:90],
                    "unread": bool(getattr(dialog, "unread_count", 0)),
                }
            )
            if len(result) >= limit:
                break
        return result

    async def messages(self, chat_id: str, limit: int, before_id: str | None = None) -> list[dict[str, Any]]:
        if not self._allow_read_content:
            return []
        await self._ensure_connected()
        entity = await self._entity(chat_id)
        kwargs = {"limit": limit}
        if before_id:
            kwargs["offset_id"] = int(before_id)
        messages = await self._client.get_messages(entity, **kwargs)
        # Marking read is useful, but it should never block rendering messages.
        asyncio.create_task(self._client.send_read_acknowledge(entity))
        rows = []
        for message in reversed(messages):
            has_photo = getattr(message, "photo", None) is not None
            text = message.message or ""
            if has_photo:
                normalized_text = text.strip().lower()
                if normalized_text in ("[photo]", "[photo preview placeholder]"):
                    text = ""
                else:
                    text = text.replace("[Photo Preview Placeholder]", "")
                    text = text.replace("[photo preview placeholder]", "").strip()
            if not text and not has_photo:
                continue
            rows.append(
                {
                    "id": str(message.id),
                    "sender": await self._sender_name(message),
                    "text": watch_text(text)[:500],
                    "outgoing": bool(message.out),
                    "image_token": str(message.id) if has_photo else None,
                }
            )
        return rows

    async def image_png(self, chat_id: str, message_id: str, width: int, height: int, colors: int = 64) -> bytes:
        cache_key = (chat_id, message_id, width, height, colors)
        if cache_key in self._image_cache:
            return self._image_cache[cache_key]
        await self._ensure_connected()
        entity = await self._entity(chat_id)
        message = await self._client.get_messages(entity, ids=int(message_id))
        if not message or not getattr(message, "photo", None):
            raise RuntimeError("message has no photo")
        raw = await self._client.download_media(message, bytes, thumb=-1)
        if not raw:
            raw = await self._client.download_media(message, bytes)
        if not raw:
            raise RuntimeError("failed to download photo")
        png = make_thumbnail_png(raw, width, height, colors)
        self._image_cache[cache_key] = png
        return png

    async def send_message(self, chat_id: str, text: str, reply_to: str | None) -> None:
        if not self._allow_send:
            raise RuntimeError("sending is disabled")
        entity = await self._entity(chat_id)
        kwargs = {}
        if reply_to:
            kwargs["reply_to"] = int(reply_to)
        await self._client.send_message(entity, text, **kwargs)

    async def delete_message(self, chat_id: str, message_id: str) -> None:
        if not self._allow_delete:
            raise RuntimeError("deleting is disabled")
        entity = await self._entity(chat_id)
        await self._client.delete_messages(entity, [int(message_id)], revoke=True)

    async def _entity(self, chat_id: str) -> Any:
        if chat_id not in self._entity_cache:
            self._entity_cache[chat_id] = await self._client.get_entity(int(chat_id))
        return self._entity_cache[chat_id]

    async def _sender_name(self, message: Any) -> str:
        if bool(getattr(message, "out", False)):
            return "You"
        sender_id = getattr(message, "sender_id", None)
        if sender_id in self._sender_cache:
            return self._sender_cache[sender_id]
        sender = await message.get_sender()
        if not sender:
            return ""
        first = getattr(sender, "first_name", "") or ""
        last = getattr(sender, "last_name", "") or ""
        title = getattr(sender, "title", "") or ""
        name = " ".join(part for part in [first, last] if part).strip() or title or "Unknown"
        if sender_id:
            self._sender_cache[sender_id] = name
        return name

    def _display_name(self, dialog: Any, entity: Any) -> str:
        name = getattr(dialog, "name", "") or ""
        if name:
            return name
        title = getattr(entity, "title", "") or ""
        if title:
            return title
        if entity.__class__.__name__ == "User":
            first = getattr(entity, "first_name", "") or ""
            last = getattr(entity, "last_name", "") or ""
            username = getattr(entity, "username", "") or ""
            parts = " ".join(part for part in [first, last] if part).strip()
            return parts or username or "Unknown"
        return getattr(entity, "username", "") or "Untitled"


class BridgeHandler(BaseHTTPRequestHandler):
    backend: Backend
    loop: asyncio.AbstractEventLoop
    token: str | None = None
    config_path = Path(__file__).resolve().parents[1] / "src" / "pkjs" / "config.html"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_OPTIONS(self) -> None:
        self._send_json({})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        limit = min(int(query.get("limit", ["20"])[0]), 32)
        image_size = min(max(int(query.get("size", ["72"])[0]), 1), 192)
        image_width = min(max(int(query.get("width", [str(image_size)])[0]), 1), 192)
        image_height = min(max(int(query.get("height", [str(image_size)])[0]), 1), 192)
        image_colors = min(max(int(query.get("colors", ["64"])[0]), 2), 64)
        before_id = query.get("before_id", [None])[0]

        try:
            if parsed.path == "/v1/health":
                self._send_json({"ok": True})
                return
            if parsed.path in ("/", "/config.html"):
                self._send_file(self.config_path, "text/html; charset=utf-8")
                return
            if not self._authorized(parsed):
                self._send_json({"error": "unauthorized"}, status=401)
                return
            if parsed.path == "/v1/chats":
                chats = self._run(self.backend.chats(limit))
                self._send_json({"chats": chats})
                return
            if parsed.path.startswith("/v1/chats/") and "/messages/" in parsed.path and parsed.path.endswith("/image"):
                parts = parsed.path.split("/")
                chat_id = unquote(parts[3])
                message_id = unquote(parts[5])
                png = self._run(self.backend.image_png(chat_id, message_id, image_width, image_height, image_colors))
                self._send_bytes(png, content_type="image/png")
                return
            if parsed.path.startswith("/v1/chats/") and parsed.path.endswith("/messages"):
                chat_id = unquote(parsed.path.split("/")[3])
                messages = self._run(self.backend.messages(chat_id, limit, before_id))
                self._send_json({"messages": messages})
                return
            self._send_json({"error": "not found"}, status=404)
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=500)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        body = self._read_body()

        try:
            if not self._authorized(parsed):
                self._send_json({"error": "unauthorized"}, status=401)
                return
            if parsed.path.startswith("/v1/chats/") and parsed.path.endswith("/send"):
                chat_id = unquote(parsed.path.split("/")[3])
                text = str(body.get("text", "")).strip()
                if not text:
                    self._send_json({"error": "empty message"}, status=400)
                    return
                reply_to = body.get("reply_to")
                self._run(self.backend.send_message(chat_id, text, str(reply_to) if reply_to else None))
                self._send_json({"ok": True})
                return
            if parsed.path.startswith("/v1/chats/") and parsed.path.endswith("/delete"):
                chat_id = unquote(parsed.path.split("/")[3])
                message_id = str(body.get("message_id", ""))
                self._run(self.backend.delete_message(chat_id, message_id))
                self._send_json({"ok": True})
                return
            self._send_json({"error": "not found"}, status=404)
        except Exception as exc:
            self._send_json({"error": str(exc)}, status=500)

    def _run(self, coro: Any) -> Any:
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout=30)

    def _authorized(self, parsed: Any) -> bool:
        if not self.token:
            return True
        auth = self.headers.get("Authorization", "")
        if auth == f"Bearer {self.token}":
            return True
        query = parse_qs(parsed.query)
        return query.get("token", [""])[0] == self.token

    def _read_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _send_json(self, data: dict[str, Any], status: int = 200) -> None:
        payload = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send_bytes(self, data: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, path: Path, content_type: str) -> None:
        if not path.exists():
            self._send_json({"error": "config page not found"}, status=404)
            return
        self._send_bytes(path.read_bytes(), content_type)


async def make_backend(mode: str) -> Backend:
    if mode == "mock":
        return MockBackend()

    api_id = os.environ.get("TELEGRAM_API_ID")
    api_hash = os.environ.get("TELEGRAM_API_HASH")
    phone = os.environ.get("TELEGRAM_PHONE")
    if not api_id or not api_hash or not phone:
        raise RuntimeError("TELEGRAM_API_ID, TELEGRAM_API_HASH, and TELEGRAM_PHONE are required")

    legacy_allow_write = os.environ.get("TELEGRAM_ALLOW_WRITE", "0") == "1"
    backend = TelethonBackend(
        session=os.environ.get("TELEGRAM_SESSION", "pebblegram"),
        api_id=int(api_id),
        api_hash=api_hash,
        phone=phone,
        allow_read_content=os.environ.get("TELEGRAM_ALLOW_READ_CONTENT", "1") == "1",
        allow_send=os.environ.get("TELEGRAM_ALLOW_SEND", "1" if legacy_allow_write else "0") == "1",
        allow_delete=os.environ.get("TELEGRAM_ALLOW_DELETE", "1" if legacy_allow_write else "0") == "1",
    )
    await backend.start()
    return backend


def _require_pillow() -> None:
    if Image is None:
        raise RuntimeError("Pillow is not installed. Run: python3 -m pip install pillow")


def _pebble_palette_image() -> Any:
    palette = []
    for r in (0, 85, 170, 255):
        for g in (0, 85, 170, 255):
            for b in (0, 85, 170, 255):
                palette.extend((r, g, b))
    palette.extend([0, 0, 0] * (256 - 64))
    palette_image = Image.new("P", (1, 1))
    palette_image.putpalette(palette)
    return palette_image


def quantize_for_pebble(image: Any) -> Any:
    # Pebble color screens expose a fixed 64-color palette.
    return image.convert("RGB").quantize(palette=_pebble_palette_image(), dither=Image.Dither.FLOYDSTEINBERG)


def quantize_for_pebble_bw(image: Any) -> Any:
    palette_image = Image.new("P", (1, 1))
    palette_image.putpalette([
        0, 0, 0,
        85, 85, 85,
        170, 170, 170,
        255, 255, 255,
    ] + [0, 0, 0] * 252)
    return image.convert("L").convert("RGB").quantize(palette=palette_image, dither=Image.Dither.FLOYDSTEINBERG)


def quantize_for_platform(image: Any, colors: int) -> Any:
    if colors <= 4:
        return quantize_for_pebble_bw(image)
    return quantize_for_pebble(image)


def make_thumbnail_png(raw: bytes, width: int, height: int, colors: int = 64) -> bytes:
    _require_pillow()
    with Image.open(io.BytesIO(raw)) as source:
        image = source.convert("RGBA")
        if ImageOps is not None:
            canvas = ImageOps.fit(image, (width, height), Image.Resampling.LANCZOS, centering=(0.5, 0.5))
        else:
            image.thumbnail((width, height), Image.Resampling.LANCZOS)
            canvas = Image.new("RGBA", (width, height), (255, 255, 255, 255))
            offset = ((width - image.width) // 2, (height - image.height) // 2)
            canvas.alpha_composite(image, offset)
        canvas = quantize_for_platform(canvas, colors)
        output = io.BytesIO()
        save_options = {"optimize": True}
        if colors <= 4:
            save_options["bits"] = 2
        canvas.save(output, format="PNG", **save_options)
        return output.getvalue()


def make_mock_photo_png(width: int, height: int, colors: int = 64) -> bytes:
    _require_pillow()
    canvas = Image.new("RGBA", (width, height), (95, 170, 220, 255))
    draw = ImageDraw.Draw(canvas)

    for y in range(height):
        ratio = y / max(1, height - 1)
        r = int(74 + 110 * ratio)
        g = int(155 - 65 * ratio)
        b = int(220 - 120 * ratio)
        draw.line((0, y, width, y), fill=(r, g, b, 255))

    short_side = min(width, height)
    sun_r = max(8, short_side // 9)
    sun_x = int(width * 0.72)
    sun_y = int(height * 0.28)
    draw.ellipse((sun_x - sun_r, sun_y - sun_r, sun_x + sun_r, sun_y + sun_r), fill=(255, 220, 120, 255))
    draw.polygon(
        [(0, int(height * 0.78)), (int(width * 0.34), int(height * 0.43)), (int(width * 0.72), int(height * 0.78))],
        fill=(35, 100, 115, 255),
    )
    draw.polygon(
        [(int(width * 0.18), int(height * 0.82)), (int(width * 0.62), int(height * 0.50)), (width, int(height * 0.82))],
        fill=(28, 80, 105, 255),
    )
    draw.rectangle((0, int(height * 0.78), width, height), fill=(34, 120, 116, 255))
    for x in range(0, width, max(5, width // 12)):
        draw.line((x, int(height * 0.84), x + int(width * 0.18), height), fill=(78, 160, 145, 255), width=1)

    canvas = quantize_for_platform(canvas, colors)
    output = io.BytesIO()
    save_options = {"optimize": True}
    if colors <= 4:
        save_options["bits"] = 2
    canvas.save(output, format="PNG", **save_options)
    return output.getvalue()


async def amain() -> None:
    parser = argparse.ArgumentParser(description="Pebblegram Telegram bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--mode", choices=["mock", "telegram"], default="mock")
    args = parser.parse_args()

    backend = await make_backend(args.mode)
    loop = asyncio.get_running_loop()
    BridgeHandler.backend = backend
    BridgeHandler.loop = loop
    BridgeHandler.token = os.environ.get("PEBBLEGRAM_TOKEN") or None

    server = ThreadingHTTPServer((args.host, args.port), BridgeHandler)
    print(f"Pebblegram bridge listening on http://{args.host}:{args.port} ({args.mode})", flush=True)
    await loop.run_in_executor(None, server.serve_forever)


if __name__ == "__main__":
    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        pass
