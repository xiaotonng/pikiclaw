#!/usr/bin/env python3
"""codeclaw — one binary, zero config, bridge AI coding agents to Telegram.

Features:
- Dual engine: Claude Code + Codex CLI
- Streaming output via Telegram editMessageText
- Battle mode: /battle sends to both engines, compare side-by-side
- Per-chat multi-session management
- Session continuity via thread resume
- Zero dependencies (Python stdlib only)
"""

from __future__ import annotations

__version__ = "0.1.0"

import argparse
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error, request

import fcntl


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


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


def parse_allowed_chat_ids(raw: str) -> set[int]:
    ids: set[int] = set()
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        try:
            ids.add(int(token))
        except ValueError:
            continue
    return ids


def normalize_reasoning_effort(raw: str) -> str:
    value = raw.strip().lower()
    allowed = {"none", "minimal", "low", "medium", "high", "xhigh"}
    if value not in allowed:
        raise RuntimeError(
            "Invalid CODEX_REASONING_EFFORT. "
            "Use one of: none, minimal, low, medium, high, xhigh"
        )
    return value


def normalize_session_name(raw: str) -> str:
    name = raw.strip().lower()
    if not name:
        return "default"
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", name):
        raise RuntimeError(
            "Invalid session name. Use 1-32 chars: a-z, 0-9, _ or -, start with letter/number."
        )
    return name


VALID_ENGINES = {"codex", "claude"}


def normalize_engine(raw: str) -> str:
    value = raw.strip().lower()
    if value not in VALID_ENGINES:
        raise RuntimeError(f"Invalid engine. Use one of: {', '.join(sorted(VALID_ENGINES))}")
    return value


def escape_html(text: str) -> str:
    """Escape text for Telegram HTML parse_mode."""
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def fmt_tokens(n: int | None) -> str:
    """Format token count: 1234 -> '1.2k', None -> '-'."""
    if n is None:
        return "-"
    if n >= 1000:
        return f"{n / 1000:.1f}k"
    return str(n)


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

@dataclass
class RunResult:
    thread_id: str | None
    message: str
    ok: bool
    elapsed_s: float
    input_tokens: int | None = None
    cached_input_tokens: int | None = None
    output_tokens: int | None = None


# ---------------------------------------------------------------------------
# Main Bridge
# ---------------------------------------------------------------------------

class CodeClaw:
    EDIT_INTERVAL = 1.5  # min seconds between Telegram message edits

    def __init__(self) -> None:
        token = (os.getenv("TELEGRAM_BOT_TOKEN") or os.getenv("CODECLAW_TOKEN") or "").strip()
        if not token:
            raise RuntimeError("Missing token. Use -t TOKEN or set CODECLAW_TOKEN / TELEGRAM_BOT_TOKEN")
        self.token = token
        self.api_base = f"https://api.telegram.org/bot{self.token}"

        default_workdir = str(Path.cwd())
        self.workdir = Path(os.getenv("CODECLAW_WORKDIR", default_workdir)).expanduser().resolve()
        self.state_dir = Path(
            os.getenv("CODECLAW_STATE_DIR", "~/.codeclaw")
        ).expanduser().resolve()
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.state_file = self.state_dir / "state.json"
        self.lock_file = self.state_dir / "bridge.lock"

        self.poll_timeout = env_int("TELEGRAM_POLL_TIMEOUT", 45)
        self.run_timeout = env_int("CODECLAW_TIMEOUT", 300)
        self.require_mention = env_bool("TELEGRAM_REQUIRE_MENTION_IN_GROUP", True)
        self.allowed_chat_ids = parse_allowed_chat_ids(
            os.getenv("TELEGRAM_ALLOWED_CHAT_IDS") or os.getenv("CODECLAW_ALLOWED_IDS") or ""
        )

        # Codex settings
        self.codex_model = os.getenv("CODEX_MODEL", "").strip()
        self.codex_reasoning_effort = normalize_reasoning_effort(
            os.getenv("CODEX_REASONING_EFFORT", "xhigh")
        )
        self.codex_full_access = env_bool("CODEX_FULL_ACCESS", True)
        self.codex_extra_args = shlex.split(os.getenv("CODEX_EXTRA_ARGS", ""))

        # Claude settings
        self.claude_model = os.getenv("CLAUDE_MODEL", "").strip()
        self.claude_permission_mode = os.getenv("CLAUDE_PERMISSION_MODE", "bypassPermissions").strip()
        self.claude_extra_args = shlex.split(os.getenv("CLAUDE_EXTRA_ARGS", ""))

        # Default engine
        self.default_engine = normalize_engine(os.getenv("DEFAULT_ENGINE", "claude"))

        self.bot_username = ""
        self.bot_id = 0
        self.running = True
        self.lock_handle = None

        self.state: dict[str, Any] = {"last_update_id": 0, "chats": {}}
        self._load_state()

    # -----------------------------------------------------------------------
    # Logging
    # -----------------------------------------------------------------------

    def _log(self, msg: str, *, err: bool = False) -> None:
        ts = time.strftime("%H:%M:%S")
        out = sys.stderr if err else sys.stdout
        print(f"[codeclaw {ts}] {msg}", file=out, flush=True)

    # -----------------------------------------------------------------------
    # Telegram API
    # -----------------------------------------------------------------------

    def _api_call(self, method: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        url = f"{self.api_base}/{method}"
        body = json.dumps(payload or {}).encode("utf-8")
        req = request.Request(
            url, data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with request.urlopen(req, timeout=max(30, self.poll_timeout + 10)) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not data.get("ok"):
            raise RuntimeError(f"Telegram API error ({method}): {data}")
        return data

    def _send_message(
        self, chat_id: int, text: str,
        reply_to: int | None = None,
        parse_mode: str | None = None,
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
        try:
            self._api_call("editMessageText", payload)
        except Exception as exc:
            err_str = str(exc).lower()
            if "message is not modified" in err_str:
                return
            # Fallback: retry without parse_mode if HTML/Markdown failed
            if parse_mode and ("can't parse" in err_str or "bad request" in err_str):
                payload.pop("parse_mode", None)
                try:
                    self._api_call("editMessageText", payload)
                    return
                except Exception:
                    pass
            self._log(f"edit error: {exc}", err=True)

    # -----------------------------------------------------------------------
    # State management
    # -----------------------------------------------------------------------

    def _load_state(self) -> None:
        if not self.state_file.exists():
            return
        try:
            parsed = json.loads(self.state_file.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                self.state["last_update_id"] = int(parsed.get("last_update_id", 0))
                chats = parsed.get("chats", {})
                if isinstance(chats, dict):
                    normalized: dict[str, dict[str, Any]] = {}
                    for chat_key, cs in chats.items():
                        if not isinstance(cs, dict):
                            continue
                        active = normalize_session_name(str(cs.get("active", "default")))
                        raw_threads = cs.get("threads", {})
                        threads: dict[str, str] = {}
                        if isinstance(raw_threads, dict):
                            for name, tid in raw_threads.items():
                                n = normalize_session_name(str(name))
                                t = str(tid).strip()
                                if t:
                                    threads[n] = t
                        if active not in threads:
                            threads.setdefault(active, "")
                        engine = str(cs.get("engine", self.default_engine))
                        try:
                            engine = normalize_engine(engine)
                        except RuntimeError:
                            engine = self.default_engine
                        normalized[str(chat_key)] = {
                            "active": active,
                            "threads": threads,
                            "engine": engine,
                        }
                    self.state["chats"] = normalized
        except Exception:
            pass

    def _ensure_chat_state(self, chat_id: int) -> dict[str, Any]:
        key = str(chat_id)
        cs = self.state["chats"].setdefault(
            key,
            {"active": "default", "threads": {"default": ""}, "engine": self.default_engine},
        )
        active = normalize_session_name(str(cs.get("active", "default")))
        cs["active"] = active
        if "engine" not in cs:
            cs["engine"] = self.default_engine
        raw = cs.get("threads")
        if not isinstance(raw, dict):
            raw = {}
        norm: dict[str, str] = {}
        for name, tid in raw.items():
            norm[normalize_session_name(str(name))] = str(tid).strip()
        if active not in norm:
            norm[active] = ""
        cs["threads"] = norm
        return cs

    def _save_state(self) -> None:
        self.state_file.write_text(
            json.dumps(self.state, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _acquire_lock(self) -> None:
        self.lock_handle = self.lock_file.open("w", encoding="utf-8")
        try:
            fcntl.flock(self.lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError(f"Already running (lock: {self.lock_file})") from exc

    def _handle_signal(self, signum: int, _frame: Any) -> None:
        self.running = False
        self._log(f"signal {signum}, shutting down...")

    # -----------------------------------------------------------------------
    # Session helpers
    # -----------------------------------------------------------------------

    def _session_for_chat(self, chat_id: int) -> tuple[str, str | None]:
        cs = self._ensure_chat_state(chat_id)
        name = cs["active"]
        tid = str(cs["threads"].get(name, "")).strip() or None
        return name, tid

    def _engine_for_chat(self, chat_id: int) -> str:
        return self._ensure_chat_state(chat_id).get("engine", self.default_engine)

    def _set_engine_for_chat(self, chat_id: int, engine: str) -> None:
        self._ensure_chat_state(chat_id)["engine"] = normalize_engine(engine)
        self._save_state()

    def _set_active_session(self, chat_id: int, session_name: str) -> None:
        cs = self._ensure_chat_state(chat_id)
        name = normalize_session_name(session_name)
        cs["active"] = name
        cs["threads"].setdefault(name, "")
        self._save_state()

    def _set_session_thread(self, chat_id: int, session_name: str, thread_id: str | None) -> None:
        cs = self._ensure_chat_state(chat_id)
        cs["threads"][normalize_session_name(session_name)] = (thread_id or "").strip()
        self._save_state()

    def _delete_session(self, chat_id: int, session_name: str) -> None:
        cs = self._ensure_chat_state(chat_id)
        name = normalize_session_name(session_name)
        cs["threads"].pop(name, None)
        if not cs["threads"]:
            cs["threads"]["default"] = ""
        if cs["active"] == name:
            cs["active"] = "default"
            cs["threads"].setdefault("default", "")
        self._save_state()

    # -----------------------------------------------------------------------
    # LLM command builders
    # -----------------------------------------------------------------------

    def _build_codex_cmd(self, thread_id: str | None) -> list[str]:
        common: list[str] = ["--json"]
        if self.codex_model:
            common += ["-m", self.codex_model]
        common += ["-c", f'model_reasoning_effort="{self.codex_reasoning_effort}"']
        if self.codex_full_access:
            common += ["--dangerously-bypass-approvals-and-sandbox"]
        common += self.codex_extra_args
        if thread_id:
            return ["codex", "exec", "resume"] + common + [thread_id, "-"]
        return ["codex", "exec"] + common + ["-"]

    def _build_claude_cmd(self, thread_id: str | None) -> list[str]:
        cmd = ["claude", "-p", "--verbose", "--output-format", "stream-json", "--include-partial-messages"]
        if self.claude_model:
            cmd += ["--model", self.claude_model]
        if self.claude_permission_mode:
            cmd += ["--permission-mode", self.claude_permission_mode]
        if thread_id:
            cmd += ["--resume", thread_id]
        cmd += self.claude_extra_args
        return cmd

    # -----------------------------------------------------------------------
    # LLM execution — streaming
    # -----------------------------------------------------------------------

    def _parse_events(
        self,
        proc: subprocess.Popen,
        engine: str,
        thread_id: str | None,
        on_text: Any,  # callable(collected_text: str) -> None
    ) -> RunResult:
        """Read JSONL from proc.stdout, call on_text for streaming, return RunResult."""
        start = time.time()
        collected_text = ""
        discovered_thread = thread_id
        usage_input: int | None = None
        usage_cached: int | None = None
        usage_output: int | None = None
        messages_buffer: list[str] = []

        try:
            deadline = time.time() + self.run_timeout
            for raw_line in iter(proc.stdout.readline, ""):
                if time.time() > deadline:
                    proc.kill()
                    break
                line = raw_line.strip()
                if not line or not line.startswith("{"):
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                ev_type = event.get("type", "")

                # --- Codex events ---
                if ev_type == "thread.started":
                    discovered_thread = event.get("thread_id") or discovered_thread
                if ev_type == "item.completed":
                    item = event.get("item", {})
                    if item.get("type") == "agent_message":
                        text = item.get("text", "").strip()
                        if text:
                            messages_buffer.append(text)
                            collected_text = "\n\n".join(messages_buffer)
                            on_text(collected_text)
                if ev_type == "turn.completed":
                    usage = event.get("usage", {})
                    if isinstance(usage, dict):
                        in_t = usage.get("input_tokens")
                        ca_t = usage.get("cached_input_tokens")
                        ou_t = usage.get("output_tokens")
                        usage_input = int(in_t) if isinstance(in_t, int) else usage_input
                        usage_cached = int(ca_t) if isinstance(ca_t, int) else usage_cached
                        usage_output = int(ou_t) if isinstance(ou_t, int) else usage_output

                # --- Claude Code events ---
                if ev_type == "system":
                    sid = event.get("session_id", "")
                    if sid:
                        discovered_thread = sid

                if ev_type == "stream_event":
                    inner = event.get("event", {})
                    inner_type = inner.get("type", "")
                    if inner_type == "content_block_delta":
                        delta = inner.get("delta", {})
                        if delta.get("type") == "text_delta":
                            collected_text += delta.get("text", "")
                            on_text(collected_text)
                    elif inner_type == "message_delta":
                        su = inner.get("usage", {})
                        if isinstance(su, dict):
                            in_t = su.get("input_tokens")
                            ca_t = su.get("cache_read_input_tokens")
                            ou_t = su.get("output_tokens")
                            usage_input = int(in_t) if isinstance(in_t, int) else usage_input
                            usage_cached = int(ca_t) if isinstance(ca_t, int) else usage_cached
                            usage_output = int(ou_t) if isinstance(ou_t, int) else usage_output
                    sid = event.get("session_id", "")
                    if sid:
                        discovered_thread = sid

                if ev_type == "assistant":
                    msg_obj = event.get("message", {})
                    contents = msg_obj.get("content", [])
                    full_text = "".join(
                        b.get("text", "") for b in contents
                        if isinstance(b, dict) and b.get("type") == "text"
                    )
                    if full_text and not collected_text.strip():
                        collected_text = full_text
                        on_text(collected_text)

                if ev_type == "result":
                    sid = event.get("session_id", "")
                    if sid:
                        discovered_thread = sid
                    result_text = event.get("result", "")
                    if result_text and not collected_text.strip():
                        collected_text = result_text
                    usage_data = event.get("usage", {})
                    if isinstance(usage_data, dict):
                        in_t = usage_data.get("input_tokens")
                        ca_t = usage_data.get("cache_read_input_tokens") or usage_data.get("cached_input_tokens")
                        ou_t = usage_data.get("output_tokens")
                        usage_input = int(in_t) if isinstance(in_t, int) else usage_input
                        usage_cached = int(ca_t) if isinstance(ca_t, int) else usage_cached
                        usage_output = int(ou_t) if isinstance(ou_t, int) else usage_output

            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        except Exception as exc:
            self._log(f"stream error: {exc}", err=True)
            try:
                proc.kill()
            except Exception:
                pass

        stderr = ""
        if proc.stderr:
            try:
                stderr = proc.stderr.read().strip()
            except Exception:
                pass

        elapsed = time.time() - start
        ok = proc.returncode == 0

        if not collected_text.strip() and messages_buffer:
            collected_text = "\n\n".join(messages_buffer)

        if collected_text.strip():
            message = collected_text.strip()
        elif ok:
            message = "(no textual response)"
        else:
            message = f"Failed (exit={proc.returncode}).\n\n{stderr or '(no output)'}"

        return RunResult(
            thread_id=discovered_thread,
            message=message,
            ok=ok,
            elapsed_s=elapsed,
            input_tokens=usage_input,
            cached_input_tokens=usage_cached,
            output_tokens=usage_output,
        )

    def _spawn(self, prompt: str, engine: str, thread_id: str | None) -> subprocess.Popen:
        if engine == "codex":
            cmd = self._build_codex_cmd(thread_id)
        else:
            cmd = self._build_claude_cmd(thread_id)
        resume = f" resume={thread_id[:12]}" if thread_id else " new-thread"
        self._log(f"spawn {engine}{resume} prompt={prompt[:80]!r}")
        self._log(f"  cmd: {' '.join(cmd)[:200]}")
        proc = subprocess.Popen(
            cmd,
            cwd=str(self.workdir),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if proc.stdin:
            try:
                proc.stdin.write(prompt)
                proc.stdin.close()
            except BrokenPipeError:
                pass
        return proc

    def _stream_run(
        self,
        chat_id: int,
        placeholder_msg_id: int,
        prompt: str,
        thread_id: str | None,
        engine: str,
    ) -> RunResult:
        proc = self._spawn(prompt, engine, thread_id)
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
            # Truncate for Telegram's 4096 limit, leaving room for header
            max_body = 3800
            body = escape_html(display[-max_body:]) if len(display) > max_body else escape_html(display)
            if len(display) > max_body:
                body = "...\n" + body
            header = f"<code>{escape_html(engine)} | {elapsed:.0f}s ...</code>"
            html_text = f"{body}\n\n{header}"
            try:
                self._edit_message(chat_id, placeholder_msg_id, html_text, parse_mode="HTML")
                last_edit = now
                edit_count += 1
            except Exception as exc:
                self._log(f"stream edit failed: {exc}", err=True)

        result = self._parse_events(proc, engine, thread_id, on_text)
        self._log(
            f"done engine={engine} ok={result.ok} "
            f"elapsed={result.elapsed_s:.1f}s edits={edit_count} "
            f"tokens=in:{fmt_tokens(result.input_tokens)}"
            f"/cached:{fmt_tokens(result.cached_input_tokens)}"
            f"/out:{fmt_tokens(result.output_tokens)}"
        )
        return result

    def _run_blocking(self, prompt: str, engine: str) -> RunResult:
        """Run LLM without streaming (used for battle mode threads)."""
        proc = self._spawn(prompt, engine, None)
        result = self._parse_events(proc, engine, None, lambda _: None)
        return result

    # -----------------------------------------------------------------------
    # Battle mode
    # -----------------------------------------------------------------------

    def _handle_battle(self, chat_id: int, message_id: int | None, prompt: str) -> None:
        engines = sorted(VALID_ENGINES)
        self._log(f"battle started: {engines[0]} vs {engines[1]}")
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
            t.join(timeout=self.run_timeout + 30)

        parts: list[str] = [f"<b>BATTLE</b>  {escape_html(prompt[:80])}\n"]
        for eng in engines:
            r = results.get(eng)
            err = errors.get(eng)
            parts.append(f"<b>▎{escape_html(eng.upper())}</b>")
            if err:
                parts.append(f"Error: {escape_html(err)}")
            elif r:
                stats = f"{r.elapsed_s:.1f}s"
                if r.input_tokens is not None and r.output_tokens is not None:
                    stats += f" | {fmt_tokens(r.input_tokens + r.output_tokens)} tokens"
                parts.append(f"{escape_html(r.message)}\n<code>{stats}</code>")
            else:
                parts.append("(no result)")
            parts.append("")

        for eng in engines:
            r = results.get(eng)
            if r:
                self._log(f"battle {eng}: {r.elapsed_s:.1f}s ok={r.ok} tokens=out:{fmt_tokens(r.output_tokens)}")

        full_text = "\n".join(parts).strip()
        chunks = trim_text(full_text, limit=3800)
        self._edit_message(chat_id, placeholder_id, chunks[0], parse_mode="HTML")
        for chunk in chunks[1:]:
            self._send_message(chat_id, chunk, parse_mode="HTML")

    # -----------------------------------------------------------------------
    # Formatting
    # -----------------------------------------------------------------------

    def _session_summary_html(self, chat_id: int) -> str:
        cs = self._ensure_chat_state(chat_id)
        active = cs["active"]
        engine = cs.get("engine", self.default_engine)
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
                    token_parts.append(f"in:{fmt_tokens(in_t)}")
                if ca_t:
                    token_parts.append(f"cached:{fmt_tokens(ca_t)}")
                if ou_t is not None:
                    token_parts.append(f"out:{fmt_tokens(ou_t)}")
                parts.append(" ".join(token_parts))
        tid = thread_id or (result.thread_id if result else None)
        if tid:
            parts.append(tid[:12])
        return "<code>" + " | ".join(parts) + "</code>"

    def _send_final_reply(
        self, chat_id: int, placeholder_msg_id: int,
        session_name: str, engine: str, result: RunResult,
    ) -> None:
        meta = self._format_meta_html(session_name, result.thread_id, engine, result)
        body = escape_html(result.message)
        html_text = f"{body}\n\n{meta}"
        chunks = trim_text(html_text, limit=3800)
        self._edit_message(chat_id, placeholder_msg_id, chunks[0], parse_mode="HTML")
        for chunk in chunks[1:]:
            self._send_message(chat_id, chunk, parse_mode="HTML")

    # -----------------------------------------------------------------------
    # Help
    # -----------------------------------------------------------------------

    def _help_html(self) -> str:
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
            "<i>DM: send text directly. Group: @mention or reply.</i>"
        )

    # -----------------------------------------------------------------------
    # Message routing
    # -----------------------------------------------------------------------

    def _should_handle(self, msg: dict[str, Any]) -> bool:
        chat = msg.get("chat", {})
        chat_id = chat.get("id")
        if chat_id is None:
            return False
        if self.allowed_chat_ids and int(chat_id) not in self.allowed_chat_ids:
            return False
        chat_type = chat.get("type", "")
        text = (msg.get("text") or "").strip()
        if chat_type == "private":
            return bool(text)
        if text.startswith("/"):
            return True
        if not self.require_mention:
            return bool(text)
        mention = f"@{self.bot_username.lower()}" if self.bot_username else ""
        if mention and mention in text.lower():
            return True
        reply_to = msg.get("reply_to_message", {})
        if reply_to.get("from", {}).get("id") == self.bot_id:
            return True
        return False

    def _clean_prompt(self, text: str) -> str:
        if self.bot_username:
            text = text.replace(f"@{self.bot_username}", "")
            text = text.replace(f"@{self.bot_username.lower()}", "")
            text = text.replace(f"@{self.bot_username.upper()}", "")
        return text.strip()

    # -----------------------------------------------------------------------
    # Command handlers
    # -----------------------------------------------------------------------

    def _handle_session_command(self, chat_id: int, arg: str, engine: str) -> str | None:
        """Returns HTML string for immediate reply, or None if caller should stream."""
        active, tid = self._session_for_chat(chat_id)
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
            self._set_active_session(chat_id, name)
            _, tid = self._session_for_chat(chat_id)
            meta = self._format_meta_html(name, tid, engine)
            return f"Switched to session: <b>{escape_html(name)}</b>\n\n{meta}"

        if action == "new":
            if len(parts) < 2:
                return f"Usage: /session new &lt;name&gt; [prompt]\n\n{default_meta}"
            name = normalize_session_name(parts[1])
            self._set_active_session(chat_id, name)
            self._set_session_thread(chat_id, name, None)
            if not " ".join(parts[2:]).strip():
                meta = self._format_meta_html(name, None, engine)
                return f"Created session: <b>{escape_html(name)}</b>\n\n{meta}"
            return None  # has prompt, caller handles streaming

        if action in {"del", "delete", "rm"}:
            if len(parts) < 2:
                return f"Usage: /session del &lt;name&gt;\n\n{default_meta}"
            self._delete_session(chat_id, normalize_session_name(parts[1]))
            active, tid = self._session_for_chat(chat_id)
            meta = self._format_meta_html(active, tid, engine)
            return f"Deleted session: <b>{escape_html(parts[1])}</b>\n\n{meta}"

        return f"Unknown subcommand.\n\n{default_meta}"

    def _handle_text_message(self, msg: dict[str, Any]) -> None:
        chat_id = int(msg["chat"]["id"])
        message_id = msg.get("message_id")
        text = self._clean_prompt((msg.get("text") or "").strip())
        if not text:
            return
        engine = self._engine_for_chat(chat_id)

        if text.startswith("/"):
            head, _, tail = text.partition(" ")
            cmd = head[1:]
            if "@" in cmd:
                cmd = cmd.split("@", 1)[0]
            arg = tail.strip()

            if cmd in {"start", "help"}:
                session_name, tid = self._session_for_chat(chat_id)
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
                self._set_engine_for_chat(chat_id, new_engine)
                self._log(f"engine switched to {new_engine} chat={chat_id}")
                session_name, tid = self._session_for_chat(chat_id)
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
                self._set_session_thread(chat_id, session_name, result.thread_id)
                self._send_final_reply(chat_id, ph, session_name, engine, result)
                return

            if cmd in {"new", "reset"}:
                session_name, _ = self._session_for_chat(chat_id)
                self._set_session_thread(chat_id, session_name, None)
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
                self._set_session_thread(chat_id, session_name, result.thread_id)
                self._send_final_reply(chat_id, ph, session_name, engine, result)
                return

            if cmd == "stop":
                session_name, _ = self._session_for_chat(chat_id)
                self._set_session_thread(chat_id, session_name, None)
                meta = self._format_meta_html(session_name, None, engine)
                self._send_message(
                    chat_id,
                    f"Session cleared: <b>{escape_html(session_name)}</b>\n\n{meta}",
                    reply_to=message_id,
                    parse_mode="HTML",
                )
                return

            if cmd == "status":
                session_name, tid = self._session_for_chat(chat_id)
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
                # Delete bot's recent messages by scanning backwards
                count = 50
                if arg:
                    try:
                        count = min(int(arg), 200)
                    except ValueError:
                        pass
                self._log(f"clear: deleting up to {count} bot messages in chat={chat_id}")
                deleted = 0
                # Delete the /clear command itself first
                if message_id:
                    self._delete_message(chat_id, message_id)
                # Scan recent message IDs backwards from the command message
                if message_id:
                    for offset in range(1, count + 1):
                        mid = message_id - offset
                        if mid <= 0:
                            break
                        if self._delete_message(chat_id, mid):
                            deleted += 1
                self._log(f"clear: deleted {deleted} messages in chat={chat_id}")
                # Send a brief confirmation (will auto-delete feel)
                confirm = self._send_message(chat_id, f"<i>Cleared {deleted} messages.</i>", parse_mode="HTML")
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
        session_name, current_thread = self._session_for_chat(chat_id)
        ph = self._send_message(
            chat_id,
            f"<code>{escape_html(engine)} | thinking ...</code>",
            reply_to=message_id,
            parse_mode="HTML",
        )
        result = self._stream_run(chat_id, ph, text, current_thread, engine)
        if result.thread_id:
            self._set_session_thread(chat_id, session_name, result.thread_id)
        self._send_final_reply(chat_id, ph, session_name, engine, result)

    # -----------------------------------------------------------------------
    # Preflight & main loop
    # -----------------------------------------------------------------------

    def preflight(self) -> None:
        self._log("preflight: validating bot token...")
        me = self._api_call("getMe").get("result", {})
        self.bot_username = me.get("username", "")
        self.bot_id = int(me.get("id", 0))
        self._log(f"bot: @{self.bot_username} (id={self.bot_id})")

        if not self.workdir.exists():
            raise RuntimeError(f"Workdir not found: {self.workdir}")

        for eng in sorted(VALID_ENGINES):
            path = shutil.which(eng)
            status = path or "NOT FOUND"
            self._log(f"engine {eng}: {status}")

        self._log(f"config: default_engine={self.default_engine} workdir={self.workdir}")
        self._log(f"config: timeout={self.run_timeout}s full_access={self.codex_full_access} claude_mode={self.claude_permission_mode}")
        if self.allowed_chat_ids:
            self._log(f"config: allowed_ids={sorted(self.allowed_chat_ids)}")
        else:
            self._log("config: allowed_ids=ANY (no restriction)")

    def _send_startup_notice(self) -> None:
        """Send an online notice to all allowed chats (and previously seen chats)."""
        targets: set[int] = set(self.allowed_chat_ids)
        for key in self.state.get("chats", {}):
            try:
                targets.add(int(key))
            except ValueError:
                pass
        if not targets:
            self._log("startup notice: no known chats yet — send any message to the bot first, or set --allowed-ids")
            return
        engines = []
        for eng in sorted(VALID_ENGINES):
            if shutil.which(eng):
                engines.append(eng)
        engine_list = ", ".join(engines) if engines else "none found"
        text = (
            f"<b>codeclaw</b> v{__version__} online\n"
            f"\n"
            f"<b>Engine:</b> {escape_html(self.default_engine)}\n"
            f"<b>Available:</b> {escape_html(engine_list)}\n"
            f"<b>Workdir:</b> <code>{escape_html(str(self.workdir))}</code>\n"
            f"\n"
            f"<i>/help for commands</i>"
        )
        for cid in sorted(targets):
            try:
                self._send_message(cid, text, parse_mode="HTML")
                self._log(f"startup notice sent to chat={cid}")
            except Exception as exc:
                self._log(f"startup notice failed for chat={cid}: {exc}", err=True)

    def run(self) -> None:
        self._acquire_lock()
        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)
        self.preflight()
        self._send_startup_notice()

        self._log(f"polling started (mention_required={self.require_mention})")

        while self.running:
            offset = int(self.state.get("last_update_id", 0)) + 1
            try:
                updates = self._api_call(
                    "getUpdates",
                    {"timeout": self.poll_timeout, "offset": offset, "allowed_updates": ["message"]},
                ).get("result", [])
            except error.URLError as exc:
                self._log(f"network error: {exc}", err=True)
                time.sleep(3)
                continue
            except Exception as exc:
                self._log(f"poll error: {exc}", err=True)
                time.sleep(3)
                continue

            for update in updates:
                uid = int(update.get("update_id", 0))
                self.state["last_update_id"] = max(int(self.state.get("last_update_id", 0)), uid)
                self._save_state()
                msg = update.get("message")
                if not isinstance(msg, dict) or not self._should_handle(msg):
                    continue

                chat_id = msg["chat"]["id"]
                user = msg.get("from", {})
                username = user.get("username", "") or user.get("first_name", "")
                preview = (msg.get("text") or "").strip().replace("\n", " ")[:100]
                self._log(f"msg chat={chat_id} user={username} {preview!r}")

                try:
                    self._handle_text_message(msg)
                except subprocess.TimeoutExpired:
                    self._log(f"timeout after {self.run_timeout}s chat={chat_id}", err=True)
                    eng = self._engine_for_chat(int(chat_id))
                    sn, tid = self._session_for_chat(int(chat_id))
                    meta = self._format_meta_html(sn, tid, eng)
                    self._send_message(
                        int(chat_id),
                        f"Timeout (&gt;{self.run_timeout}s)\n\n{meta}",
                        reply_to=msg.get("message_id"),
                        parse_mode="HTML",
                    )
                except Exception as exc:
                    self._log(f"error chat={chat_id}: {exc}", err=True)
                    eng = self._engine_for_chat(int(chat_id))
                    sn, tid = self._session_for_chat(int(chat_id))
                    meta = self._format_meta_html(sn, tid, eng)
                    self._send_message(
                        int(chat_id),
                        f"Error: {escape_html(str(exc))}\n\n{meta}",
                        reply_to=msg.get("message_id"),
                        parse_mode="HTML",
                    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

SUPPORTED_CHANNELS = {"telegram"}
PLANNED_CHANNELS = {"slack", "discord", "dingtalk", "feishu"}
ALL_CHANNELS = SUPPORTED_CHANNELS | PLANNED_CHANNELS


def main() -> int:
    epilog = """\
examples:
  # Telegram + Claude Code (most common)
  codeclaw -c telegram -t $BOT_TOKEN

  # Telegram + Codex, safe mode, only allow specific chats
  codeclaw -c telegram -t $BOT_TOKEN -e codex --safe-mode --allowed-ids 123456,789012

  # Custom model, custom working directory
  codeclaw -c telegram -t $BOT_TOKEN -m sonnet -w ~/projects/my-app

  # Validate setup without starting the bot
  codeclaw -c telegram -t $BOT_TOKEN --self-check

environment variables:
  Every flag can be set via env var. Env vars are overridden by CLI flags.

  CODECLAW_CHANNEL        IM channel (same as -c)
  CODECLAW_TOKEN          Bot token (same as -t)
  CODECLAW_WORKDIR        Working directory (same as -w)
  CODECLAW_TIMEOUT        Timeout in seconds (same as --timeout)
  CODECLAW_FULL_ACCESS    "true" or "false" (same as --full-access)
  CODECLAW_ALLOWED_IDS    Comma-separated IDs (same as --allowed-ids)
  DEFAULT_ENGINE          AI engine (same as -e)
  CLAUDE_MODEL            Claude model name (e.g. sonnet, opus)
  CLAUDE_PERMISSION_MODE  "bypassPermissions" (default) or "default"
  CLAUDE_EXTRA_ARGS       Extra args passed to claude CLI
  CODEX_MODEL             Codex model name (e.g. o3, o4-mini)
  CODEX_REASONING_EFFORT  none | minimal | low | medium | high | xhigh
  CODEX_EXTRA_ARGS        Extra args passed to codex CLI

how it works:
  codeclaw runs in your project directory and does three things:
  1. Long-polls your IM for new messages
  2. Spawns "claude" or "codex" CLI as a subprocess in your workdir
  3. Streams the AI output back to chat via message edits (every 1.5s)

  The AI agent has full access to your local filesystem — same as
  running it in your terminal. Use --safe-mode to require confirmation
  before destructive operations.

bot commands (sent from your IM):
  /ask <prompt>           Ask the AI agent (or just send text in DM)
  /engine [codex|claude]  Show or switch the AI engine
  /battle <prompt>        Run both engines in parallel, compare results
  /new [prompt]           Reset current session (clear thread history)
  /session list           List all sessions for this chat
  /session use <name>     Switch to a named session
  /session new <name>     Create a new session
  /session del <name>     Delete a session
  /status                 Show session, engine, and thread info
  /clear [N]              Delete bot's recent messages (default 50)
  /help                   Show help in chat

prerequisites:
  - Python 3.10+ (or the standalone binary)
  - "claude" CLI in PATH (for Claude Code engine)
  - "codex" CLI in PATH (for Codex engine)
  - A Telegram Bot Token (get one from @BotFather)
"""

    parser = argparse.ArgumentParser(
        prog="codeclaw",
        description=(
            "codeclaw — one binary, zero config, bridge AI coding agents to any IM.\n"
            "\n"
            "Run this in your project directory. It connects your IM (Telegram, etc.)\n"
            "to a local AI coding agent (Claude Code / Codex CLI) that can read, write,\n"
            "and execute code in your codebase. Supports streaming output, multi-session\n"
            "management, dual-engine switching, and battle mode."
        ),
        epilog=epilog,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    conn = parser.add_argument_group("connection")
    conn.add_argument(
        "--channel", "-c",
        choices=sorted(ALL_CHANNELS),
        default=os.getenv("CODECLAW_CHANNEL", "telegram"),
        help="IM channel to connect to (default: telegram). "
             "Currently supported: telegram. Planned: slack, discord, dingtalk, feishu.",
    )
    conn.add_argument(
        "--token", "-t",
        help="Bot token for the IM channel. "
             "For Telegram, get this from @BotFather. "
             "Can also be set via CODECLAW_TOKEN env var.",
    )

    engine_group = parser.add_argument_group("engine")
    engine_group.add_argument(
        "--engine", "-e",
        choices=sorted(VALID_ENGINES),
        help="AI engine to use (default: claude). "
             "claude = Claude Code CLI, codex = OpenAI Codex CLI. "
             "Switch at runtime via /engine command in chat.",
    )
    engine_group.add_argument(
        "--model", "-m",
        help="Model override. Passed to the active engine. "
             "Examples: sonnet, opus (Claude); o3, o4-mini (Codex).",
    )
    engine_group.add_argument(
        "--workdir", "-w",
        help="Working directory for the AI agent (default: current directory). "
             "The agent reads and writes files relative to this path.",
    )

    access = parser.add_argument_group("access control")
    access.add_argument(
        "--full-access",
        action="store_true",
        default=None,
        help="Let the AI agent read, write, and execute without confirmation. "
             "This is the default. Maps to Claude --permission-mode=bypassPermissions "
             "and Codex --dangerously-bypass-approvals-and-sandbox.",
    )
    access.add_argument(
        "--safe-mode",
        action="store_true",
        default=False,
        help="Require confirmation before destructive operations. "
             "Overrides --full-access. Maps to Claude --permission-mode=default "
             "and disables Codex sandbox bypass.",
    )
    access.add_argument(
        "--allowed-ids",
        help="Comma-separated list of user/chat IDs allowed to interact with the bot. "
             "If not set, all users can interact. "
             "Example: --allowed-ids 123456,789012,-100987654",
    )
    access.add_argument(
        "--timeout",
        type=int,
        help="Max seconds the AI agent can run per request (default: 300). "
             "The process is killed if it exceeds this limit.",
    )

    parser.add_argument(
        "--self-check",
        action="store_true",
        help="Validate token, check CLI availability, and exit. "
             "Useful for verifying setup before running.",
    )
    parser.add_argument(
        "--version", "-v",
        action="version",
        version=f"codeclaw {__version__}",
    )

    args = parser.parse_args()

    # Channel validation
    if args.channel in PLANNED_CHANNELS:
        print(f"[codeclaw] '{args.channel}' is planned but not yet implemented. Currently supported: {', '.join(sorted(SUPPORTED_CHANNELS))}", file=sys.stderr)
        return 1

    # Map unified flags to env vars
    token = args.token or os.getenv("CODECLAW_TOKEN", "")
    if token:
        os.environ["TELEGRAM_BOT_TOKEN"] = token
    if args.engine:
        os.environ["DEFAULT_ENGINE"] = args.engine
    if args.workdir:
        os.environ["CODECLAW_WORKDIR"] = args.workdir
    if args.model:
        engine = args.engine or os.getenv("DEFAULT_ENGINE", "claude")
        if engine == "codex":
            os.environ["CODEX_MODEL"] = args.model
        else:
            os.environ["CLAUDE_MODEL"] = args.model
    if args.allowed_ids:
        os.environ["TELEGRAM_ALLOWED_CHAT_IDS"] = args.allowed_ids
    if args.timeout is not None:
        os.environ["CODECLAW_TIMEOUT"] = str(args.timeout)

    # Access control: --safe-mode overrides --full-access
    if args.safe_mode:
        os.environ["CODEX_FULL_ACCESS"] = "false"
        os.environ["CLAUDE_PERMISSION_MODE"] = "default"
    elif args.full_access or os.getenv("CODECLAW_FULL_ACCESS", "true").lower() in {"1", "true", "yes", "on"}:
        os.environ["CODEX_FULL_ACCESS"] = "true"
        os.environ["CLAUDE_PERMISSION_MODE"] = "bypassPermissions"

    claw = CodeClaw()
    if args.self_check:
        claw._acquire_lock()
        claw.preflight()
        print("[codeclaw] ok", flush=True)
        return 0

    claw.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
