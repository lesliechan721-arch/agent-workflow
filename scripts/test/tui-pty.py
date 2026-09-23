#!/usr/bin/env python3
"""Run the production Ink TUI in a real POSIX pseudo-terminal."""

from __future__ import annotations

import argparse
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "packages/cli/tests/fixtures/tui-pty-fixture.mjs"
DIST_ENTRY = ROOT / "packages/cli/dist/src/tui/console-app-v4.js"
ANSI = re.compile(rb"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][0-2A-Z]|[=>])")
SGR = re.compile(rb"\x1b\[([0-9;]*)m")


class HarnessFailure(RuntimeError):
    pass


def set_size(fd: int, columns: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))


def read_events(path: Path) -> list[dict[str, object]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def last_route(events: list[dict[str, object]]) -> str | None:
    for event in reversed(events):
        route = event.get("route")
        if event.get("type") == "controller" and isinstance(route, dict):
            name = route.get("name")
            return name if isinstance(name, str) else None
    return None


def contains_color_sgr(output: bytes) -> bool:
    for match in SGR.finditer(output):
        parameters = [int(value) if value else 0 for value in match.group(1).split(b";")]
        if any(
            30 <= value <= 37
            or 40 <= value <= 47
            or 90 <= value <= 97
            or 100 <= value <= 107
            or value in (38, 48, 58)
            for value in parameters
        ):
            return True
    return False


def compact_plain(output: bytes) -> bytes:
    return re.sub(rb"\s+", b"", ANSI.sub(b"", output))


class PtySession:
    def __init__(self, columns: int, rows: int, timeout: float, scenario: str) -> None:
        self.columns = columns
        self.rows = rows
        self.timeout = timeout
        self.started = time.monotonic()
        self.output = bytearray()
        self.temp = tempfile.TemporaryDirectory(prefix="aw-tui-pty-")
        self.root = Path(self.temp.name)
        self.event_path = self.root / "events.jsonl"
        self.master_fd, slave_fd = pty.openpty()
        set_size(slave_fd, columns, rows)
        env = os.environ.copy()
        env.update({
            "HOME": str(self.root / "home"),
            "AW_HOME": str(self.root / "aw"),
            "AW_CODEX_HOME": str(self.root / "codex"),
            "AW_CLAUDE_HOME": str(self.root / "claude"),
            "AW_PTY_SANDBOX_ROOT": str(self.root),
            "AW_PTY_EVENT_LOG": str(self.event_path),
            "AW_PTY_SCENARIO": scenario,
            "NO_COLOR": "1",
            "FORCE_COLOR": "0",
            "CI": "",
            "TERM": "xterm-256color",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        })
        for directory in (env["HOME"], env["AW_HOME"], env["AW_CODEX_HOME"], env["AW_CLAUDE_HOME"]):
            Path(directory).mkdir(parents=True)
        self.process = subprocess.Popen(
            ["node", str(FIXTURE)],
            cwd=ROOT,
            env=env,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            start_new_session=True,
            close_fds=True,
        )
        os.close(slave_fd)
        os.set_blocking(self.master_fd, False)

    def remaining(self) -> float:
        value = self.timeout - (time.monotonic() - self.started)
        if value <= 0:
            raise HarnessFailure(f"session timed out after {self.timeout:.1f}s")
        return value

    def drain(self, wait: float = 0.05) -> None:
        ready, _, _ = select.select([self.master_fd], [], [], min(wait, self.remaining()))
        if not ready:
            return
        while True:
            try:
                chunk = os.read(self.master_fd, 65536)
            except BlockingIOError:
                break
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            self.output.extend(chunk)

    def wait_for(self, predicate, description: str) -> None:
        while True:
            try:
                self.drain(0.1)
            except HarnessFailure as error:
                events = read_events(self.event_path)
                plain_tail = ANSI.sub(b"", bytes(self.output[-2000:])).decode("utf-8", errors="replace")
                raise HarnessFailure(
                    f"{error}; waiting for {description}; route={last_route(events)}; output={plain_tail!r}"
                ) from error
            events = read_events(self.event_path)
            if predicate(events):
                return
            if self.process.poll() is not None:
                raise HarnessFailure(
                    f"process exited {self.process.returncode} before {description}; route={last_route(events)}"
                )
        raise HarnessFailure(f"did not observe {description}")

    def wait_route(self, name: str, context_check=None) -> None:
        def matches(events: list[dict[str, object]]) -> bool:
            latest = None
            for event in reversed(events):
                if event.get("type") == "controller":
                    latest = event
                    break
            if latest is None:
                return False
            route = latest.get("route")
            context = latest.get("context")
            return isinstance(route, dict) and route.get("name") == name and (
                context_check is None or context_check(context if isinstance(context, dict) else {})
            )

        self.wait_for(matches, f"route {name}")

    def wait_text(self, text: str) -> None:
        encoded = text.encode("utf-8")
        self.wait_for(lambda _events: encoded in ANSI.sub(b"", bytes(self.output)), f"text {text!r}")

    def wait_event(self, event_type: str) -> None:
        self.wait_for(
            lambda events: any(event.get("type") == event_type for event in events),
            f"event {event_type}",
        )

    def send(self, data: bytes) -> None:
        os.write(self.master_fd, data)
        time.sleep(0.12)
        self.drain()

    def resize(self, columns: int, rows: int) -> None:
        set_size(self.master_fd, columns, rows)
        os.kill(self.process.pid, signal.SIGWINCH)
        self.wait_for(
            lambda events: any(
                event.get("type") == "resize"
                and event.get("columns") == columns
                and event.get("rows") == rows
                for event in events
            ),
            f"resize {columns}x{rows}",
        )

    def finish(self, allow_signal_cleanup: bool = False) -> tuple[bytes, list[dict[str, object]]]:
        try:
            remaining = self.remaining()
            self.process.wait(timeout=max(0.1, remaining))
        except HarnessFailure as error:
            self.drain()
            plain_tail = ANSI.sub(b"", bytes(self.output[-2000:])).decode("utf-8", errors="replace")
            raise HarnessFailure(f"{error}; fixture still running; output={plain_tail!r}") from error
        except subprocess.TimeoutExpired as error:
            self.drain()
            plain_tail = ANSI.sub(b"", bytes(self.output[-2000:])).decode("utf-8", errors="replace")
            raise HarnessFailure(f"fixture did not exit; output={plain_tail!r}") from error
        self.drain()
        events = read_events(self.event_path)
        if self.process.returncode != 0 and not (
            allow_signal_cleanup and self.process.returncode in (-signal.SIGTERM, -signal.SIGKILL)
        ):
            raise HarnessFailure(f"fixture exited {self.process.returncode}; events={events[-3:]}")
        return bytes(self.output), events

    def stop_after_ui_exit_request(self) -> bool:
        self.wait_for(
            lambda events: any(event.get("type") == "ui-exit-request" for event in events),
            "production UI exit request",
        )
        deadline = time.monotonic() + 1.0
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                return False
            self.drain(0.05)
        os.killpg(self.process.pid, signal.SIGTERM)
        return True

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
                self.process.wait(timeout=1.0)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait(timeout=1.0)
        os.close(self.master_fd)
        self.temp.cleanup()


def assert_isolation(events: list[dict[str, object]], scenario: str) -> None:
    fixtures = [event for event in events if event.get("type") == "fixture"]
    if len(fixtures) != 1:
        raise HarnessFailure("fixture environment evidence is missing")
    fixture = fixtures[0]
    if fixture.get("scenario") != scenario:
        raise HarnessFailure("fixture scenario does not match the requested scenario")
    if fixture.get("fakeNative") is not True or fixture.get("fakeExecutor") is not True:
        raise HarnessFailure("fixture did not declare fake native and executor boundaries")
    tty = fixture.get("tty")
    if not isinstance(tty, dict) or tty.get("stdin") is not True or tty.get("stdout") is not True:
        raise HarnessFailure("child stdin/stdout are not TTYs")
    homes = fixture.get("homes")
    if not isinstance(homes, dict) or len(set(homes.values())) != 4:
        raise HarnessFailure("fixture homes are not independently isolated")
    sandbox_root = fixture.get("sandboxRoot")
    if not isinstance(sandbox_root, str) or not all(
        isinstance(home, str) and Path(home).resolve().is_relative_to(Path(sandbox_root).resolve())
        for home in homes.values()
    ):
        raise HarnessFailure("fixture homes are outside the per-session sandbox root")


def exit_ui(session: PtySession, dirty: bool = False) -> tuple[bytes, list[dict[str, object]]]:
    session.send(b"q")
    session.wait_text("放弃未保存修改？" if dirty else "退出控制台？")
    session.send(b"\x1b[B")
    time.sleep(0.7)
    session.send(b"\r")
    signal_cleanup = session.stop_after_ui_exit_request()
    output, events = session.finish(allow_signal_cleanup=signal_cleanup)
    if signal_cleanup:
        raise HarnessFailure("production UI requested exit but the Ink runner required signal cleanup")
    if not any(event.get("type") == "runner-complete-returned" for event in events):
        raise HarnessFailure("Ink runner completion callback did not return")
    return output, events


def assert_terminal_output(output: bytes) -> str:
    plain = ANSI.sub(b"", output).decode("utf-8", errors="replace")
    if contains_color_sgr(output):
        raise HarnessFailure("PTY output contains color SGR while NO_COLOR is active")
    return plain


def confirm_review(session: PtySession) -> None:
    events = read_events(session.event_path)
    latest = next((event for event in reversed(events) if event.get("type") == "controller"), None)
    review = latest.get("activeReview") if isinstance(latest, dict) else None
    if isinstance(review, dict) and review.get("requiresConfirmation") is True:
        session.send(b"\r")
        session.send(b"\x1b[B")
        session.send(b"\r")
    else:
        session.send(b"\r")


def run_browse(columns: int, rows: int, timeout: float, resize_to: tuple[int, int] | None) -> dict[str, object]:
    session = PtySession(columns, rows, timeout, "browse")
    stage = "home"
    marks: list[tuple[str, float]] = []
    def mark(name: str) -> None:
        marks.append((name, round(time.monotonic() - session.started, 3)))
    try:
        session.wait_route("home")
        session.wait_text("q 退出")
        mark("home")
        stage = "open plugin list"
        session.send(b"\r")
        session.wait_route("pluginList")
        mark("pluginList")
        stage = "enter query"
        session.send(b"/")
        session.send(b"Review")
        session.send(b"\x1b")
        session.wait_route("pluginList")
        session.wait_text("/ 编辑")
        session.wait_text("Review Gate 审查门禁")
        mark("query")
        stage = "filter installed"
        session.send(b"f")
        session.wait_route("pluginList", lambda context: context.get("installFilter") == "installed")
        mark("filter")
        if resize_to:
            stage = "resize"
            session.resize(*resize_to)
            mark("resize")
        stage = "open detail"
        session.send(b"\r")
        session.wait_route("pluginDetail")
        mark("detail")
        stage = "escape detail"
        session.send(b"\x1b")
        session.wait_route(
            "pluginList",
            lambda context: context.get("query") == "Review" and context.get("installFilter") == "installed",
        )
        mark("back")
        stage = "exit confirmation"
        mark("exit-overlay")
        stage = "process exit"
        output, events = exit_ui(session)
        assert_isolation(events, "browse")
        plain = assert_terminal_output(output)
        if "代理实验室" not in plain and "审查门禁" not in plain:
            raise HarnessFailure("PTY output does not contain the CJK fixture text")
        route_names = [
            event["route"]["name"]
            for event in events
            if event.get("type") == "controller" and isinstance(event.get("route"), dict)
        ]
        required = ["home", "pluginList", "pluginDetail", "pluginList"]
        cursor = 0
        for route_name in route_names:
            if cursor < len(required) and route_name == required[cursor]:
                cursor += 1
        if cursor != len(required):
            raise HarnessFailure(f"continuous browse route sequence is incomplete: {route_names}")
        return {
            "initialSize": {"columns": columns, "rows": rows},
            "resizeTo": None if resize_to is None else {"columns": resize_to[0], "rows": resize_to[1]},
            "exitCode": session.process.returncode,
            "uiExitRequested": True,
            "cleanup": "natural",
            "ptyBytes": len(output),
            "routeSequence": required,
            "query": "Review",
            "filter": "installed",
            "cjkObserved": True,
            "colorSgrObserved": False,
            "isolatedHomes": True,
        }
    except HarnessFailure as error:
        plain_tail = ANSI.sub(b"", bytes(session.output[-1500:])).decode("utf-8", errors="replace")
        event_tail = read_events(session.event_path)[-3:]
        raise HarnessFailure(
            f"{columns}x{rows} stage {stage}: {error}; marks={marks!r}; events={event_tail!r}; output={plain_tail!r}"
        ) from error
    finally:
        session.close()


def run_native_install(columns: int, rows: int, timeout: float) -> dict[str, object]:
    session = PtySession(columns, rows, timeout, "native-install")
    stage = "plugin detail"
    try:
        session.wait_route("pluginDetail")
        session.wait_text("代理实验室")
        session.wait_text("› 安装")
        time.sleep(0.5)
        session.drain()
        session.send(b"\r")
        time.sleep(0.5)
        session.drain()
        if last_route(read_events(session.event_path)) == "pluginDetail":
            session.send(b"\r")
        stage = "target selection"
        session.wait_route("installTargets")
        session.wait_text("Codex")
        session.send(b"\r")
        session.send(b"c")
        stage = "placement"
        session.wait_route("installPlacement")
        session.send(b"\r")
        stage = "review"
        session.wait_route("review")
        session.wait_text("安装")
        session.send(b"\r")
        stage = "result"
        session.wait_event("fake-execute")
        session.wait_for(
            lambda events: last_route(events) in ("result", "pluginDetail"),
            "install result or returned detail",
        )
        if last_route(read_events(session.event_path)) == "result":
            session.send(b"\x1b")
            session.wait_route("pluginDetail")
        session.wait_text("状态已重新检查")
        session.send(b"\x1b")
        session.wait_route("pluginList")
        output, events = exit_ui(session)
        assert_isolation(events, "native-install")
        plain = assert_terminal_output(output)
        for marker in ("选择目标平台", "Codex", "安装"):
            if marker not in plain:
                raise HarnessFailure(f"native install PTY output is missing {marker!r}")
        executions = [event for event in events if event.get("type") == "fake-execute"]
        if len(executions) != 1 or executions[0].get("intentKind") != "pluginWrite":
            raise HarnessFailure(f"unexpected fake execution evidence: {executions}")
        return {
            "scenario": "native-install",
            "initialSize": {"columns": columns, "rows": rows},
            "exitCode": session.process.returncode,
            "cleanup": "natural",
            "ptyBytes": len(output),
            "fixtureAnchor": ["pluginList", "pluginDetail"],
            "inputRouteSequence": ["pluginDetail", "installTargets", "installPlacement", "review", "pluginDetail", "pluginList"],
            "fakeExecution": "pluginWrite",
            "colorSgrObserved": False,
            "isolatedHomes": True,
        }
    except HarnessFailure as error:
        events = read_events(session.event_path)
        raise HarnessFailure(
            f"native-install {columns}x{rows} stage {stage}: {error}; route={last_route(events)}"
        ) from error
    finally:
        session.close()


def run_source_check(columns: int, rows: int, timeout: float) -> dict[str, object]:
    session = PtySession(columns, rows, timeout, "source-check")
    stage = "source detail"
    try:
        session.wait_route("sourceDetail")
        session.wait_text("team-tools")
        session.wait_text("检查来源")
        time.sleep(0.5)
        session.drain()
        session.send(b"r")
        stage = "slow source check"
        session.wait_event("source-probe-start")
        session.wait_text("正在检查")
        session.wait_event("source-probe-failure")
        session.wait_text("检查失败")
        output, events = exit_ui(session)
        assert_isolation(events, "source-check")
        plain = assert_terminal_output(output)
        latest_controller = next(
            (event for event in reversed(events) if event.get("type") == "controller"), None,
        )
        freshness = next(
            (item for item in latest_controller.get("catalogFreshness", [])
             if item.get("sourceId") == "team-tools"), None,
        ) if isinstance(latest_controller, dict) else None
        generation = next(
            (item for item in latest_controller.get("catalogGenerations", [])
             if item.get("sourceId") == "team-tools"), None,
        ) if isinstance(latest_controller, dict) else None
        active_rendered = "当前目录版本" in plain or ("当前 2.4." in plain and "来源可" in plain)
        failed_rendered = "检查失败" in plain
        state_preserved = (
            isinstance(freshness, dict) and freshness.get("state") == "checkFailed"
            and isinstance(generation, dict) and isinstance(generation.get("active"), dict)
        )
        if not active_rendered or not failed_rendered or not state_preserved:
            raise HarnessFailure(
                "source check did not preserve the Active generation with failed freshness; "
                f"rendered={{'active': {active_rendered}, 'failed': {failed_rendered}}}; "
                f"freshness={freshness!r}; generation={generation!r}; "
                f"tail={plain[-1200:]!r}"
            )
        return {
            "scenario": "source-check",
            "initialSize": {"columns": columns, "rows": rows},
            "exitCode": session.process.returncode,
            "cleanup": "natural",
            "ptyBytes": len(output),
            "probe": "slow failure",
            "controllerState": {"freshness": "checkFailed", "activeGeneration": True},
            "ptyStreamMarkers": {"active": True, "checkFailed": True, "sameFrameClaim": False},
            "colorSgrObserved": False,
            "isolatedHomes": True,
        }
    except HarnessFailure as error:
        events = read_events(session.event_path)
        raise HarnessFailure(
            f"source-check {columns}x{rows} stage {stage}: {error}; route={last_route(events)}"
        ) from error
    finally:
        session.close()


def run_config_partial(columns: int, rows: int, timeout: float) -> dict[str, object]:
    session = PtySession(columns, rows, timeout, "config-partial")
    stage = "config fields"
    try:
        session.wait_route("configFields")
        session.wait_text("审查 Profile")
        time.sleep(0.5)
        session.drain()

        session.send(b"\r")
        stage = "edit project object field"
        session.wait_route("configFieldEditor")
        session.wait_text("编辑审查 Profile")
        session.send(b"\r")
        session.wait_route("configObjectPropertyEditor")
        session.wait_text("修改值")
        model_input_offset = len(session.output)
        session.send(b"\r")
        session.wait_for(
            lambda _events: b"gpt-5.6-sol" in ANSI.sub(b"", bytes(session.output[model_input_offset:])),
            "object model input",
        )
        session.send(b"\x15")
        session.send(b"gpt-6-astra")
        session.send(b"\r")
        session.wait_route("configFieldEditor")
        session.wait_text("gpt-6-astra")
        complete_object_offset = len(session.output)
        session.send(b"\x1b[B")
        session.send(b"\x1b[B")
        session.wait_for(
            lambda _events: "› 使用此完整对象".encode() in ANSI.sub(
                b"", bytes(session.output[complete_object_offset:])
            ),
            "focused complete object action",
        )
        session.send(b"\r")
        session.wait_route("configLayer")
        project_target_offset = len(session.output)
        session.send(b"\r")
        session.wait_route("configFields")
        session.wait_for(
            lambda _events: "模型=gpt-6-astra · 推理强度=high".encode() in ANSI.sub(
                b"", bytes(session.output[project_target_offset:])
            ),
            "complete project object draft",
        )

        stage = "edit user field"
        session.send(b"\x1b[B")
        session.send(b"\r")
        session.wait_route("configFieldEditor")
        session.send(b"\r")
        session.wait_route("configLayer")
        session.send(b"\x1b[B")
        session.send(b"\r")
        session.wait_route("configFields")

        stage = "save review"
        save_summary_offset = len(session.output)
        session.send(b"s")
        session.wait_route("configSave")
        summary_markers = (
            '当前项目·审查Profile·未设置→{"model":"gpt-6-astra","reasoningEffort":"high"}',
            "所有项目·启用审查·未设置→开启",
        )
        session.wait_for(
            lambda _events: all(
                marker.encode() in compact_plain(bytes(session.output[save_summary_offset:]))
                for marker in summary_markers
            ),
            "two-scope config save summary with before and complete new values",
        )
        review_offset = len(session.output)
        session.send(b"\r")
        session.wait_route("review")
        session.wait_for(
            lambda _events: all(
                marker.encode() in compact_plain(bytes(session.output[review_offset:]))
                for marker in (
                    "设置变更", "当前项目·审查Profile",
                    "个人默认·启用审查", "开启",
                )
            ),
            "two-field config review",
        )
        confirm_review(session)

        stage = "partial result"
        session.wait_for(
            lambda events: sum(event.get("type") == "config-execute" for event in events) >= 1,
            "first config execution",
        )
        session.wait_route("result")
        session.wait_text("已保存 · 应用失败")
        session.wait_text("保存失败")
        session.wait_text("重试应用")

        stage = "exact apply retry"
        session.send(b"\r")
        session.wait_route("review")
        session.wait_text("重试应用插件设置")
        confirm_review(session)
        session.wait_for(
            lambda events: sum(event.get("type") == "config-execute" for event in events) >= 2,
            "second config execution",
        )
        session.wait_for(
            lambda events: last_route(events) in ("result", "pluginDetail"),
            "retry result",
        )

        output, events = exit_ui(session, dirty=True)
        assert_isolation(events, "config-partial")
        plain = assert_terminal_output(output)
        executions = [event for event in events if event.get("type") == "config-execute"]
        if len(executions) != 2:
            raise HarnessFailure(f"expected two config executions, got {executions!r}")
        first, retry = executions
        first_scopes = first.get("scopes")
        first_updates = first.get("updates")
        if first_scopes != ["project", "user"] or first_updates != [
            {
                "scope": "project",
                "keys": ["profile"],
                "values": {"profile": {"model": "gpt-6-astra", "reasoningEffort": "high"}},
            },
            {"scope": "user", "keys": ["enabled"], "values": {"enabled": True}},
        ]:
            raise HarnessFailure(f"first config batch lost field/scope intent: {first!r}")
        if retry.get("scopes") != ["project"] or retry.get("updates") != [
            {"scope": "project", "keys": [], "values": {}},
        ]:
            raise HarnessFailure(f"retry was not project apply-only: {retry!r}")
        for marker in (
            "审查 Profile", "模型=gpt-6-astra · 推理强度=high", "启用审查",
            "已保存 · 应用失败", "保存失败",
        ):
            if marker not in plain:
                raise HarnessFailure(f"config PTY output is missing {marker!r}")
        return {
            "scenario": "config-partial",
            "initialSize": {"columns": columns, "rows": rows},
            "exitCode": session.process.returncode,
            "cleanup": "natural",
            "ptyBytes": len(output),
            "fixtureAnchor": ["pluginList", "pluginDetail", "configFields"],
            "inputRouteSequence": [
                "configFields", "configFieldEditor", "configObjectPropertyEditor",
                "configObjectPropertyEditor", "configFieldEditor", "configLayer", "configFields",
                "configFieldEditor", "configLayer", "configFields", "configSave",
                "review", "result", "review", "result",
            ],
            "firstBatch": {
                "project": {"profile": {"model": "gpt-6-astra", "reasoningEffort": "high"}},
                "user": {"enabled": True},
            },
            "partialFacts": {"project": "saved/apply-failed", "user": "save-failed"},
            "retry": {"scope": "project", "mode": "apply-only"},
            "colorSgrObserved": False,
            "isolatedHomes": True,
        }
    except HarnessFailure as error:
        events = read_events(session.event_path)
        plain_tail = ANSI.sub(b"", bytes(session.output[-1800:])).decode("utf-8", errors="replace")
        raise HarnessFailure(
            f"config-partial {columns}x{rows} stage {stage}: {error}; "
            f"route={last_route(events)}; events={events[-3:]!r}; output={plain_tail!r}"
        ) from error
    finally:
        session.close()


def run_project_recovery(columns: int, rows: int, timeout: float) -> dict[str, object]:
    session = PtySession(columns, rows, timeout, "project-recovery")
    stage = "project reminder"
    try:
        session.wait_route("home")
        session.wait_text("本项目有 3 个插件尚未就绪")
        session.wait_text("› 稍后处理")
        session.send(b"\r")
        session.wait_text("3 个位置待处理")

        stage = "need attention entry"
        session.send(b"\x1b[B")
        session.send(b"\r")
        session.wait_route("issueList")
        session.wait_text("项目插件")
        session.send(b"\r")
        session.wait_route("projectStatus")
        session.wait_text("2 个可同步 · 1 个受阻")
        session.wait_text("保留 1 个受阻位置")

        stage = "exact subset review"
        session.send(b"c")
        session.wait_route("review")
        session.wait_text("批量同步插件 2 个插件")
        confirm_review(session)
        session.wait_for(
            lambda events: sum(event.get("type") == "project-execute" for event in events) >= 1,
            "first project execution",
        )
        session.wait_route("result")
        session.wait_text("仅重试失败目标")

        stage = "exact failed target retry"
        session.send(b"\r")
        session.wait_route("review")
        session.wait_text("批量同步插件 1 个插件")
        confirm_review(session)
        session.wait_for(
            lambda events: sum(event.get("type") == "project-execute" for event in events) >= 2,
            "second project execution",
        )
        session.wait_for(
            lambda events: last_route(events) in ("result", "pluginDetail"),
            "successful project retry result",
        )
        session.wait_text("状态已重新检查")

        output, events = exit_ui(session)
        assert_isolation(events, "project-recovery")
        plain = assert_terminal_output(output)
        executions = [event for event in events if event.get("type") == "project-execute"]
        expected_first = [
            {"pluginId": "official/agent-lab", "platform": "claude", "scope": "project"},
            {"pluginId": "official/content-toolkit", "platform": "claude", "scope": "project"},
        ]
        expected_retry = [
            {"pluginId": "official/content-toolkit", "platform": "claude", "scope": "project"},
        ]
        if len(executions) != 2 or executions[0].get("targets") != expected_first:
            raise HarnessFailure(f"project subset execution was not exact: {executions!r}")
        if executions[1].get("targets") != expected_retry:
            raise HarnessFailure(f"project retry was not limited to the failed target: {executions[1]!r}")
        for marker in (
            "› 稍后处理", "2 个可同步 · 1 个受阻", "仅重试失败目标", "状态已重新检查",
        ):
            if marker not in plain:
                raise HarnessFailure(f"project recovery PTY output is missing {marker!r}")
        return {
            "scenario": "project-recovery",
            "initialSize": {"columns": columns, "rows": rows},
            "exitCode": session.process.returncode,
            "cleanup": "natural",
            "ptyBytes": len(output),
            "fixtureAnchor": ["projectStatusLoad", "home"],
            "inputRouteSequence": [
                "reminderLater", "home", "issueList", "projectStatus", "review", "result", "review", "pluginDetail",
            ],
            "firstExecution": ["official/agent-lab", "official/content-toolkit"],
            "preservedBlocked": ["official/source-blocked"],
            "retryExecution": ["official/content-toolkit"],
            "colorSgrObserved": False,
            "isolatedHomes": True,
        }
    except HarnessFailure as error:
        events = read_events(session.event_path)
        plain_tail = ANSI.sub(b"", bytes(session.output[-1800:])).decode("utf-8", errors="replace")
        raise HarnessFailure(
            f"project-recovery {columns}x{rows} stage {stage}: {error}; "
            f"route={last_route(events)}; events={events[-3:]!r}; output={plain_tail!r}"
        ) from error
    finally:
        session.close()


def run_portable_recheck(columns: int, rows: int, timeout: float) -> dict[str, object]:
    session = PtySession(columns, rows, timeout, "portable-recheck")
    try:
        session.wait_route("result")
        session.wait_text("结果未知")
        session.wait_text("› 重新检查结果")
        time.sleep(0.5)
        session.drain()
        session.send(b"\r")
        session.wait_event("portable-recheck")
        session.wait_text("只读检查进行中")
        session.wait_text("通用 Skills 已安装")
        output, events = exit_ui(session)
        assert_isolation(events, "portable-recheck")
        plain = assert_terminal_output(output)
        executes = [event for event in events if event.get("type") == "portable-execute"]
        rechecks = [event for event in events if event.get("type") == "portable-recheck"]
        if len(executes) != 1 or executes[0].get("selectedSkills") != ["review-skill"]:
            raise HarnessFailure(f"portable fixture selection was not exact: {executes!r}")
        if len(rechecks) != 1 or rechecks[0].get("readOnly") is not True:
            raise HarnessFailure(f"portable recheck was not read-only: {rechecks!r}")
        return {
            "scenario": "portable-recheck", "initialSize": {"columns": columns, "rows": rows},
            "exitCode": session.process.returncode, "cleanup": "natural", "ptyBytes": len(output),
            "fixtureAnchor": ["pluginDetail", "portableSelection(review-skill)", "unknownResult"],
            "inputRouteSequence": ["result", "readOnlyRecheck", "result"],
            "selectedSkills": ["review-skill"], "writeExecutions": 1, "readOnlyRechecks": 1,
            "colorSgrObserved": False, "isolatedHomes": True,
        }
    finally:
        session.close()


def run_portable_flow(columns: int, rows: int, timeout: float) -> dict[str, object]:
    session = PtySession(columns, rows, timeout, "portable-flow")
    try:
        session.wait_route("pluginDetail")
        session.wait_text("› 安装")
        time.sleep(0.5)
        session.drain()
        session.send(b"\r")
        session.wait_route("installTargets")
        session.wait_text("通用 Agent Skills")
        session.send(b"\x1b[B")
        session.send(b"\x1b[B")
        session.wait_text("› 通用 Agent Skills →")
        session.send(b"\r")
        session.wait_route("portablePreparing")
        session.wait_text("正在准备可安装的 Skills")
        session.wait_route("portableSkillSelect")
        session.wait_text("author-skill")
        time.sleep(0.5)
        session.drain()
        session.send(b"\x1b[B")
        session.wait_text("› [x] review-skill")
        session.send(b"\x1b[A")
        time.sleep(0.3)
        session.drain()
        session.send(b"\r")
        session.wait_for(
            lambda events: any(
                event.get("type") == "controller"
                and isinstance(event.get("portableDraft"), dict)
                and event["portableDraft"].get("selected") == ["review-skill"]
                for event in events[-3:]
            ),
            "exact portable Skill selection",
        )
        session.send(b"c")
        session.wait_route("portableAgentMode")
        session.wait_text("指定 Agent")
        time.sleep(0.3)
        session.drain()
        session.send(b"\x1b[B")
        session.send(b"\r")
        session.wait_route("portableAgentInput")
        session.send(b"codex")
        session.send(b"\r")
        session.wait_route("portableScope")
        session.wait_text("所有项目")
        time.sleep(0.3)
        session.drain()
        session.send(b"\x1b[B")
        session.send(b"\r")
        session.send(b"\x1b[B")
        session.send(b"\r")
        session.wait_route("review")
        time.sleep(0.5)
        session.drain()
        session.send(b"\x1b[B")
        session.send(b"\r")
        session.wait_route("portableBlocker")
        session.wait_text("重新检查")
        session.send(b"\r")
        session.wait_route("portableSkillSelect")
        events = read_events(session.event_path)
        latest = next(event for event in reversed(events) if event.get("type") == "controller")
        draft = latest.get("portableDraft")
        if not isinstance(draft, dict) or draft.get("selected") != ["review-skill"]:
            raise HarnessFailure(f"portable recheck changed the exact selection: {draft!r}")
        if draft.get("candidates") != ["author-skill", "review-skill", "new-skill"]:
            raise HarnessFailure(f"portable recheck candidate set is unexpected: {draft!r}")
        if draft.get("agentMode") != "explicit" or draft.get("requestedAgents") != ["codex"]:
            raise HarnessFailure(f"portable recheck changed the explicit Agent selection: {draft!r}")
        if draft.get("scope") != "user":
            raise HarnessFailure(f"portable recheck changed the selected scope: {draft!r}")

        time.sleep(0.5)
        session.drain()
        session.send(b"\x1b[B")
        session.send(b"\x1b[B")
        session.wait_text("new-skill")
        time.sleep(0.5)
        session.drain()
        session.send(b"c")
        session.wait_route("portableAgentMode")
        time.sleep(0.3)
        session.drain()
        session.send(b"\x1b[B")
        session.send(b"\r")
        session.wait_route("portableAgentInput")
        session.send(b"\x15")
        session.send(b"codex")
        session.send(b"\r")
        session.wait_route("portableScope")
        time.sleep(0.3)
        session.drain()
        session.send(b"\x1b[B")
        session.send(b"\r")
        session.send(b"\x1b[B")
        session.send(b"\r")
        session.wait_route("review")
        time.sleep(0.5)
        session.drain()
        confirmation_offset = len(session.output)
        session.send(b"\r")
        session.wait_for(
            lambda _events: "确认本次影响".encode() in ANSI.sub(b"", bytes(session.output[confirmation_offset:])),
            "new user-scope confirmation",
        )
        session.send(b"\x1b[B")
        session.wait_for(
            lambda _events: "› 确认并执行".encode() in ANSI.sub(b"", bytes(session.output[confirmation_offset:])),
            "focused portable confirmation",
        )
        session.send(b"\r")
        session.wait_route("result")
        session.wait_text("结果未知")
        session.send(b"\r")
        session.wait_event("portable-recheck")
        session.wait_text("只读检查进行中")
        session.wait_text("通用 Skills 已安装")
        output, events = exit_ui(session)
        assert_isolation(events, "portable-flow")
        assert_terminal_output(output)
        executes = [event for event in events if event.get("type") == "portable-execute"]
        rechecks = [event for event in events if event.get("type") == "portable-recheck"]
        if len(executes) != 1 or executes[0].get("selectedSkills") != ["review-skill"]:
            raise HarnessFailure(f"portable flow write was not exact: {executes!r}")
        execution = executes[0]
        if execution.get("agentMode") != "explicit" or execution.get("requestedAgents") != ["codex"]:
            raise HarnessFailure(f"portable flow execution used the wrong Agent selection: {execution!r}")
        if execution.get("scope") != "user":
            raise HarnessFailure(f"portable flow execution used the wrong scope: {execution!r}")
        if len(rechecks) != 1 or rechecks[0].get("readOnly") is not True:
            raise HarnessFailure(f"portable flow read-only recheck is invalid: {rechecks!r}")
        return {
            "scenario": "portable-flow", "initialSize": {"columns": columns, "rows": rows},
            "exitCode": session.process.returncode, "cleanup": "natural", "ptyBytes": len(output),
            "fixtureAnchor": ["pluginDetail"],
            "inputRouteSequence": ["pluginDetail", "installTargets", "portablePreparing", "portableSkillSelect", "portableAgentMode", "portableAgentInput", "portableScope", "portableBlocker", "portableSkillSelect", "review", "result", "readOnlyRecheck", "result"],
            "selectedSkills": execution["selectedSkills"],
            "agentMode": execution["agentMode"],
            "requestedAgents": execution["requestedAgents"], "scope": execution["scope"],
            "newCandidateAutoSelected": False, "writeExecutions": 1, "readOnlyRechecks": 1,
            "colorSgrObserved": False, "isolatedHomes": True,
        }
    finally:
        session.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=15.0, help="timeout for each PTY session")
    parser.add_argument(
        "--scenario", choices=("all", "browse", "native-install", "source-check", "config-partial", "project-recovery", "portable-recheck", "portable-flow"), default="all",
        help="run one scenario at both terminal sizes",
    )
    args = parser.parse_args()
    if os.name != "posix":
        raise HarnessFailure("this acceptance harness requires POSIX pty support")
    if not FIXTURE.is_file() or not DIST_ENTRY.is_file():
        raise HarnessFailure("compiled CLI dist is missing; run the repository build before this harness")

    sessions = []
    if args.scenario in ("all", "browse"):
        sessions.extend([
            run_browse(80, 24, args.timeout, (60, 18)),
            run_browse(60, 18, args.timeout, None),
        ])
    if args.scenario in ("all", "native-install"):
        sessions.extend([
            run_native_install(80, 24, args.timeout),
            run_native_install(60, 18, args.timeout),
        ])
    if args.scenario in ("all", "source-check"):
        sessions.extend([
            run_source_check(80, 24, args.timeout),
            run_source_check(60, 18, args.timeout),
        ])
    if args.scenario in ("all", "config-partial"):
        sessions.extend([
            run_config_partial(80, 24, args.timeout),
            run_config_partial(60, 18, args.timeout),
        ])
    if args.scenario in ("all", "project-recovery"):
        sessions.extend([
            run_project_recovery(80, 24, args.timeout),
            run_project_recovery(60, 18, args.timeout),
        ])
    if args.scenario in ("all", "portable-recheck"):
        sessions.extend([
            run_portable_recheck(80, 24, args.timeout),
            run_portable_recheck(60, 18, args.timeout),
        ])
    if args.scenario in ("all", "portable-flow"):
        sessions.extend([
            run_portable_flow(80, 24, args.timeout),
            run_portable_flow(60, 18, args.timeout),
        ])
    report = {
        "schemaVersion": 1,
        "kind": "aw-tui-posix-pty",
        "sessions": sessions,
        "evidenceBoundary": {
            "layout": "PTY output from production Ink mount",
            "businessState": "TuiController JSONL side channel",
            "thirdPartyNativeCompatibility": False,
        },
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except HarnessFailure as error:
        print(f"tui-pty: {error}", file=sys.stderr)
        raise SystemExit(1)
