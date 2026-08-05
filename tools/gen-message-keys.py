#!/usr/bin/env python3
"""
gen-message-keys.py — generate the message_keys.auto.h header that the
Pebble SDK normally produces automatically as part of `pbl_build`.

Why this exists: the Pebble SDK (legacy v3) is not installed in this
environment, but the watch app still needs MESSAGE_KEY_* constants in
src/c/message_keys.auto.h. This script reads pebble.messageKeys from
package.json and writes a header in the format the SDK uses (a single
enum, with each key assigned its array index). Re-run this whenever you
add or reorder keys; the SDK, when installed, will overwrite it with an
identical file at build time.

Usage:
    python3 tools/gen-message-keys.py
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_JSON = ROOT / "package.json"
HEADER_PATH = ROOT / "src" / "c" / "message_keys.auto.h"


def main() -> int:
    with PACKAGE_JSON.open() as handle:
        package = json.load(handle)
    keys = package["pebble"]["messageKeys"]

    lines = [
        "/* Auto-generated from package.json by tools/gen-message-keys.py.",
        " * The Pebble SDK regenerates an identical file at build time; keep",
        " * the keys in package.json and this file in sync if you build without",
        " * the SDK installed (see tools/gen-message-keys.py).",
        " */",
        "#ifndef MESSAGE_KEYS_AUTO_H",
        "#define MESSAGE_KEYS_AUTO_H",
        "",
        "enum {",
    ]
    for index, key in enumerate(keys):
        suffix = "," if index < len(keys) - 1 else ""
        lines.append(f"  MESSAGE_KEY_{key} = {index}{suffix}")
    lines.extend([
        "};",
        "",
        f"#define MESSAGE_KEYS_COUNT {len(keys)}",
        "",
        "#endif /* MESSAGE_KEYS_AUTO_H */",
        "",
    ])

    HEADER_PATH.parent.mkdir(parents=True, exist_ok=True)
    HEADER_PATH.write_text("\n".join(lines))
    print(f"Wrote {len(keys)} keys to {HEADER_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
