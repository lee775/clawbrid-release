"""
Claude CLI 로그인을 가상 터미널(ConPTY)에서 실행해, 브라우저를 열지 않고 로그인 링크만 받아 온다.
claude-login.js 가 실행한다. 표준출력에는 한 줄짜리 JSON 만 쓰고, 토큰은 --out 파일에만 저장한다.

  --mode token : claude setup-token (1년짜리 토큰 → --out 파일)
  --mode login : claude auth login --claudeai (PC 로그인 갱신)

  {"event": "url", "url": "..."}       로그인 링크 (승인하면 코드가 나온다)
  (표준입력 한 줄)                      그 코드
  {"event": "done", "length": N}       완료 (token 모드면 토큰 길이)
  {"event": "error", "message": "..."}
"""
import argparse
import json
import os
import re
import shutil
import sys
import threading
import time

from winpty import PtyProcess

ANSI = re.compile(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]')
URL = re.compile(r'https://\S+/oauth/authorize\?\S+')
TOKEN = re.compile(r'sk-ant-oat01-[A-Za-z0-9_\-]+')
LOGGED_IN = re.compile(r'Login successful')
FAIL = re.compile(r'(Authentication failed[^\n]*|Invalid authorization code[^\n]*|OAuth error[^\n]*|Error:[^\n]*)')

# 브릿지 · 이 PC 의 Claude 세션 환경이 섞이면 CLI 가 그 세션의 계정으로 동작한다
STRIP_ENV = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID',
             'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_ENTRYPOINT',
             'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_EFFORT', 'CLAUDE_PLUGIN_DATA',
             'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR']


def emit(event, **kw):
    sys.stdout.write(json.dumps({'event': event, **kw}, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', choices=['token', 'login'], default='token')
    ap.add_argument('--out')
    ap.add_argument('--timeout', type=int, default=600)
    args = ap.parse_args()
    if args.mode == 'token' and not args.out:
        emit('error', message='--out 이 필요합니다')
        return 1

    exe = shutil.which('claude')
    if not exe:
        emit('error', message='claude CLI를 찾지 못했습니다')
        return 1

    env = {k: v for k, v in os.environ.items() if k not in STRIP_ENV}
    # CLI 는 BROWSER 에 적힌 프로그램으로 링크를 연다 — 아무것도 열지 않는 where.exe 로 막는다
    env['BROWSER'] = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'where.exe')
    argv = [exe, 'setup-token'] if args.mode == 'token' else [exe, 'auth', 'login', '--claudeai']
    proc = PtyProcess.spawn(argv, env=env, dimensions=(40, 1000))

    screen = {'text': ''}
    lock = threading.Lock()

    def pump():
        while True:
            try:
                chunk = proc.read(65536)
            except Exception:
                return
            if not chunk:
                if not proc.isalive():
                    return
                time.sleep(0.05)
                continue
            with lock:
                screen['text'] = (screen['text'] + ANSI.sub('', chunk))[-200000:]

    threading.Thread(target=pump, daemon=True).start()

    def wait_for(pattern, seconds):
        end = time.time() + seconds
        while time.time() < end:
            with lock:
                m = pattern.search(screen['text'])
            if m:
                return m
            if not proc.isalive():
                return None
            time.sleep(0.2)
        return None

    try:
        url = wait_for(URL, 60)
        if not url:
            emit('error', message='로그인 링크가 나오지 않았습니다')
            return 1
        emit('url', url=url.group(0))
        with lock:
            screen['text'] = ''  # 코드 입력 뒤 나오는 내용만 본다

        code = sys.stdin.readline().strip()
        if not code:
            emit('error', message='코드를 받지 못했습니다')
            return 1
        proc.write(code)
        time.sleep(0.3)
        proc.write('\r')

        end = time.time() + args.timeout
        while time.time() < end:
            alive = proc.isalive()
            if not alive:
                time.sleep(0.5)  # 끝나기 직전 출력이 마저 들어오게
            with lock:
                text = screen['text']
            if args.mode == 'login' and LOGGED_IN.search(text):
                emit('done', length=0)
                return 0
            tok = TOKEN.search(text) if args.mode == 'token' else None
            if tok:
                tmp = args.out + '.tmp'
                with open(tmp, 'w', encoding='utf-8', newline='') as f:
                    f.write(tok.group(0))
                os.replace(tmp, args.out)
                emit('done', length=len(tok.group(0)))
                return 0
            fail = FAIL.search(text)
            if fail:
                emit('error', message=fail.group(1).strip()[:300])
                return 1
            if not alive:
                emit('error', message='로그인을 마치기 전에 claude 가 끝났습니다')
                return 1
            time.sleep(0.2)
        emit('error', message='시간 초과')
        return 1
    finally:
        try:
            proc.terminate(force=True)
        except Exception:
            pass


if __name__ == '__main__':
    sys.exit(main())
