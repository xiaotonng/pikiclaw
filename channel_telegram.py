"""Telegram channel — all Telegram Bot API interaction for codeclaw.

Handles: messaging, formatting, inline keyboards, pagination,
callback queries, photo/document handling, streaming display,
interactive prompt detection, and the polling loop.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from typing import Any, TYPE_CHECKING
from urllib import error, request

if TYPE_CHECKING:
    from codeclaw import CodeClaw, RunResult


# ---------------------------------------------------------------------------
# Telegram formatting helpers
# ---------------------------------------------------------------------------

def escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def md_to_tg_html(text: str) -> str:
    """Convert Markdown from AI output to Telegram HTML.

    Handles: fenced code blocks, inline code, bold, italic, strikethrough,
    links, and headings.
    """
    result: list[str] = []
    lines = text.split("\n")
    i = 0
    in_code_block = False
    code_lang = ""
    code_lines: list[str] = []

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("```"):
            if not in_code_block:
                in_code_block = True
                remainder = stripped[3:].strip()
                code_lang = remainder.split()[0] if remainder else ""
                code_lines = []
            else:
                in_code_block = False
                code_content = escape_html("\n".join(code_lines))
                if code_lang:
                    result.append(f'<pre><code class="language-{escape_html(code_lang)}">{code_content}</code></pre>')
                else:
                    result.append(f"<pre>{code_content}</pre>")
            i += 1
            continue

        if in_code_block:
            code_lines.append(line)
            i += 1
            continue

        heading_match = re.match(r'^(#{1,6})\s+(.+)$', line)
        if heading_match:
            result.append(f"<b>{_md_inline_to_html(heading_match.group(2))}</b>")
            i += 1
            continue

        result.append(_md_inline_to_html(line))
        i += 1

    if in_code_block and code_lines:
        code_content = escape_html("\n".join(code_lines))
        result.append(f"<pre>{code_content}</pre>")

    return "\n".join(result)


def _md_inline_to_html(line: str) -> str:
    parts: list[str] = []
    remaining = line
    while "`" in remaining:
        idx = remaining.index("`")
        end = remaining.find("`", idx + 1)
        if end == -1:
            break
        parts.append(_format_text_segment(remaining[:idx]))
        parts.append(f"<code>{escape_html(remaining[idx + 1:end])}</code>")
        remaining = remaining[end + 1:]
    parts.append(_format_text_segment(remaining))
    return "".join(parts)


def _format_text_segment(text: str) -> str:
    text = escape_html(text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'__(.+?)__', r'<b>\1</b>', text)
    text = re.sub(r'(?<!\w)\*([^*]+?)\*(?!\w)', r'<i>\1</i>', text)
    text = re.sub(r'(?<!\w)_([^_]+?)_(?!\w)', r'<i>\1</i>', text)
    text = re.sub(r'~~(.+?)~~', r'<s>\1</s>', text)
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2">\1</a>', text)
    return text


def trim_text(text: str, limit: int = 3900) -> list[str]:
    text = text.strip()
    if not text:
        return ["(empty response)"]
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    remaining = text
    while len(remaining) > limit:
        cut = remaining.rfind("\n", 0, limit)
        if cut < 0:
            cut = limit
        chunks.append(remaining[:cut].strip())
        remaining = remaining[cut:].lstrip()
    if remaining:
        chunks.append(remaining)
    return chunks


def detect_quick_replies(text: str) -> list[str]:
    """Detect actionable options in AI response for inline keyboard quick-replies.

    Looks for: numbered options (1. / 2.), yes/no questions, lettered options (A) / B)),
    or explicit choice patterns.
    """
    lines = text.strip().split("\n")
    last_lines = "\n".join(lines[-15:])  # check only the tail

    # Yes/No question
    if re.search(r'\?\s*$', last_lines):
        # Check for explicit yes/no style
        if re.search(r'(?i)(should I|do you want|shall I|would you like|proceed|continue\?)', last_lines):
            return ["Yes", "No"]

    # Numbered options: 1. ... / 2. ...
    numbered = re.findall(r'^\s*(\d+)[.)]\s+(.{3,60})$', last_lines, re.MULTILINE)
    if 2 <= len(numbered) <= 6:
        return [f"{n}. {desc.strip()[:30]}" for n, desc in numbered]

    # Lettered options: A) ... / B) ...
    lettered = re.findall(r'^\s*([A-F])[.)]\s+(.{3,60})$', last_lines, re.MULTILINE)
    if 2 <= len(lettered) <= 6:
        return [f"{letter}) {desc.strip()[:30]}" for letter, desc in lettered]

    return []


# ---------------------------------------------------------------------------
# Telegram Channel
# ---------------------------------------------------------------------------

class TelegramChannel:
    EDIT_INTERVAL = 1.5  # min seconds between message edits

    def __init__(self, core: CodeClaw) -> None:
        self.core = core
        self.token = core.token
        self.api_base = f"https://api.telegram.org/bot{self.token}"

        # Pagination cache: msg_id -> {pages, meta, chat_id, ...}
        self._page_cache: dict[int, dict[str, Any]] = {}
        self._page_cache_lock = threading.Lock()

    # -------------------------------------------------------------------
    # Telegram Bot API
    # -------------------------------------------------------------------

    def _api_call(self, method: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        url = f"{self.api_base}/{method}"
        body = json.dumps(payload or {}).encode("utf-8")
        req = request.Request(
            url, data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(req, timeout=max(30, self.core.poll_timeout + 10)) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not data.get("ok"):
            raise RuntimeError(f"Telegram API error ({method}): {data}")
        return data

    def _send_message(
        self, chat_id: int, text: str,
        reply_to: int | None = None,
        parse_mode: str | None = None,
        reply_markup: dict[str, Any] | None = None,
    ) -> int | None:
        msg_id = None
        for chunk in trim_text(text):
            payload: dict[str, Any] = {
                "chat_id": chat_id,
                "text": chunk,
                "disable_web_page_preview": True,
            }
            if parse_mode:
                payload["parse_mode"] = parse_mode
            if reply_to is not None:
                payload["reply_to_message_id"] = reply_to
            if reply_markup is not None:
                payload["reply_markup"] = reply_markup
            try:
                result = self._api_call("sendMessage", payload)
            except Exception:
                if parse_mode:
                    payload.pop("parse_mode", None)
                    result = self._api_call("sendMessage", payload)
                else:
                    raise
            if msg_id is None:
                msg_id = result.get("result", {}).get("message_id")
        return msg_id

    def _delete_message(self, chat_id: int, message_id: int) -> bool:
        try:
            self._api_call("deleteMessage", {"chat_id": chat_id, "message_id": message_id})
            return True
        except Exception:
            return False

    def _edit_message(
        self, chat_id: int, message_id: int, text: str,
        parse_mode: str | None = None,
        reply_markup: dict[str, Any] | None = None,
    ) -> None:
        text = text.strip()
        if not text:
            return
        if len(text) > 4000:
            text = text[:4000] + "\n..."
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
            "disable_web_page_preview": True,
        }
        if parse_mode:
            payload["parse_mode"] = parse_mode
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup
        try:
            self._api_call("editMessageText", payload)
        except Exception as exc:
            err_str = str(exc).lower()
            if "message is not modified" in err_str:
                return
            if parse_mode and ("can't parse" in err_str or "bad request" in err_str):
                payload.pop("parse_mode", None)
                try:
                    self._api_call("editMessageText", payload)
                    return
                except Exception:
                    pass
            self.core._log(f"edit error: {exc}", err=True)

    def _answer_callback_query(self, callback_query_id: str, text: str = "") -> None:
        payload: dict[str, Any] = {"callback_query_id": callback_query_id}
        if text:
            payload["text"] = text
        try:
            self._api_call("answerCallbackQuery", payload)
        except Exception:
            pass

    def _send_document(
        self, chat_id: int, content: str, filename: str,
        caption: str = "", reply_to: int | None = None,
    ) -> int | None:
        url = f"{self.api_base}/sendDocument"
        boundary = f"----codeclaw{hashlib.md5(content.encode()).hexdigest()[:16]}"
        body_parts: list[bytes] = []

        body_parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"chat_id\"\r\n\r\n{chat_id}".encode())
        if reply_to:
            body_parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"reply_to_message_id\"\r\n\r\n{reply_to}".encode())
        if caption:
            body_parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"caption\"\r\n\r\n{caption[:1024]}".encode())

        file_data = content.encode("utf-8")
        body_parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"document\"; filename=\"{filename}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n".encode() + file_data
        )
        body_parts.append(f"--{boundary}--\r\n".encode())

        body = b"\r\n".join(body_parts)
        req = request.Request(
            url, data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            return data.get("result", {}).get("message_id")
        except Exception as exc:
            self.core._log(f"sendDocument error: {exc}", err=True)
            return None

    def _get_file_url(self, file_id: str) -> str | None:
        try:
            data = self._api_call("getFile", {"file_id": file_id})
            file_path = data.get("result", {}).get("file_path", "")
            if file_path:
                return f"https://api.telegram.org/file/bot{self.token}/{file_path}"
        except Exception as exc:
            self.core._log(f"getFile error: {exc}", err=True)
        return None

    def _download_file(self, file_url: str) -> bytes | None:
        try:
            req = request.Request(file_url, method="GET")
            with request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except Exception as exc:
            self.core._log(f"download error: {exc}", err=True)
            return None

    # -------------------------------------------------------------------
    # Formatting
    # -------------------------------------------------------------------

    def _fmt_tokens(self, n: int | None) -> str:
        if n is None:
            return "-"
        if n >= 1000:
            return f"{n / 1000:.1f}k"
        return str(n)

    def _session_summary_html(self, chat_id: int) -> str:
        cs = self.core._ensure_chat_state(chat_id)
        active = cs["active"]
        engine = cs.get("engine", self.core.default_engine)
        lines = [
            f"<b>Engine:</b> {escape_html(engine)}",
            f"<b>Active:</b> {escape_html(active)}",
            "",
        ]
        for name in sorted(cs["threads"].keys()):
            tid = str(cs["threads"].get(name, "")).strip()
            marker = " (active)" if name == active else ""
            tid_display = f"<code>{escape_html(tid[:12])}</code>" if tid else "-"
            lines.append(f"  {escape_html(name)}{marker} {tid_display}")
        return "\n".join(lines)

    def _format_meta_html(
        self,
        session_name: str,
        thread_id: str | None,
        engine: str,
        result: RunResult | None = None,
    ) -> str:
        parts: list[str] = [engine]
        if result:
            parts.append(f"{result.elapsed_s:.1f}s")
            in_t = result.input_tokens
            ca_t = result.cached_input_tokens
            ou_t = result.output_tokens
            if in_t is not None or ou_t is not None:
                token_parts = []
                if in_t is not None:
                    token_parts.append(f"in:{self._fmt_tokens(in_t)}")
                if ca_t:
                    token_parts.append(f"cached:{self._fmt_tokens(ca_t)}")
                if ou_t is not None:
                    token_parts.append(f"out:{self._fmt_tokens(ou_t)}")
                parts.append(" ".join(token_parts))
        tid = thread_id or (result.thread_id if result else None)
        if tid:
            parts.append(tid[:12])
        return "<code>" + " | ".join(parts) + "</code>"

    # -------------------------------------------------------------------
    # Pagination & keyboards
    # -------------------------------------------------------------------

    def _paginate_text(self, text: str, limit: int = 3800) -> list[str]:
        if len(text) <= limit:
            return [text]
        pages: list[str] = []
        remaining = text
        while len(remaining) > limit:
            cut = remaining.rfind("\n", 0, limit)
            if cut < 0:
                cut = limit
            pages.append(remaining[:cut].strip())
            remaining = remaining[cut:].lstrip()
        if remaining.strip():
            pages.append(remaining.strip())
        return pages

    def _build_page_keyboard(self, msg_id: int, page: int, total: int, quick_replies: list[str] | None = None) -> dict[str, Any]:
        nav_row: list[dict[str, str]] = []
        if page > 0:
            nav_row.append({"text": "< Prev", "callback_data": f"page:{msg_id}:{page - 1}"})
        nav_row.append({"text": f"{page + 1}/{total}", "callback_data": "noop"})
        if page < total - 1:
            nav_row.append({"text": "Next >", "callback_data": f"page:{msg_id}:{page + 1}"})
        rows: list[list[dict[str, str]]] = [nav_row]
        action_row: list[dict[str, str]] = []
        if total > 1:
            action_row.append({"text": "Full text", "callback_data": f"full:{msg_id}"})
        action_row.append({"text": "New session", "callback_data": f"newsess:{msg_id}"})
        rows.append(action_row)
        if quick_replies:
            rows.extend(self._build_quick_reply_rows(msg_id, quick_replies))
        return {"inline_keyboard": rows}

    def _build_action_keyboard(self, msg_id: int, quick_replies: list[str] | None = None) -> dict[str, Any]:
        row: list[dict[str, str]] = [
            {"text": "New session", "callback_data": f"newsess:{msg_id}"},
        ]
        rows: list[list[dict[str, str]]] = [row]
        if quick_replies:
            rows.extend(self._build_quick_reply_rows(msg_id, quick_replies))
        return {"inline_keyboard": rows}

    def _build_quick_reply_rows(self, msg_id: int, replies: list[str]) -> list[list[dict[str, str]]]:
        """Build rows of quick-reply buttons from detected options."""
        rows: list[list[dict[str, str]]] = []
        row: list[dict[str, str]] = []
        for i, text in enumerate(replies):
            label = text[:32]
            cb_data = f"qr:{msg_id}:{i}"
            if len(cb_data) > 64:
                cb_data = cb_data[:64]
            row.append({"text": label, "callback_data": cb_data})
            if len(row) >= 3:
                rows.append(row)
                row = []
        if row:
            rows.append(row)
        return rows

    def _cache_pages(self, msg_id: int, chat_id: int, pages: list[str], meta: str,
                     session_name: str, engine: str, raw_message: str = "",
                     quick_replies: list[str] | None = None) -> None:
        with self._page_cache_lock:
            self._page_cache[msg_id] = {
                "pages": pages, "meta": meta, "chat_id": chat_id,
                "session_name": session_name, "engine": engine,
                "full_text": "\n".join(pages),
                "raw_message": raw_message,
                "quick_replies": quick_replies or [],
            }
            if len(self._page_cache) > 50:
                oldest = sorted(self._page_cache.keys())[:-50]
                for k in oldest:
                    del self._page_cache[k]

    # -------------------------------------------------------------------
    # Final reply
    # -------------------------------------------------------------------

    def _send_final_reply(
        self, chat_id: int, placeholder_msg_id: int,
        session_name: str, engine: str, result: RunResult,
    ) -> None:
        meta = self._format_meta_html(session_name, result.thread_id, engine, result)
        body = md_to_tg_html(result.message)
        pages = self._paginate_text(body, limit=3800)
        total = len(pages)
        quick_replies = detect_quick_replies(result.message)

        if total == 1:
            html_text = f"{pages[0]}\n\n{meta}"
            keyboard = self._build_action_keyboard(placeholder_msg_id, quick_replies)
            self._edit_message(chat_id, placeholder_msg_id, html_text, parse_mode="HTML", reply_markup=keyboard)
        else:
            page_header = f"<i>Page 1/{total}</i>"
            html_text = f"{pages[0]}\n\n{page_header}\n{meta}"
            keyboard = self._build_page_keyboard(placeholder_msg_id, 0, total, quick_replies)
            self._edit_message(chat_id, placeholder_msg_id, html_text, parse_mode="HTML", reply_markup=keyboard)
            self._cache_pages(placeholder_msg_id, chat_id, pages, meta, session_name, engine,
                              raw_message=result.message, quick_replies=quick_replies)
            self._send_document(
                chat_id, result.message,
                filename=f"response_{placeholder_msg_id}.md",
                caption=f"Full response ({len(result.message)} chars)",
                reply_to=placeholder_msg_id,
            )

    # -------------------------------------------------------------------
    # Help
    # -------------------------------------------------------------------

    def _help_html(self) -> str:
        from codeclaw import __version__
        return (
            f"<b>codeclaw</b> v{__version__}\n"
            "\n"
            "<b>Commands</b>\n"
            "/ask &lt;prompt&gt; — Ask the AI agent\n"
            "/engine [codex|claude] — Show or switch engine\n"
            "/battle &lt;prompt&gt; — Run both engines, compare\n"
            "/new [prompt] — Reset session\n"
            "/stop — Clear session thread\n"
            "/status — Session / engine / thread info\n"
            "/session list|use|new|del — Multi-session\n"
            "/clear [N] — Delete bot's recent messages (default 50)\n"
            "\n"
            "<i>DM: send text directly. Group: @mention or reply.\n"
            "Send photos with a caption to analyze images.</i>"
        )

    # -------------------------------------------------------------------
    # Streaming
    # -------------------------------------------------------------------

    def _stream_run(
        self,
        chat_id: int,
        placeholder_msg_id: int,
        prompt: str,
        thread_id: str | None,
        engine: str,
    ) -> RunResult:
        proc = self.core.spawn(prompt, engine, thread_id)
        start = time.time()
        last_edit = 0.0
        edit_count = 0

        def on_text(text: str) -> None:
            nonlocal last_edit, edit_count
            now = time.time()
            if (now - last_edit) < self.EDIT_INTERVAL:
                return
            display = text.strip()
            if not display:
                return
            elapsed = now - start
            max_body = 3600
            if len(display) > max_body:
                truncated = display[-max_body:]
                body = md_to_tg_html(truncated)
                body = "<i>(...truncated)</i>\n" + body
            else:
                body = md_to_tg_html(display)
            dots = "\u00b7" * ((edit_count % 3) + 1)
            header = f"<code>{escape_html(engine)} | {elapsed:.0f}s {dots}</code>"
            html_text = f"{body}\n\n{header}"
            try:
                self._edit_message(chat_id, placeholder_msg_id, html_text, parse_mode="HTML")
                last_edit = now
                edit_count += 1
            except Exception as exc:
                self.core._log(f"stream edit failed: {exc}", err=True)

        result = self.core.parse_events(proc, engine, thread_id, on_text)
        self.core._log(
            f"done engine={engine} ok={result.ok} "
            f"elapsed={result.elapsed_s:.1f}s edits={edit_count} "
            f"tokens=in:{self._fmt_tokens(result.input_tokens)}"
            f"/cached:{self._fmt_tokens(result.cached_input_tokens)}"
            f"/out:{self._fmt_tokens(result.output_tokens)}"
        )
        return result

    def _run_blocking(self, prompt: str, engine: str) -> RunResult:
        proc = self.core.spawn(prompt, engine, None)
        return self.core.parse_events(proc, engine, None, lambda _: None)

    # -------------------------------------------------------------------
    # Battle mode
    # -------------------------------------------------------------------

    def _handle_battle(self, chat_id: int, message_id: int | None, prompt: str) -> None:
        from codeclaw import VALID_ENGINES
        engines = sorted(VALID_ENGINES)
        self.core._log(f"battle started: {engines[0]} vs {engines[1]}")
        placeholder_id = self._send_message(
            chat_id,
            f"<b>BATTLE</b>  {escape_html(engines[0])} vs {escape_html(engines[1])}\n\n<i>Running both engines...</i>",
            reply_to=message_id,
            parse_mode="HTML",
        )

        results: dict[str, RunResult | None] = {}
        errors: dict[str, str] = {}

        def run_engine(eng: str) -> None:
            try:
                results[eng] = self._run_blocking(prompt, eng)
            except Exception as exc:
                errors[eng] = str(exc)

        threads = []
        for eng in engines:
            t = threading.Thread(target=run_engine, args=(eng,), daemon=True)
            t.start()
            threads.append(t)

        for t in threads:
            t.join(timeout=self.core.run_timeout + 30)

        parts: list[str] = [f"<b>BATTLE</b>  {escape_html(prompt[:80])}\n"]
        for eng in engines:
            r = results.get(eng)
            err = errors.get(eng)
            parts.append(f"<b>\u258e{escape_html(eng.upper())}</b>")
            if err:
                parts.append(f"Error: {escape_html(err)}")
            elif r:
                stats = f"{r.elapsed_s:.1f}s"
                if r.input_tokens is not None and r.output_tokens is not None:
                    stats += f" | {self._fmt_tokens(r.input_tokens + r.output_tokens)} tokens"
                parts.append(f"{md_to_tg_html(r.message)}\n<code>{stats}</code>")
            else:
                parts.append("(no result)")
            parts.append("")

        for eng in engines:
            r = results.get(eng)
            if r:
                self.core._log(f"battle {eng}: {r.elapsed_s:.1f}s ok={r.ok} tokens=out:{self._fmt_tokens(r.output_tokens)}")

        full_text = "\n".join(parts).strip()
        chunks = trim_text(full_text, limit=3800)
        self._edit_message(chat_id, placeholder_id, chunks[0], parse_mode="HTML")
        for chunk in chunks[1:]:
            self._send_message(chat_id, chunk, parse_mode="HTML")

    # -------------------------------------------------------------------
    # Message routing
    # -------------------------------------------------------------------

    def _should_handle(self, msg: dict[str, Any]) -> bool:
        chat = msg.get("chat", {})
        chat_id = chat.get("id")
        if chat_id is None:
            return False
        if self.core.allowed_chat_ids and int(chat_id) not in self.core.allowed_chat_ids:
            return False
        chat_type = chat.get("type", "")
        text = (msg.get("text") or msg.get("caption") or "").strip()
        has_photo = bool(msg.get("photo"))
        has_document = bool(msg.get("document"))
        if chat_type == "private":
            return bool(text) or has_photo or has_document
        if text.startswith("/"):
            return True
        if not self.core.require_mention:
            return bool(text) or has_photo or has_document
        mention = f"@{self.core.bot_username.lower()}" if self.core.bot_username else ""
        if mention and mention in text.lower():
            return True
        reply_to = msg.get("reply_to_message", {})
        if reply_to.get("from", {}).get("id") == self.core.bot_id:
            return True
        return False

    def _clean_prompt(self, text: str) -> str:
        if self.core.bot_username:
            text = text.replace(f"@{self.core.bot_username}", "")
            text = text.replace(f"@{self.core.bot_username.lower()}", "")
            text = text.replace(f"@{self.core.bot_username.upper()}", "")
        return text.strip()

    # -------------------------------------------------------------------
    # Callback query handler
    # -------------------------------------------------------------------

    def _handle_callback_query(self, cq: dict[str, Any]) -> None:
        cq_id = cq.get("id", "")
        data = cq.get("data", "")
        msg = cq.get("message", {})
        chat_id = msg.get("chat", {}).get("id")
        message_id = msg.get("message_id")
        if not chat_id or not message_id:
            self._answer_callback_query(cq_id)
            return

        if data == "noop":
            self._answer_callback_query(cq_id)
            return

        # Pagination
        if data.startswith("page:"):
            parts = data.split(":")
            if len(parts) == 3:
                try:
                    cache_id = int(parts[1])
                    page_num = int(parts[2])
                except ValueError:
                    self._answer_callback_query(cq_id, "Invalid page")
                    return
                with self._page_cache_lock:
                    entry = self._page_cache.get(cache_id)
                if not entry:
                    self._answer_callback_query(cq_id, "Page expired, send message again")
                    return
                pages = entry["pages"]
                meta = entry["meta"]
                total = len(pages)
                page_num = max(0, min(page_num, total - 1))
                page_header = f"<i>Page {page_num + 1}/{total}</i>"
                html_text = f"{pages[page_num]}\n\n{page_header}\n{meta}"
                keyboard = self._build_page_keyboard(cache_id, page_num, total, entry.get("quick_replies"))
                self._edit_message(chat_id, message_id, html_text, parse_mode="HTML", reply_markup=keyboard)
                self._answer_callback_query(cq_id, f"Page {page_num + 1}/{total}")
            return

        # Full text as document
        if data.startswith("full:"):
            try:
                cache_id = int(data.split(":")[1])
            except (ValueError, IndexError):
                self._answer_callback_query(cq_id)
                return
            with self._page_cache_lock:
                entry = self._page_cache.get(cache_id)
            if not entry:
                self._answer_callback_query(cq_id, "Cache expired")
                return
            self._send_document(
                chat_id, entry.get("raw_message") or entry["full_text"],
                filename=f"response_{cache_id}.md",
                caption="Full response",
            )
            self._answer_callback_query(cq_id, "Sent as document")
            return

        # Quick reply: qr:<msg_id>:<index>
        if data.startswith("qr:"):
            parts = data.split(":")
            if len(parts) == 3:
                try:
                    cache_id = int(parts[1])
                    idx = int(parts[2])
                except ValueError:
                    self._answer_callback_query(cq_id)
                    return
                with self._page_cache_lock:
                    entry = self._page_cache.get(cache_id)
                replies = (entry or {}).get("quick_replies", [])
                if idx < len(replies):
                    reply_text = replies[idx]
                else:
                    reply_text = f"Option {idx + 1}"
                self._answer_callback_query(cq_id, f"Sending: {reply_text[:40]}")
                # Send as a new prompt in the current session
                self._run_prompt(chat_id, reply_text, reply_to=message_id)
            return

        # New session
        if data.startswith("newsess:"):
            session_name, _ = self.core._session_for_chat(chat_id)
            self.core._set_session_thread(chat_id, session_name, None)
            engine = self.core._engine_for_chat(chat_id)
            meta = self._format_meta_html(session_name, None, engine)
            self._answer_callback_query(cq_id, "Session reset")
            self._send_message(
                chat_id,
                f"Session reset: <b>{escape_html(session_name)}</b>\n\n{meta}",
                parse_mode="HTML",
            )
            return

        self._answer_callback_query(cq_id)

    # -------------------------------------------------------------------
    # Photo handler
    # -------------------------------------------------------------------

    def _handle_photo_message(self, msg: dict[str, Any]) -> None:
        chat_id = int(msg["chat"]["id"])
        message_id = msg.get("message_id")
        caption = self._clean_prompt((msg.get("caption") or "").strip())

        photos = msg.get("photo", [])
        if not photos:
            return
        best_photo = max(photos, key=lambda p: p.get("file_size", 0))
        file_id = best_photo.get("file_id")
        if not file_id:
            return

        engine = self.core._engine_for_chat(chat_id)
        ph = self._send_message(
            chat_id,
            f"<code>{escape_html(engine)} | downloading image ...</code>",
            reply_to=message_id,
            parse_mode="HTML",
        )

        file_url = self._get_file_url(file_id)
        if not file_url:
            self._edit_message(chat_id, ph, "Failed to download image.")
            return

        file_data = self._download_file(file_url)
        if not file_data:
            self._edit_message(chat_id, ph, "Failed to download image.")
            return

        ext = ".png" if file_url.endswith(".png") else ".jpg"
        tmp_path = self.core.workdir / f"_tg_photo_{message_id}{ext}"
        try:
            tmp_path.write_bytes(file_data)
            prompt = caption or "Please analyze this image."
            prompt = f"{prompt}\n\n[Image saved to: {tmp_path.name}]"

            self._edit_message(
                chat_id, ph,
                f"<code>{escape_html(engine)} | thinking ...</code>",
                parse_mode="HTML",
            )

            session_name, current_thread = self.core._session_for_chat(chat_id)
            result = self._stream_run(chat_id, ph, prompt, current_thread, engine)
            if result.thread_id:
                self.core._set_session_thread(chat_id, session_name, result.thread_id)
            self._send_final_reply(chat_id, ph, session_name, engine, result)
        finally:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass

    # -------------------------------------------------------------------
    # Prompt runner (shared by commands & callbacks)
    # -------------------------------------------------------------------

    def _run_prompt(self, chat_id: int, prompt: str, reply_to: int | None = None) -> None:
        engine = self.core._engine_for_chat(chat_id)
        session_name, current_thread = self.core._session_for_chat(chat_id)
        ph = self._send_message(
            chat_id,
            f"<code>{escape_html(engine)} | thinking ...</code>",
            reply_to=reply_to,
            parse_mode="HTML",
        )
        result = self._stream_run(chat_id, ph, prompt, current_thread, engine)
        if result.thread_id:
            self.core._set_session_thread(chat_id, session_name, result.thread_id)
        self._send_final_reply(chat_id, ph, session_name, engine, result)

    # -------------------------------------------------------------------
    # Command handlers
    # -------------------------------------------------------------------

    def _handle_session_command(self, chat_id: int, arg: str, engine: str) -> str | None:
        from codeclaw import normalize_session_name
        active, tid = self.core._session_for_chat(chat_id)
        default_meta = self._format_meta_html(active, tid, engine)
        parts = arg.split()
        if not parts:
            return f"Usage: /session list | use &lt;name&gt; | new &lt;name&gt; | del &lt;name&gt;\n\n{default_meta}"

        action = parts[0].lower()
        if action == "list":
            return f"{self._session_summary_html(chat_id)}\n\n{default_meta}"

        if action == "use":
            if len(parts) < 2:
                return f"Usage: /session use &lt;name&gt;\n\n{default_meta}"
            name = normalize_session_name(parts[1])
            self.core._set_active_session(chat_id, name)
            _, tid = self.core._session_for_chat(chat_id)
            meta = self._format_meta_html(name, tid, engine)
            return f"Switched to session: <b>{escape_html(name)}</b>\n\n{meta}"

        if action == "new":
            if len(parts) < 2:
                return f"Usage: /session new &lt;name&gt; [prompt]\n\n{default_meta}"
            name = normalize_session_name(parts[1])
            self.core._set_active_session(chat_id, name)
            self.core._set_session_thread(chat_id, name, None)
            if not " ".join(parts[2:]).strip():
                meta = self._format_meta_html(name, None, engine)
                return f"Created session: <b>{escape_html(name)}</b>\n\n{meta}"
            return None

        if action in {"del", "delete", "rm"}:
            if len(parts) < 2:
                return f"Usage: /session del &lt;name&gt;\n\n{default_meta}"
            self.core._delete_session(chat_id, normalize_session_name(parts[1]))
            active, tid = self.core._session_for_chat(chat_id)
            meta = self._format_meta_html(active, tid, engine)
            return f"Deleted session: <b>{escape_html(parts[1])}</b>\n\n{meta}"

        return f"Unknown subcommand.\n\n{default_meta}"

    def _handle_text_message(self, msg: dict[str, Any]) -> None:
        from codeclaw import normalize_session_name, normalize_engine, VALID_ENGINES
        chat_id = int(msg["chat"]["id"])
        message_id = msg.get("message_id")
        text = self._clean_prompt((msg.get("text") or msg.get("caption") or "").strip())
        if not text:
            return
        engine = self.core._engine_for_chat(chat_id)

        if text.startswith("/"):
            head, _, tail = text.partition(" ")
            cmd = head[1:]
            if "@" in cmd:
                cmd = cmd.split("@", 1)[0]
            arg = tail.strip()

            if cmd in {"start", "help"}:
                session_name, tid = self.core._session_for_chat(chat_id)
                meta = self._format_meta_html(session_name, tid, engine)
                self._send_message(
                    chat_id,
                    f"{self._help_html()}\n\n{meta}",
                    reply_to=message_id,
                    parse_mode="HTML",
                )
                return

            if cmd == "engine":
                if not arg:
                    avail = ", ".join(sorted(VALID_ENGINES))
                    self._send_message(
                        chat_id,
                        f"<b>Engine:</b> {escape_html(engine)}\n<b>Available:</b> {escape_html(avail)}\n\n/engine codex  or  /engine claude",
                        reply_to=message_id,
                        parse_mode="HTML",
                    )
                    return
                try:
                    new_engine = normalize_engine(arg)
                except RuntimeError as exc:
                    self._send_message(chat_id, str(exc), reply_to=message_id)
                    return
                self.core._set_engine_for_chat(chat_id, new_engine)
                self.core._log(f"engine switched to {new_engine} chat={chat_id}")
                session_name, tid = self.core._session_for_chat(chat_id)
                meta = self._format_meta_html(session_name, tid, new_engine)
                self._send_message(
                    chat_id,
                    f"Engine switched to <b>{escape_html(new_engine)}</b>\n\n{meta}",
                    reply_to=message_id,
                    parse_mode="HTML",
                )
                return

            if cmd == "battle":
                if not arg:
                    self._send_message(chat_id, "Usage: /battle &lt;prompt&gt;", reply_to=message_id, parse_mode="HTML")
                    return
                self._handle_battle(chat_id, message_id, arg)
                return

            if cmd in {"session", "sessions"}:
                reply = self._handle_session_command(chat_id, arg, engine)
                if reply is not None:
                    self._send_message(chat_id, reply, reply_to=message_id, parse_mode="HTML")
                    return
                parts = arg.split()
                session_name = normalize_session_name(parts[1])
                prompt = " ".join(parts[2:]).strip()
                ph = self._send_message(
                    chat_id,
                    f"<code>{escape_html(engine)} | thinking ...</code>",
                    reply_to=message_id,
                    parse_mode="HTML",
                )
                result = self._stream_run(chat_id, ph, prompt, None, engine)
                self.core._set_session_thread(chat_id, session_name, result.thread_id)
                self._send_final_reply(chat_id, ph, session_name, engine, result)
                return

            if cmd in {"new", "reset"}:
                session_name, _ = self.core._session_for_chat(chat_id)
                self.core._set_session_thread(chat_id, session_name, None)
                if not arg:
                    meta = self._format_meta_html(session_name, None, engine)
                    self._send_message(
                        chat_id,
                        f"Session reset: <b>{escape_html(session_name)}</b>\n\n{meta}",
                        reply_to=message_id,
                        parse_mode="HTML",
                    )
                    return
                ph = self._send_message(
                    chat_id,
                    f"<code>{escape_html(engine)} | thinking ...</code>",
                    reply_to=message_id,
                    parse_mode="HTML",
                )
                result = self._stream_run(chat_id, ph, arg, None, engine)
                self.core._set_session_thread(chat_id, session_name, result.thread_id)
                self._send_final_reply(chat_id, ph, session_name, engine, result)
                return

            if cmd == "stop":
                session_name, _ = self.core._session_for_chat(chat_id)
                self.core._set_session_thread(chat_id, session_name, None)
                meta = self._format_meta_html(session_name, None, engine)
                self._send_message(
                    chat_id,
                    f"Session cleared: <b>{escape_html(session_name)}</b>\n\n{meta}",
                    reply_to=message_id,
                    parse_mode="HTML",
                )
                return

            if cmd == "status":
                session_name, tid = self.core._session_for_chat(chat_id)
                summary = self._session_summary_html(chat_id)
                meta = self._format_meta_html(session_name, tid, engine)
                self._send_message(
                    chat_id,
                    f"{summary}\n\n{meta}",
                    reply_to=message_id,
                    parse_mode="HTML",
                )
                return

            if cmd == "clear":
                count = 50
                if arg:
                    try:
                        count = min(int(arg), 200)
                    except ValueError:
                        pass
                self.core._log(f"clear: deleting up to {count} bot messages in chat={chat_id}")
                deleted = 0
                if message_id:
                    self._delete_message(chat_id, message_id)
                if message_id:
                    for offset in range(1, count + 1):
                        mid = message_id - offset
                        if mid <= 0:
                            break
                        if self._delete_message(chat_id, mid):
                            deleted += 1
                self.core._log(f"clear: deleted {deleted} messages in chat={chat_id}")
                self._send_message(chat_id, f"<i>Cleared {deleted} messages.</i>", parse_mode="HTML")
                return

            if cmd in {"ask", "a"}:
                if not arg:
                    self._send_message(chat_id, "Usage: /ask &lt;question&gt;", reply_to=message_id, parse_mode="HTML")
                    return
                text = arg
            else:
                self._send_message(chat_id, "Unknown command. /help for usage.", reply_to=message_id)
                return

        # Normal message
        self._run_prompt(chat_id, text, reply_to=message_id)

    # -------------------------------------------------------------------
    # Startup notice
    # -------------------------------------------------------------------

    def _send_startup_notice(self) -> None:
        import shutil
        from codeclaw import __version__, VALID_ENGINES
        targets: set[int] = set(self.core.allowed_chat_ids)
        for key in self.core.state.get("chats", {}):
            try:
                targets.add(int(key))
            except ValueError:
                pass
        if not targets:
            self.core._log("startup notice: no known chats yet — send any message to the bot first, or set --allowed-ids")
            return
        engines = [eng for eng in sorted(VALID_ENGINES) if shutil.which(eng)]
        engine_list = ", ".join(engines) if engines else "none found"
        status_line = "restarted (replaced previous instance)" if self.core._replaced_old_process else "online"
        text = (
            f"<b>codeclaw</b> v{__version__} {escape_html(status_line)}\n"
            f"\n"
            f"<b>Engine:</b> {escape_html(self.core.default_engine)}\n"
            f"<b>Available:</b> {escape_html(engine_list)}\n"
            f"<b>Workdir:</b> <code>{escape_html(str(self.core.workdir))}</code>\n"
            f"\n"
            f"<i>/help for commands</i>"
        )
        for cid in sorted(targets):
            try:
                self._send_message(cid, text, parse_mode="HTML")
                self.core._log(f"startup notice sent to chat={cid}")
            except Exception as exc:
                self.core._log(f"startup notice failed for chat={cid}: {exc}", err=True)

    # -------------------------------------------------------------------
    # Polling loop
    # -------------------------------------------------------------------

    def run(self) -> None:
        import subprocess as _subprocess
        self._send_startup_notice()
        self.core._log(f"polling started (mention_required={self.core.require_mention})")

        while self.core.running:
            offset = int(self.core.state.get("last_update_id", 0)) + 1
            try:
                updates = self._api_call(
                    "getUpdates",
                    {"timeout": self.core.poll_timeout, "offset": offset,
                     "allowed_updates": ["message", "callback_query"]},
                ).get("result", [])
            except error.URLError as exc:
                self.core._log(f"network error: {exc}", err=True)
                time.sleep(3)
                continue
            except Exception as exc:
                self.core._log(f"poll error: {exc}", err=True)
                time.sleep(3)
                continue

            for update in updates:
                uid = int(update.get("update_id", 0))
                self.core.state["last_update_id"] = max(
                    int(self.core.state.get("last_update_id", 0)), uid
                )
                self.core._save_state()

                # Callback queries (inline keyboard)
                cq = update.get("callback_query")
                if isinstance(cq, dict):
                    try:
                        self._handle_callback_query(cq)
                    except Exception as exc:
                        self.core._log(f"callback_query error: {exc}", err=True)
                    continue

                msg = update.get("message")
                if not isinstance(msg, dict) or not self._should_handle(msg):
                    continue

                chat_id = msg["chat"]["id"]
                user = msg.get("from", {})
                username = user.get("username", "") or user.get("first_name", "")
                preview = (msg.get("text") or msg.get("caption") or "").strip().replace("\n", " ")[:100]
                self.core._log(f"msg chat={chat_id} user={username} {preview!r}")

                try:
                    if msg.get("photo") and not (msg.get("text") or "").startswith("/"):
                        self._handle_photo_message(msg)
                    else:
                        self._handle_text_message(msg)
                except _subprocess.TimeoutExpired:
                    self.core._log(f"timeout after {self.core.run_timeout}s chat={chat_id}", err=True)
                    eng = self.core._engine_for_chat(int(chat_id))
                    sn, tid = self.core._session_for_chat(int(chat_id))
                    meta = self._format_meta_html(sn, tid, eng)
                    self._send_message(
                        int(chat_id),
                        f"Timeout (&gt;{self.core.run_timeout}s)\n\n{meta}",
                        reply_to=msg.get("message_id"),
                        parse_mode="HTML",
                    )
                except Exception as exc:
                    self.core._log(f"error chat={chat_id}: {exc}", err=True)
                    eng = self.core._engine_for_chat(int(chat_id))
                    sn, tid = self.core._session_for_chat(int(chat_id))
                    meta = self._format_meta_html(sn, tid, eng)
                    self._send_message(
                        int(chat_id),
                        f"Error: {escape_html(str(exc))}\n\n{meta}",
                        reply_to=msg.get("message_id"),
                        parse_mode="HTML",
                    )
