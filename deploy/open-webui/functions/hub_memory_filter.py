"""
title: Hub Memory
author: bsokol
author_url: https://github.com/bsokol/firefly-ai-hub
version: 0.1.0
description: Injects user memories from the ai-hub memory store into every chat and saves new memories when the user message starts with an explicit trigger phrase.
required_open_webui_version: 0.3.0
requirements: requests
"""

# SOURCE OF TRUTH for the regex: hub/src/memory/explicit-trigger.ts in the firefly-ai-hub repo.
# Any regex change must be ported there in lockstep.
#
# Installation:
#   1. Admin Panel → Functions → "+" → paste this whole file → Save
#   2. Enable the filter, open its valves:
#        - api_token = the value of MEMORY_API_TOKEN in /etc/ai-hub/hub.env
#        - user_id_overrides = one line `<your-email>=<your-discord-snowflake>` so your
#          Open WebUI account bridges to Discord (every other user stays isolated).
#   3. On the chat screen, enable this filter for each model you use.

import logging
import os
import re
from typing import Optional

import requests
from pydantic import BaseModel, Field

log = logging.getLogger("hub_memory_filter")

TRIGGER = re.compile(
    r"^\s*(?:please\s+|hey[,\s]+)?"
    r"(?:remember(?:\s+(?:that|this))?|note\s+that|don'?t\s+forget(?:\s+that)?|save\s+this|make\s+a\s+note(?:\s+that)?)"
    r"\b[:,]?\s*(.+)",
    re.IGNORECASE,
)

CONNECTOR_FALLBACK = re.compile(r"(?:that|this)", re.IGNORECASE)


def extract_explicit_memory(message: str) -> Optional[str]:
    if not message:
        return None
    m = TRIGGER.match(message)
    if not m:
        return None
    content = m.group(1).strip().rstrip(".!?").strip()
    if len(content) < 3:
        return None
    if CONNECTOR_FALLBACK.fullmatch(content):
        return None
    return content


class Filter:
    class Valves(BaseModel):
        hub_url: str = Field(
            default="http://ai-hub:8787",
            description="Base URL of the ai-hub memory HTTP API",
        )
        api_token: str = Field(
            default="",
            description=(
                "Shared secret for the memory HTTP API. If empty, falls back to the "
                "MEMORY_API_TOKEN environment variable inside the open-webui container "
                "(the usual deployment). Set this valve only to override for debugging."
            ),
        )
        user_id_overrides: str = Field(
            default="",
            description=(
                "Newline-separated email=user_id map. Open WebUI users whose email matches "
                "a key will write/read memory under the mapped user_id instead of the "
                "default openwebui:<oui-id>. Use this to bridge your Open WebUI account to "
                "a Discord snowflake so memories cross over."
            ),
        )
        k: int = Field(
            default=5,
            description="How many memories to inject into the system prompt per turn",
        )

    def __init__(self):
        self.valves = self.Valves()

    def _overrides(self) -> dict:
        out = {}
        for line in (self.valves.user_id_overrides or "").splitlines():
            line = line.strip()
            if not line or "=" not in line:
                continue
            email, user_id = line.split("=", 1)
            email = email.strip().lower()
            user_id = user_id.strip()
            if email and user_id:
                out[email] = user_id
        return out

    def _resolve_user_id(self, __user__: Optional[dict]) -> Optional[str]:
        if not __user__:
            return None
        email = (__user__.get("email") or "").lower()
        oui_id = __user__.get("id")
        if not email and not oui_id:
            return None
        if email:
            overrides = self._overrides()
            if email in overrides:
                return overrides[email]
        if oui_id:
            return f"openwebui:{oui_id}"
        return None

    def _headers(self) -> dict:
        token = self.valves.api_token or os.environ.get("MEMORY_API_TOKEN", "")
        return {"x-auth": token}

    def _save(self, user_id: str, content: str) -> None:
        try:
            requests.post(
                f"{self.valves.hub_url}/memory/remember",
                headers={**self._headers(), "content-type": "application/json"},
                json={"user": user_id, "category": "fact", "content": content},
                timeout=3,
            )
        except Exception as err:
            log.warning("hub_memory: save failed: %s", err)

    def _recall(self, user_id: str, query: str) -> list:
        try:
            resp = requests.get(
                f"{self.valves.hub_url}/memory/recall",
                headers=self._headers(),
                params={"user": user_id, "q": query or "", "limit": self.valves.k},
                timeout=3,
            )
            if resp.status_code != 200:
                log.warning("hub_memory: recall status %s", resp.status_code)
                return []
            return resp.json().get("memories", [])
        except Exception as err:
            log.warning("hub_memory: recall failed: %s", err)
            return []

    def _format_context(self, memories: list) -> str:
        if not memories:
            return ""
        lines = [
            f"- [{m.get('category', 'fact')}] {m.get('content', '')} ({m.get('created_at', '')})"
            for m in memories
        ]
        return (
            "<MEMORY_CONTEXT>\n"
            "What you remember about this user:\n"
            + "\n".join(lines)
            + "\n</MEMORY_CONTEXT>"
        )

    def _last_user_text(self, messages: list) -> str:
        for m in reversed(messages):
            if m.get("role") != "user":
                continue
            content = m.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                return " ".join(
                    part.get("text", "")
                    for part in content
                    if isinstance(part, dict) and part.get("type") == "text"
                )
        return ""

    def inlet(self, body: dict, __user__: Optional[dict] = None) -> dict:
        user_id = self._resolve_user_id(__user__)
        if not user_id:
            log.info("hub_memory: anonymous request — skipping memory inject/save")
            return body

        messages = body.get("messages") or []
        last_text = self._last_user_text(messages)

        fact = extract_explicit_memory(last_text)
        if fact:
            self._save(user_id, fact)

        memories = self._recall(user_id, last_text)
        context = self._format_context(memories)
        if context:
            body["messages"] = [{"role": "system", "content": context}] + messages

        return body

    def outlet(self, body: dict, __user__: Optional[dict] = None) -> dict:
        return body
