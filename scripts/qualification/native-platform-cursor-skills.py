#!/usr/bin/env python3
"""Observe the fixed Cursor CLI slash picker through its workspaceOpen route."""

import argparse
import errno
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import pty
import re
import select
import shlex
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import threading
import time


VERSION = '2026.11.05-86047df'
SKILLS = ('aw-ordinary-qual', 'aw-manual-qual')
ANSI = re.compile(rb'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[()][0-2A-Z]|[=>])')


class StartupStub(http.server.BaseHTTPRequestHandler):
    # Return only model inventory and empty startup metadata. There is no
    # provider behind this endpoint and it refuses agent turns.
    protocol_version = 'HTTP/1.1'

    def do_CONNECT(self):
        port = self.server.agent_port
        if port is None or self.path != f'127.0.0.1:{port}':
            self.send_error(403)
            return
        # Fixed Cursor's HTTP/2 transport uses the proxy even for loopback.
        # Forward only to this fixture's currently registered local RPC port.
        with socket.create_connection(('127.0.0.1', port), timeout=5) as upstream:
            self.send_response(200, 'Connection Established')
            self.end_headers()
            while connections := select.select([self.connection, upstream], [], [], 10)[0]:
                for connection in connections:
                    chunk = connection.recv(65536)
                    if not chunk:
                        return
                    (upstream if connection is self.connection else self.connection).sendall(chunk)

    def do_POST(self):
        method = self.path.rsplit('/', 1)[-1]
        startup = self.path.startswith(('/aiserver.v1.DashboardService/', '/aiserver.v1.ServerConfigService/'))
        models = method in ('GetDefaultModelForCli', 'GetUsableModels', 'AvailableModels')
        if not (startup or models) or self.headers.get('Content-Type') != 'application/proto':
            self.server.refusals.add(method)
            self.send_error(501)
            return
        if self.headers.get('Transfer-Encoding') == 'chunked':
            while True:
                size = int(self.rfile.readline(128).strip(), 16)
                if size == 0:
                    self.rfile.readline(128)
                    break
                if size > 1024 * 1024:
                    self.send_error(413)
                    return
                self.rfile.read(size + 2)
        else:
            size = int(self.headers.get('Content-Length', '0'))
            if size > 1024 * 1024:
                self.send_error(413)
                return
            self.rfile.read(size)
        model = b'\x0a\x10aw-fixture-model\x22\x10AW Fixture Model'
        response = b'\x0a' + bytes([len(model)]) + model if method in ('GetDefaultModelForCli', 'GetUsableModels') else b''
        self.send_response(200)
        self.send_header('Content-Type', 'application/proto')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, *_args):
        pass


def isolated_env(root):
    env = {'PATH': '/usr/bin:/bin', 'TERM': 'xterm-256color', 'NO_OPEN_BROWSER': '1', 'CURSOR_INVOKED_AS': 'cursor-agent',
           'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_TERMINAL_PROMPT': '0'}
    for variable in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
        env[variable] = 'http://127.0.0.1:1'
    env.update(NO_PROXY='127.0.0.1,localhost', no_proxy='127.0.0.1,localhost')
    marker = os.environ.get('AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER')
    if marker:
        env['AW_NATIVE_QUALIFICATION_PUBLIC_AW_MARKER'] = marker
    for variable, relative in {'HOME': 'home', 'TMPDIR': 'tmp', 'AW_HOME': 'aw', 'XDG_CACHE_HOME': 'cache',
                               'XDG_DATA_HOME': 'data', 'XDG_STATE_HOME': 'state'}.items():
        directory = root / relative
        directory.mkdir(parents=True, exist_ok=True)
        env[variable] = str(directory)
    return env


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding='utf-8')


def publish(package, revision):
    write_json(package / '.cursor-plugin/plugin.json', {'name': 'aw-policy-qual', 'version': f'1.0.{revision}'})
    for name in SKILLS:
        skill = package / 'skills' / name / 'SKILL.md'
        skill.parent.mkdir(parents=True, exist_ok=True)
        flag = 'disable-model-invocation: true\n' if name == SKILLS[1] else ''
        marker = '\nAW-CURSOR-FIXTURE-MANUAL-BODY\n' if name == SKILLS[1] else ''
        skill.write_text(f'---\nname: {name}\ndescription: {name} revision {revision}\n{flag}---\n# {name}\n{marker}',
                         encoding='utf-8')


def stop_child(child):
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait(timeout=2)


def observe_menu(launcher, endpoint, cwd, env, revision, present):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 140, 0, 0))
    try:
        child = subprocess.Popen([*launcher, '--endpoint', endpoint, '--trust', '--disable-auto-update', '--debug', '--stderr'], cwd=cwd,
                                 env={**env, 'AGENT_CLI_E2E': 'true'}, stdin=slave, stdout=slave, stderr=slave,
                                 start_new_session=True)
    finally:
        os.close(slave)
    before = b''
    try:
        await_output(master, b'', b'\x1b]0;Cursor Agent\x07', 12, raw=True)
        os.write(master, b'/aw-')
        before = await_output(master, b'', b'enter to attach', 8)
        for skill in SKILLS:
            actual = re.search(rb'/' + skill.encode() + rb' +([^\r\n]+)', before)
            if present and (not actual or actual[1].strip() != f'{skill} revision {revision} (skill)'.encode()):
                raise ValueError(f'Cursor did not list {skill} from revision {revision}')
            if not present and actual:
                raise ValueError(f'Cursor unexpectedly listed {skill}')
    finally:
        try:
            os.write(master, b'\x03\x03')
            child.wait(timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            pass
        finally:
            stop_child(child)
            os.close(master)
    return {'ordinaryVisible': present, 'manualVisible': present,
            **({'descriptionRevision': revision} if present else {})}


def await_output(fd, output, token, timeout, raw=False):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and len(output) < 512 * 1024:
        if not select.select([fd], [], [], min(0.25, max(0, deadline - time.monotonic())))[0]:
            continue
        try:
            chunk = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not chunk:
            break
        output += chunk
        plain = ANSI.sub(b'', output)
        if token in (output if raw else plain):
            return plain
    raise ValueError(f'Cursor terminal never displayed {token.decode()}')


def observe_policy(launcher, node, server, endpoint, cwd, env, explicit):
    result = cwd / ('explicit-policy.json' if explicit else 'ordinary-policy.json')
    fixture = Path(__file__).with_name('native-platform-cursor-skill-context.mjs')
    stub = subprocess.Popen([node, str(fixture), str(result)], cwd=cwd, env=env,
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, start_new_session=True)
    try:
        port = int(await_output(stub.stdout.fileno(), b'', b'\n', 5))
        server.agent_port = port
        request_env = {**env, 'AGENT_CLI_E2E': 'true'}
        for variable in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
            request_env[variable] = endpoint
        prompt = f'/{SKILLS[1]}' if explicit else 'Read-only fixture request for native Skill metadata.'
        child = subprocess.Popen([*launcher, '--endpoint', endpoint, '--agent-endpoint', f'http://127.0.0.1:{port}',
                                  '--trust', '--disable-auto-update', '--print', '--output-format', 'json', prompt],
                                 cwd=cwd, env=request_env,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                 start_new_session=True)
        try:
            deadline = time.monotonic() + 12
            while not result.exists() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            actual = json.loads(result.read_text(encoding='utf-8'))
            expected = [{'name': name, 'source': 'plugin', 'disableModelInvocation': name == SKILLS[1]}
                        for name in sorted(SKILLS)]
            if actual != {'policy': expected, 'explicitBody': explicit}:
                raise ValueError('Cursor sent unexpected plugin Skill invocation policy')
            return actual
        finally:
            stop_child(child)
    finally:
        server.agent_port = None
        stop_child(stub)


def observe_scope(launcher, node, server, endpoint, root, scope):
    env = isolated_env(root)
    project = root / 'project'
    neutral = root / 'neutral'
    for cwd in (project, neutral):
        # This loose control keeps the menu observable even after removal.
        control = cwd / '.cursor/skills/aw-control-qual/SKILL.md'
        control.parent.mkdir(parents=True)
        control.write_text('---\nname: aw-control-qual\ndescription: local menu control\n---\n# Control\n', encoding='utf-8')
    scope_directory = (Path(env['HOME']) if scope == 'user' else project) / '.cursor'
    package = scope_directory / 'aw-plugins/aw-policy-qual'
    hook = scope_directory / 'hooks.json'
    command = f'printf %s {shlex.quote(json.dumps({"pluginPaths": [str(package)]}))}'
    write_json(hook, {'version': 1, 'hooks': {'workspaceOpen': [{'command': command}]}})
    scopes = {}
    for revision in (1, 2):
        publish(package, revision)
        scopes['install' if revision == 1 else 'refresh'] = {
            'project': observe_menu(launcher, endpoint, project, env, revision, True),
            'neutral': observe_menu(launcher, endpoint, neutral, env, revision, scope == 'user'),
        }
        if revision == 1:
            scopes['wirePolicy'] = observe_policy(launcher, node, server, endpoint, project, env, explicit=False)
            scopes['explicitInvocation'] = observe_policy(launcher, node, server, endpoint, project, env, explicit=True)
    hook.unlink()
    scopes['remove'] = {name: observe_menu(launcher, endpoint, cwd, env, 2, False)
                        for name, cwd in (('project', project), ('neutral', neutral))}
    return {'scope': scope, 'location': '~/.cursor/hooks.json' if scope == 'user' else '<PROJECT>/.cursor/hooks.json',
            'observations': scopes}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--executable', required=True, type=Path)
    parser.add_argument('--node', required=True, type=Path, help='Node for the loopback-only HTTP/2 stub')
    parser.add_argument('--entry', type=Path, help='index.js for the official Node launcher')
    options = parser.parse_args()
    node = str(options.node.resolve(strict=True))
    entries = [options.executable.resolve(strict=True)]
    if options.entry:
        entries.append(options.entry.resolve(strict=True))
    launcher = [str(item) for item in entries]
    # Cursor uses Unix-domain sockets below this root. Keep the prefix short
    # even when the machine's default temporary directory is deeply nested.
    with tempfile.TemporaryDirectory(prefix='aw-cu-', dir='/tmp') as work:
        root = Path(work).resolve()
        result = subprocess.run([*launcher, '--version'], cwd=root, env=isolated_env(root),
                                capture_output=True, text=True, check=True, timeout=10)
        if result.stdout.strip() != VERSION:
            raise ValueError('unexpected Cursor CLI build')
        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), StartupStub) as server:
            server.refusals = set()
            server.agent_port = None
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            endpoint = f'http://127.0.0.1:{server.server_port}'
            try:
                scopes = [observe_scope(launcher, node, server, endpoint, root / scope, scope) for scope in ('user', 'project')]
            finally:
                server.shutdown()
                thread.join(timeout=2)
    print(json.dumps({'status': 'observed', 'product': 'cli', 'version': VERSION, 'platform': platform.system(),
                      'arch': platform.machine(), 'scopes': scopes, 'refusedRpcMethods': sorted(server.refusals),
                      'entrySha256': {item.name: hashlib.sha256(item.read_bytes()).hexdigest() for item in entries},
                      'boundary': {'nativeWorkspaceOpen': True, 'publicAw': False, 'workspaceTrust': 'isolated fixture only',
                                   'authentication': 'fixed release test mode and loopback startup stub',
                                   'providerCalls': 0, 'nativeWirePolicy': 'observed',
                                   'automaticInvocation': 'documented native policy, remote enforcement unverified'}}))


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda _signum, _frame: os.kill(os.getpid(), signal.SIGINT))
    main()
