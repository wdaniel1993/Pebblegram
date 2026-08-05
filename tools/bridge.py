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
    # Only aliases for glyphs the PebbleOS emoji font cannot render (checked
    # against EMOJI_*.pbf from the coredevices/PebbleOS repo). Everything
    # else renders as a real glyph — see WATCH_SUPPORTED_EMOJI below.
    "\u00a9\ufe0f": ":copyright:",
    "\u00a9": ":copyright:",
    "\u00ae\ufe0f": ":registered:",
    "\u00ae": ":registered:",
    "\u2122\ufe0f": ":tm:",
    "\u2122": ":tm:",
}

WATCH_SUPPORTED_EMOJI = set(
    "\U0001f170""\U0001f171""\U0001f17e""\U0001f17f""\U0001f18e""\U0001f191"
    "\U0001f192""\U0001f193""\U0001f194""\U0001f195""\U0001f196""\U0001f197"
    "\U0001f198""\U0001f199""\U0001f19a""\U0001f1e6""\U0001f1e7""\U0001f1e8"
    "\U0001f1e9""\U0001f1ea""\U0001f1eb""\U0001f1ec""\U0001f1ed""\U0001f1ee"
    "\U0001f1ef""\U0001f1f0""\U0001f1f1""\U0001f1f2""\U0001f1f3""\U0001f1f4"
    "\U0001f1f5""\U0001f1f6""\U0001f1f7""\U0001f1f8""\U0001f1f9""\U0001f1fa"
    "\U0001f1fb""\U0001f1fc""\U0001f1fd""\U0001f1fe""\U0001f1ff""\U0001f201"
    "\U0001f202""\U0001f21a""\U0001f22f""\U0001f232""\U0001f233""\U0001f234"
    "\U0001f235""\U0001f236""\U0001f237""\U0001f238""\U0001f239""\U0001f23a"
    "\U0001f250""\U0001f251""\U0001f300""\U0001f301""\U0001f302""\U0001f303"
    "\U0001f304""\U0001f305""\U0001f306""\U0001f307""\U0001f308""\U0001f309"
    "\U0001f30a""\U0001f30b""\U0001f30c""\U0001f30d""\U0001f30e""\U0001f30f"
    "\U0001f310""\U0001f311""\U0001f312""\U0001f313""\U0001f314""\U0001f315"
    "\U0001f316""\U0001f317""\U0001f318""\U0001f319""\U0001f31a""\U0001f31b"
    "\U0001f31c""\U0001f31d""\U0001f31e""\U0001f31f""\U0001f320""\U0001f321"
    "\U0001f324""\U0001f325""\U0001f326""\U0001f327""\U0001f328""\U0001f329"
    "\U0001f32a""\U0001f32b""\U0001f32c""\U0001f32d""\U0001f32e""\U0001f32f"
    "\U0001f330""\U0001f331""\U0001f332""\U0001f333""\U0001f334""\U0001f335"
    "\U0001f336""\U0001f337""\U0001f338""\U0001f339""\U0001f33a""\U0001f33b"
    "\U0001f33c""\U0001f33d""\U0001f33e""\U0001f33f""\U0001f340""\U0001f341"
    "\U0001f342""\U0001f343""\U0001f344""\U0001f345""\U0001f346""\U0001f347"
    "\U0001f348""\U0001f349""\U0001f34a""\U0001f34b""\U0001f34c""\U0001f34d"
    "\U0001f34e""\U0001f34f""\U0001f350""\U0001f351""\U0001f352""\U0001f353"
    "\U0001f354""\U0001f355""\U0001f356""\U0001f357""\U0001f358""\U0001f359"
    "\U0001f35a""\U0001f35b""\U0001f35c""\U0001f35d""\U0001f35e""\U0001f35f"
    "\U0001f360""\U0001f361""\U0001f362""\U0001f363""\U0001f364""\U0001f365"
    "\U0001f366""\U0001f367""\U0001f368""\U0001f369""\U0001f36a""\U0001f36b"
    "\U0001f36c""\U0001f36d""\U0001f36e""\U0001f36f""\U0001f370""\U0001f371"
    "\U0001f372""\U0001f373""\U0001f374""\U0001f375""\U0001f376""\U0001f377"
    "\U0001f378""\U0001f379""\U0001f37a""\U0001f37b""\U0001f37c""\U0001f37d"
    "\U0001f37e""\U0001f37f""\U0001f380""\U0001f381""\U0001f382""\U0001f383"
    "\U0001f384""\U0001f385""\U0001f386""\U0001f387""\U0001f388""\U0001f389"
    "\U0001f38a""\U0001f38b""\U0001f38c""\U0001f38d""\U0001f38e""\U0001f38f"
    "\U0001f390""\U0001f391""\U0001f392""\U0001f393""\U0001f396""\U0001f397"
    "\U0001f399""\U0001f39a""\U0001f39b""\U0001f39e""\U0001f39f""\U0001f3a0"
    "\U0001f3a1""\U0001f3a2""\U0001f3a3""\U0001f3a4""\U0001f3a5""\U0001f3a6"
    "\U0001f3a7""\U0001f3a8""\U0001f3a9""\U0001f3aa""\U0001f3ab""\U0001f3ac"
    "\U0001f3ad""\U0001f3ae""\U0001f3af""\U0001f3b0""\U0001f3b1""\U0001f3b2"
    "\U0001f3b3""\U0001f3b4""\U0001f3b5""\U0001f3b6""\U0001f3b7""\U0001f3b8"
    "\U0001f3b9""\U0001f3ba""\U0001f3bb""\U0001f3bc""\U0001f3bd""\U0001f3be"
    "\U0001f3bf""\U0001f3c0""\U0001f3c1""\U0001f3c2""\U0001f3c3""\U0001f3c4"
    "\U0001f3c5""\U0001f3c6""\U0001f3c7""\U0001f3c8""\U0001f3c9""\U0001f3ca"
    "\U0001f3cb""\U0001f3cc""\U0001f3cd""\U0001f3ce""\U0001f3cf""\U0001f3d0"
    "\U0001f3d1""\U0001f3d2""\U0001f3d3""\U0001f3d4""\U0001f3d5""\U0001f3d6"
    "\U0001f3d7""\U0001f3d8""\U0001f3d9""\U0001f3da""\U0001f3db""\U0001f3dc"
    "\U0001f3dd""\U0001f3de""\U0001f3df""\U0001f3e0""\U0001f3e1""\U0001f3e2"
    "\U0001f3e3""\U0001f3e4""\U0001f3e5""\U0001f3e6""\U0001f3e7""\U0001f3e8"
    "\U0001f3e9""\U0001f3ea""\U0001f3eb""\U0001f3ec""\U0001f3ed""\U0001f3ee"
    "\U0001f3ef""\U0001f3f0""\U0001f3f3""\U0001f3f4""\U0001f3f5""\U0001f3f7"
    "\U0001f3f8""\U0001f3f9""\U0001f3fa""\U0001f3fb""\U0001f3fc""\U0001f3fd"
    "\U0001f3fe""\U0001f3ff""\U0001f400""\U0001f401""\U0001f402""\U0001f403"
    "\U0001f404""\U0001f405""\U0001f406""\U0001f407""\U0001f408""\U0001f409"
    "\U0001f40a""\U0001f40b""\U0001f40c""\U0001f40d""\U0001f40e""\U0001f40f"
    "\U0001f410""\U0001f411""\U0001f412""\U0001f413""\U0001f414""\U0001f415"
    "\U0001f416""\U0001f417""\U0001f418""\U0001f419""\U0001f41a""\U0001f41b"
    "\U0001f41c""\U0001f41d""\U0001f41e""\U0001f41f""\U0001f420""\U0001f421"
    "\U0001f422""\U0001f423""\U0001f424""\U0001f425""\U0001f426""\U0001f427"
    "\U0001f428""\U0001f429""\U0001f42a""\U0001f42b""\U0001f42c""\U0001f42d"
    "\U0001f42e""\U0001f42f""\U0001f430""\U0001f431""\U0001f432""\U0001f433"
    "\U0001f434""\U0001f435""\U0001f436""\U0001f437""\U0001f438""\U0001f439"
    "\U0001f43a""\U0001f43b""\U0001f43c""\U0001f43d""\U0001f43e""\U0001f43f"
    "\U0001f440""\U0001f441""\U0001f442""\U0001f443""\U0001f444""\U0001f445"
    "\U0001f446""\U0001f447""\U0001f448""\U0001f449""\U0001f44a""\U0001f44b"
    "\U0001f44c""\U0001f44d""\U0001f44e""\U0001f44f""\U0001f450""\U0001f451"
    "\U0001f452""\U0001f453""\U0001f454""\U0001f455""\U0001f456""\U0001f457"
    "\U0001f458""\U0001f459""\U0001f45a""\U0001f45b""\U0001f45c""\U0001f45d"
    "\U0001f45e""\U0001f45f""\U0001f460""\U0001f461""\U0001f462""\U0001f463"
    "\U0001f464""\U0001f465""\U0001f466""\U0001f467""\U0001f468""\U0001f469"
    "\U0001f46a""\U0001f46b""\U0001f46c""\U0001f46d""\U0001f46e""\U0001f46f"
    "\U0001f470""\U0001f471""\U0001f472""\U0001f473""\U0001f474""\U0001f475"
    "\U0001f476""\U0001f477""\U0001f478""\U0001f479""\U0001f47a""\U0001f47b"
    "\U0001f47c""\U0001f47d""\U0001f47e""\U0001f47f""\U0001f480""\U0001f481"
    "\U0001f482""\U0001f483""\U0001f484""\U0001f485""\U0001f486""\U0001f487"
    "\U0001f488""\U0001f489""\U0001f48a""\U0001f48b""\U0001f48c""\U0001f48d"
    "\U0001f48e""\U0001f48f""\U0001f490""\U0001f491""\U0001f492""\U0001f493"
    "\U0001f494""\U0001f495""\U0001f496""\U0001f497""\U0001f498""\U0001f499"
    "\U0001f49a""\U0001f49b""\U0001f49c""\U0001f49d""\U0001f49e""\U0001f49f"
    "\U0001f4a0""\U0001f4a1""\U0001f4a2""\U0001f4a3""\U0001f4a4""\U0001f4a5"
    "\U0001f4a6""\U0001f4a7""\U0001f4a8""\U0001f4a9""\U0001f4aa""\U0001f4ab"
    "\U0001f4ac""\U0001f4ad""\U0001f4ae""\U0001f4af""\U0001f4b0""\U0001f4b1"
    "\U0001f4b2""\U0001f4b3""\U0001f4b4""\U0001f4b5""\U0001f4b6""\U0001f4b7"
    "\U0001f4b8""\U0001f4b9""\U0001f4ba""\U0001f4bb""\U0001f4bc""\U0001f4bd"
    "\U0001f4be""\U0001f4bf""\U0001f4c0""\U0001f4c1""\U0001f4c2""\U0001f4c3"
    "\U0001f4c4""\U0001f4c5""\U0001f4c6""\U0001f4c7""\U0001f4c8""\U0001f4c9"
    "\U0001f4ca""\U0001f4cb""\U0001f4cc""\U0001f4cd""\U0001f4ce""\U0001f4cf"
    "\U0001f4d0""\U0001f4d1""\U0001f4d2""\U0001f4d3""\U0001f4d4""\U0001f4d5"
    "\U0001f4d6""\U0001f4d7""\U0001f4d8""\U0001f4d9""\U0001f4da""\U0001f4db"
    "\U0001f4dc""\U0001f4dd""\U0001f4de""\U0001f4df""\U0001f4e0""\U0001f4e1"
    "\U0001f4e2""\U0001f4e3""\U0001f4e4""\U0001f4e5""\U0001f4e6""\U0001f4e7"
    "\U0001f4e8""\U0001f4e9""\U0001f4ea""\U0001f4eb""\U0001f4ec""\U0001f4ed"
    "\U0001f4ee""\U0001f4ef""\U0001f4f0""\U0001f4f1""\U0001f4f2""\U0001f4f3"
    "\U0001f4f4""\U0001f4f5""\U0001f4f6""\U0001f4f7""\U0001f4f8""\U0001f4f9"
    "\U0001f4fa""\U0001f4fb""\U0001f4fc""\U0001f4fd""\U0001f4ff""\U0001f500"
    "\U0001f501""\U0001f502""\U0001f503""\U0001f504""\U0001f505""\U0001f506"
    "\U0001f507""\U0001f508""\U0001f509""\U0001f50a""\U0001f50b""\U0001f50c"
    "\U0001f50d""\U0001f50e""\U0001f50f""\U0001f510""\U0001f511""\U0001f512"
    "\U0001f513""\U0001f514""\U0001f515""\U0001f516""\U0001f517""\U0001f518"
    "\U0001f519""\U0001f51a""\U0001f51b""\U0001f51c""\U0001f51d""\U0001f51e"
    "\U0001f51f""\U0001f520""\U0001f521""\U0001f522""\U0001f523""\U0001f524"
    "\U0001f525""\U0001f526""\U0001f527""\U0001f528""\U0001f529""\U0001f52a"
    "\U0001f52b""\U0001f52c""\U0001f52d""\U0001f52e""\U0001f52f""\U0001f530"
    "\U0001f531""\U0001f532""\U0001f533""\U0001f534""\U0001f535""\U0001f536"
    "\U0001f537""\U0001f538""\U0001f539""\U0001f53a""\U0001f53b""\U0001f53c"
    "\U0001f53d""\U0001f549""\U0001f54a""\U0001f54b""\U0001f54c""\U0001f54d"
    "\U0001f54e""\U0001f550""\U0001f551""\U0001f552""\U0001f553""\U0001f554"
    "\U0001f555""\U0001f556""\U0001f557""\U0001f558""\U0001f559""\U0001f55a"
    "\U0001f55b""\U0001f55c""\U0001f55d""\U0001f55e""\U0001f55f""\U0001f560"
    "\U0001f561""\U0001f562""\U0001f563""\U0001f564""\U0001f565""\U0001f566"
    "\U0001f567""\U0001f56f""\U0001f570""\U0001f573""\U0001f574""\U0001f575"
    "\U0001f576""\U0001f577""\U0001f578""\U0001f579""\U0001f57a""\U0001f587"
    "\U0001f58a""\U0001f58b""\U0001f58c""\U0001f58d""\U0001f590""\U0001f595"
    "\U0001f596""\U0001f5a4""\U0001f5a5""\U0001f5a8""\U0001f5b1""\U0001f5b2"
    "\U0001f5bc""\U0001f5c2""\U0001f5c3""\U0001f5c4""\U0001f5d1""\U0001f5d2"
    "\U0001f5d3""\U0001f5dc""\U0001f5dd""\U0001f5de""\U0001f5e1""\U0001f5e3"
    "\U0001f5e8""\U0001f5ef""\U0001f5f3""\U0001f5fa""\U0001f5fb""\U0001f5fc"
    "\U0001f5fd""\U0001f5fe""\U0001f5ff""\U0001f600""\U0001f601""\U0001f602"
    "\U0001f603""\U0001f604""\U0001f605""\U0001f606""\U0001f607""\U0001f608"
    "\U0001f609""\U0001f60a""\U0001f60b""\U0001f60c""\U0001f60d""\U0001f60e"
    "\U0001f60f""\U0001f610""\U0001f611""\U0001f612""\U0001f613""\U0001f614"
    "\U0001f615""\U0001f616""\U0001f617""\U0001f618""\U0001f619""\U0001f61a"
    "\U0001f61b""\U0001f61c""\U0001f61d""\U0001f61e""\U0001f61f""\U0001f620"
    "\U0001f621""\U0001f622""\U0001f623""\U0001f624""\U0001f625""\U0001f626"
    "\U0001f627""\U0001f628""\U0001f629""\U0001f62a""\U0001f62b""\U0001f62c"
    "\U0001f62d""\U0001f62e""\U0001f62f""\U0001f630""\U0001f631""\U0001f632"
    "\U0001f633""\U0001f634""\U0001f635""\U0001f636""\U0001f637""\U0001f638"
    "\U0001f639""\U0001f63a""\U0001f63b""\U0001f63c""\U0001f63d""\U0001f63e"
    "\U0001f63f""\U0001f640""\U0001f641""\U0001f642""\U0001f643""\U0001f644"
    "\U0001f645""\U0001f646""\U0001f647""\U0001f648""\U0001f649""\U0001f64a"
    "\U0001f64b""\U0001f64c""\U0001f64d""\U0001f64e""\U0001f64f""\U0001f680"
    "\U0001f681""\U0001f682""\U0001f683""\U0001f684""\U0001f685""\U0001f686"
    "\U0001f687""\U0001f688""\U0001f689""\U0001f68a""\U0001f68b""\U0001f68c"
    "\U0001f68d""\U0001f68e""\U0001f68f""\U0001f690""\U0001f691""\U0001f692"
    "\U0001f693""\U0001f694""\U0001f695""\U0001f696""\U0001f697""\U0001f698"
    "\U0001f699""\U0001f69a""\U0001f69b""\U0001f69c""\U0001f69d""\U0001f69e"
    "\U0001f69f""\U0001f6a0""\U0001f6a1""\U0001f6a2""\U0001f6a3""\U0001f6a4"
    "\U0001f6a5""\U0001f6a6""\U0001f6a7""\U0001f6a8""\U0001f6a9""\U0001f6aa"
    "\U0001f6ab""\U0001f6ac""\U0001f6ad""\U0001f6ae""\U0001f6af""\U0001f6b0"
    "\U0001f6b1""\U0001f6b2""\U0001f6b3""\U0001f6b4""\U0001f6b5""\U0001f6b6"
    "\U0001f6b7""\U0001f6b8""\U0001f6b9""\U0001f6ba""\U0001f6bb""\U0001f6bc"
    "\U0001f6bd""\U0001f6be""\U0001f6bf""\U0001f6c0""\U0001f6c1""\U0001f6c2"
    "\U0001f6c3""\U0001f6c4""\U0001f6c5""\U0001f6cb""\U0001f6cc""\U0001f6cd"
    "\U0001f6ce""\U0001f6cf""\U0001f6d0""\U0001f6d1""\U0001f6d2""\U0001f6d5"
    "\U0001f6d6""\U0001f6d7""\U0001f6dc""\U0001f6dd""\U0001f6de""\U0001f6df"
    "\U0001f6e0""\U0001f6e1""\U0001f6e2""\U0001f6e3""\U0001f6e4""\U0001f6e5"
    "\U0001f6e9""\U0001f6eb""\U0001f6ec""\U0001f6f0""\U0001f6f3""\U0001f6f4"
    "\U0001f6f5""\U0001f6f6""\U0001f6f7""\U0001f6f8""\U0001f6f9""\U0001f6fa"
    "\U0001f6fb""\U0001f6fc""\U0001f7e0""\U0001f7e1""\U0001f7e2""\U0001f7e3"
    "\U0001f7e4""\U0001f7e5""\U0001f7e6""\U0001f7e7""\U0001f7e8""\U0001f7e9"
    "\U0001f7ea""\U0001f7eb""\U0001f7f0""\U0001f90c""\U0001f90d""\U0001f90e"
    "\U0001f90f""\U0001f910""\U0001f911""\U0001f912""\U0001f913""\U0001f914"
    "\U0001f915""\U0001f916""\U0001f917""\U0001f918""\U0001f919""\U0001f91a"
    "\U0001f91b""\U0001f91c""\U0001f91d""\U0001f91e""\U0001f91f""\U0001f920"
    "\U0001f921""\U0001f922""\U0001f923""\U0001f924""\U0001f925""\U0001f926"
    "\U0001f927""\U0001f928""\U0001f929""\U0001f92a""\U0001f92b""\U0001f92c"
    "\U0001f92d""\U0001f92e""\U0001f92f""\U0001f930""\U0001f931""\U0001f932"
    "\U0001f933""\U0001f934""\U0001f935""\U0001f936""\U0001f937""\U0001f938"
    "\U0001f939""\U0001f93a""\U0001f93c""\U0001f93d""\U0001f93e""\U0001f93f"
    "\U0001f940""\U0001f941""\U0001f942""\U0001f943""\U0001f944""\U0001f945"
    "\U0001f947""\U0001f948""\U0001f949""\U0001f94a""\U0001f94b""\U0001f94c"
    "\U0001f94d""\U0001f94e""\U0001f94f""\U0001f950""\U0001f951""\U0001f952"
    "\U0001f953""\U0001f954""\U0001f955""\U0001f956""\U0001f957""\U0001f958"
    "\U0001f959""\U0001f95a""\U0001f95b""\U0001f95c""\U0001f95d""\U0001f95e"
    "\U0001f95f""\U0001f960""\U0001f961""\U0001f962""\U0001f963""\U0001f964"
    "\U0001f965""\U0001f966""\U0001f967""\U0001f968""\U0001f969""\U0001f96a"
    "\U0001f96b""\U0001f96c""\U0001f96d""\U0001f96e""\U0001f96f""\U0001f970"
    "\U0001f971""\U0001f972""\U0001f973""\U0001f974""\U0001f975""\U0001f976"
    "\U0001f977""\U0001f978""\U0001f979""\U0001f97a""\U0001f97b""\U0001f97c"
    "\U0001f97d""\U0001f97e""\U0001f97f""\U0001f980""\U0001f981""\U0001f982"
    "\U0001f983""\U0001f984""\U0001f985""\U0001f986""\U0001f987""\U0001f988"
    "\U0001f989""\U0001f98a""\U0001f98b""\U0001f98c""\U0001f98d""\U0001f98e"
    "\U0001f98f""\U0001f990""\U0001f991""\U0001f992""\U0001f993""\U0001f994"
    "\U0001f995""\U0001f996""\U0001f997""\U0001f998""\U0001f999""\U0001f99a"
    "\U0001f99b""\U0001f99c""\U0001f99d""\U0001f99e""\U0001f99f""\U0001f9a0"
    "\U0001f9a1""\U0001f9a2""\U0001f9a3""\U0001f9a4""\U0001f9a5""\U0001f9a6"
    "\U0001f9a7""\U0001f9a8""\U0001f9a9""\U0001f9aa""\U0001f9ab""\U0001f9ac"
    "\U0001f9ad""\U0001f9ae""\U0001f9af""\U0001f9b0""\U0001f9b1""\U0001f9b2"
    "\U0001f9b3""\U0001f9b4""\U0001f9b5""\U0001f9b6""\U0001f9b7""\U0001f9b8"
    "\U0001f9b9""\U0001f9ba""\U0001f9bb""\U0001f9bc""\U0001f9bd""\U0001f9be"
    "\U0001f9bf""\U0001f9c0""\U0001f9c1""\U0001f9c2""\U0001f9c3""\U0001f9c4"
    "\U0001f9c5""\U0001f9c6""\U0001f9c7""\U0001f9c8""\U0001f9c9""\U0001f9ca"
    "\U0001f9cb""\U0001f9cc""\U0001f9cd""\U0001f9ce""\U0001f9cf""\U0001f9d0"
    "\U0001f9d1""\U0001f9d2""\U0001f9d3""\U0001f9d4""\U0001f9d5""\U0001f9d6"
    "\U0001f9d7""\U0001f9d8""\U0001f9d9""\U0001f9da""\U0001f9db""\U0001f9dc"
    "\U0001f9dd""\U0001f9de""\U0001f9df""\U0001f9e0""\U0001f9e1""\U0001f9e2"
    "\U0001f9e3""\U0001f9e4""\U0001f9e5""\U0001f9e6""\U0001f9e7""\U0001f9e8"
    "\U0001f9e9""\U0001f9ea""\U0001f9eb""\U0001f9ec""\U0001f9ed""\U0001f9ee"
    "\U0001f9ef""\U0001f9f0""\U0001f9f1""\U0001f9f2""\U0001f9f3""\U0001f9f4"
    "\U0001f9f5""\U0001f9f6""\U0001f9f7""\U0001f9f8""\U0001f9f9""\U0001f9fa"
    "\U0001f9fb""\U0001f9fc""\U0001f9fd""\U0001f9fe""\U0001f9ff""\U0001fa70"
    "\U0001fa71""\U0001fa72""\U0001fa73""\U0001fa74""\U0001fa75""\U0001fa76"
    "\U0001fa77""\U0001fa78""\U0001fa79""\U0001fa7a""\U0001fa7b""\U0001fa7c"
    "\U0001fa80""\U0001fa81""\U0001fa82""\U0001fa83""\U0001fa84""\U0001fa85"
    "\U0001fa86""\U0001fa87""\U0001fa88""\U0001fa90""\U0001fa91""\U0001fa92"
    "\U0001fa93""\U0001fa94""\U0001fa95""\U0001fa96""\U0001fa97""\U0001fa98"
    "\U0001fa99""\U0001fa9a""\U0001fa9b""\U0001fa9c""\U0001fa9d""\U0001fa9e"
    "\U0001fa9f""\U0001faa0""\U0001faa1""\U0001faa2""\U0001faa3""\U0001faa4"
    "\U0001faa5""\U0001faa6""\U0001faa7""\U0001faa8""\U0001faa9""\U0001faaa"
    "\U0001faab""\U0001faac""\U0001faad""\U0001faae""\U0001faaf""\U0001fab0"
    "\U0001fab1""\U0001fab2""\U0001fab3""\U0001fab4""\U0001fab5""\U0001fab6"
    "\U0001fab7""\U0001fab8""\U0001fab9""\U0001faba""\U0001fabb""\U0001fabc"
    "\U0001fabd""\U0001fabf""\U0001fac0""\U0001fac1""\U0001fac2""\U0001fac3"
    "\U0001fac4""\U0001fac5""\U0001face""\U0001facf""\U0001fad0""\U0001fad1"
    "\U0001fad2""\U0001fad3""\U0001fad4""\U0001fad5""\U0001fad6""\U0001fad7"
    "\U0001fad8""\U0001fad9""\U0001fada""\U0001fadb""\U0001fae0""\U0001fae1"
    "\U0001fae2""\U0001fae3""\U0001fae4""\U0001fae5""\U0001fae6""\U0001fae7"
    "\U0001fae8""\U0001faf0""\U0001faf1""\U0001faf2""\U0001faf3""\U0001faf4"
    "\U0001faf5""\U0001faf6""\U0001faf7""\U0001faf8"
)

WATCH_EMOJI_PATTERN = re.compile("|".join(re.escape(key) for key in WATCH_EMOJI_ALIASES))
WATCH_SURROGATE_EMOJI_PATTERN = re.compile("[\U00010000-\U0010ffff]")
WATCH_FORMAT_PATTERN = re.compile("[\u200b-\u200f\ufe00-\ufe0f\ufeff\u20e3]")
WATCH_EMOJI_NAMES = {
    # Emoji newer than the PebbleOS font (Emoji 16/17 additions): readable
    # [name] tags so they don't vanish entirely. Everything else in the font
    # renders as a real glyph. Unknown/unassigned glyphs are dropped.
    "\U0001fa89": "[harp]",
    "\U0001fa8a": "[trombone]",
    "\U0001fa8e": "[treasure chest]",
    "\U0001fa8f": "[shovel]",
    "\U0001fabe": "[leafless tree]",
    "\U0001fac6": "[fingerprint]",
    "\U0001fac8": "[hairy creature]",
    "\U0001facd": "[orca]",
    "\U0001fadc": "[root vegetable]",
    "\U0001fadf": "[splatter]",
    "\U0001fae9": "[face with bags under eyes]",
    "\U0001faea": "[distorted face]",
    "\U0001faef": "[fight cloud]",
}
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
        lambda match: match.group(0)
        if match.group(0) in WATCH_SUPPORTED_EMOJI
        else WATCH_EMOJI_NAMES.get(match.group(0), ""),
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
