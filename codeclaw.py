#!/usr/bin/env python3
"""codeclaw — one binary, zero config, bridge AI coding agents to any IM.

Core orchestrator: config, state management, engine execution, CLI entry point.
Channel-specific interaction is in separate files (channel_telegram.py, etc.).
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
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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
# Core
# ---------------------------------------------------------------------------

class CodeClaw:
    """Core orchestrator — config, state, engine execution.

    Channel-specific logic (Telegram, Feishu, etc.) lives in separate files.
    """

    def __init__(self) -> None:
        token = (os.getenv("TELEGRAM_BOT_TOKEN") or os.getenv("CODECLAW_TOKEN") or "").strip()
        if not token:
            raise RuntimeError("Missing token. Use -t TOKEN or set CODECLAW_TOKEN / TELEGRAM_BOT_TOKEN")
        self.token = token

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
        self._replaced_old_process = False

        self.state: dict[str, Any] = {"last_update_id": 0, "chats": {}}
        self._load_state()

    # -------------------------------------------------------------------
    # Logging
    # -------------------------------------------------------------------

    def _log(self, msg: str, *, err: bool = False) -> None:
        ts = time.strftime("%H:%M:%S")
        out = sys.stderr if err else sys.stdout
        print(f"[codeclaw {ts}] {msg}", file=out, flush=True)

    # -------------------------------------------------------------------
    # State management
    # -------------------------------------------------------------------

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

    # -------------------------------------------------------------------
    # Session helpers
    # -------------------------------------------------------------------

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

    # -------------------------------------------------------------------
    # Process lock & lifecycle
    # -------------------------------------------------------------------

    def _acquire_lock(self) -> None:
        old_pid = self._read_pid_file(self.lock_file)
        self.lock_handle = self.lock_file.open("w", encoding="utf-8")
        try:
            fcntl.flock(self.lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock_handle.close()
            if old_pid and old_pid != os.getpid():
                self._kill_process(old_pid)
            else:
                self._log("lock held but no PID recorded, searching for codeclaw processes ...")
                self._kill_sibling_processes()
            time.sleep(0.5)
            self.lock_handle = self.lock_file.open("w", encoding="utf-8")
            try:
                fcntl.flock(self.lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise RuntimeError(f"Failed to acquire lock: {self.lock_file}") from exc
        self.lock_handle.write(str(os.getpid()))
        self.lock_handle.flush()

    def _kill_sibling_processes(self) -> None:
        my_pid = os.getpid()
        try:
            out = subprocess.check_output(
                ["pgrep", "-f", "codeclaw"], text=True, timeout=5
            ).strip()
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            return
        for line in out.splitlines():
            try:
                pid = int(line.strip())
            except ValueError:
                continue
            if pid != my_pid:
                self._kill_process(pid)

    @staticmethod
    def _read_pid_file(path: Path) -> int | None:
        try:
            content = path.read_text(encoding="utf-8").strip()
            return int(content) if content else None
        except (OSError, ValueError):
            return None

    def _kill_process(self, pid: int) -> None:
        self._replaced_old_process = True
        self._log(f"killing existing process (PID {pid}) ...")
        try:
            os.kill(pid, signal.SIGTERM)
            for _ in range(30):
                time.sleep(0.1)
                try:
                    os.kill(pid, 0)
                except OSError:
                    break
            else:
                self._log(f"force killing PID {pid}")
                os.kill(pid, signal.SIGKILL)
                time.sleep(0.3)
        except OSError:
            pass
        self._log(f"old process (PID {pid}) terminated")

    def _ensure_single_bot(self) -> None:
        pid_file = self.state_dir / f"bot_{self.bot_id}.pid"
        old_pid = self._read_pid_file(pid_file)
        if old_pid and old_pid != os.getpid():
            try:
                os.kill(old_pid, 0)
            except OSError:
                old_pid = None
        if old_pid and old_pid != os.getpid():
            self._log(f"same bot @{self.bot_username} running elsewhere (PID {old_pid})")
            self._kill_process(old_pid)
        pid_file.write_text(str(os.getpid()), encoding="utf-8")

    def _handle_signal(self, signum: int, _frame: Any) -> None:
        self.running = False
        self._log(f"signal {signum}, shutting down...")
        self._stop_keep_alive()

    # -------------------------------------------------------------------
    # Keep-alive (prevent idle sleep)
    # -------------------------------------------------------------------

    def _start_keep_alive(self) -> None:
        """Spawn an OS-level process to prevent idle/display sleep."""
        self._keep_alive_proc: subprocess.Popen | None = None
        platform = sys.platform

        if platform == "darwin":
            caffeinate = shutil.which("caffeinate")
            if caffeinate:
                self._keep_alive_proc = subprocess.Popen(
                    [caffeinate, "-dis"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                self._log(f"keep-alive: caffeinate started (PID {self._keep_alive_proc.pid})")
            else:
                self._log("keep-alive: caffeinate not found, skipping", err=True)

        elif platform.startswith("linux"):
            inhibit = shutil.which("systemd-inhibit")
            if inhibit:
                self._keep_alive_proc = subprocess.Popen(
                    [inhibit, "--what=idle", "--who=codeclaw",
                     "--why=AI coding agent running", "sleep", "infinity"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                self._log(f"keep-alive: systemd-inhibit started (PID {self._keep_alive_proc.pid})")
            else:
                self._log("keep-alive: systemd-inhibit not found, skipping", err=True)

        else:
            self._log(f"keep-alive: unsupported platform ({platform}), skipping")

    def _stop_keep_alive(self) -> None:
        proc = getattr(self, "_keep_alive_proc", None)
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            self._log("keep-alive: stopped")

    # -------------------------------------------------------------------
    # Engine command builders
    # -------------------------------------------------------------------

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

    # -------------------------------------------------------------------
    # Engine execution
    # -------------------------------------------------------------------

    def spawn(self, prompt: str, engine: str, thread_id: str | None) -> subprocess.Popen:
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

    def parse_events(
        self,
        proc: subprocess.Popen,
        engine: str,
        thread_id: str | None,
        on_text: Any,
    ) -> RunResult:
        """Read JSONL from proc.stdout, call on_text(collected) for streaming, return RunResult."""
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

    # -------------------------------------------------------------------
    # Preflight & run
    # -------------------------------------------------------------------

    def preflight(self) -> None:
        from urllib import request as _req
        url = f"https://api.telegram.org/bot{self.token}/getMe"
        req = _req.Request(url, data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
        self._log("preflight: validating bot token...")
        with _req.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        me = data.get("result", {})
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

    def run(self) -> None:
        self._acquire_lock()
        signal.signal(signal.SIGINT, self._handle_signal)
        signal.signal(signal.SIGTERM, self._handle_signal)
        self.preflight()
        self._ensure_single_bot()
        self._start_keep_alive()

        try:
            # Delegate to channel
            from channel_telegram import TelegramChannel
            channel = TelegramChannel(self)
            channel.run()
        finally:
            self._stop_keep_alive()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

SUPPORTED_CHANNELS = {"telegram"}
PLANNED_CHANNELS = {"slack", "discord", "dingtalk", "feishu"}
ALL_CHANNELS = SUPPORTED_CHANNELS | PLANNED_CHANNELS


def main() -> int:
    epilog = """\
examples:
  codeclaw -t $BOT_TOKEN
  codeclaw -t $BOT_TOKEN -e codex --safe-mode --allowed-ids 123456,789012
  codeclaw -t $BOT_TOKEN -m sonnet -w ~/projects/my-app
  codeclaw -t $BOT_TOKEN --self-check

environment variables:
  CODECLAW_TOKEN          Bot token (same as -t)
  CODECLAW_WORKDIR        Working directory (same as -w)
  CODECLAW_TIMEOUT        Timeout in seconds (same as --timeout)
  DEFAULT_ENGINE          AI engine (same as -e)
  CLAUDE_MODEL            Claude model name
  CLAUDE_PERMISSION_MODE  bypassPermissions (default) or default
  CLAUDE_EXTRA_ARGS       Extra args passed to claude CLI
  CODEX_MODEL             Codex model name
  CODEX_REASONING_EFFORT  none | minimal | low | medium | high | xhigh
  CODEX_EXTRA_ARGS        Extra args passed to codex CLI
"""

    parser = argparse.ArgumentParser(
        prog="codeclaw",
        description="codeclaw — bridge AI coding agents to your IM.",
        epilog=epilog,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    conn = parser.add_argument_group("connection")
    conn.add_argument(
        "--channel", "-c",
        choices=sorted(ALL_CHANNELS),
        default=os.getenv("CODECLAW_CHANNEL", "telegram"),
        help="IM channel (default: telegram).",
    )
    conn.add_argument("--token", "-t", help="Bot token.")

    engine_group = parser.add_argument_group("engine")
    engine_group.add_argument("--engine", "-e", choices=sorted(VALID_ENGINES), help="AI engine (default: claude).")
    engine_group.add_argument("--model", "-m", help="Model override.")
    engine_group.add_argument("--workdir", "-w", help="Working directory (default: cwd).")

    access = parser.add_argument_group("access control")
    access.add_argument("--full-access", action="store_true", default=None, help="Agent runs without confirmation (default).")
    access.add_argument("--safe-mode", action="store_true", default=False, help="Require confirmation for destructive ops.")
    access.add_argument("--allowed-ids", help="Comma-separated user/chat ID whitelist.")
    access.add_argument("--timeout", type=int, help="Max seconds per request (default: 300).")

    parser.add_argument("--self-check", action="store_true", help="Validate setup and exit.")
    parser.add_argument("--version", "-v", action="version", version=f"codeclaw {__version__}")

    args = parser.parse_args()

    if args.channel in PLANNED_CHANNELS:
        print(f"[codeclaw] '{args.channel}' is planned but not yet implemented. Currently supported: {', '.join(sorted(SUPPORTED_CHANNELS))}", file=sys.stderr)
        return 1

    # Map CLI flags to env vars
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
