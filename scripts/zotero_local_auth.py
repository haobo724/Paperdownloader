"""Zotero 10+ local-write authorization with Windows Credential Manager.

Import get_write_headers() to authorize/reuse a key, and call forget_key() on
HTTP 401 before obtaining fresh headers. Never print the returned headers.
Run `python zotero_local_auth.py setup` once; `verify` uses an empty item batch.
"""
import ctypes
from ctypes import wintypes
import json
import sys
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:23119/api/'
APP = 'Codex Zotero local API'
TARGET_PREFIX = 'Codex/ZoteroLocalAPI/'
CRED_TYPE_GENERIC = 1
CRED_PERSIST_LOCAL_MACHINE = 2
ERROR_NOT_FOUND = 1168

class FILETIME(ctypes.Structure):
    _fields_ = [('dwLowDateTime', wintypes.DWORD), ('dwHighDateTime', wintypes.DWORD)]

class CREDENTIALW(ctypes.Structure):
    _fields_ = [('Flags', wintypes.DWORD), ('Type', wintypes.DWORD), ('TargetName', wintypes.LPWSTR),
                ('Comment', wintypes.LPWSTR), ('LastWritten', FILETIME), ('CredentialBlobSize', wintypes.DWORD),
                ('CredentialBlob', ctypes.POINTER(ctypes.c_ubyte)), ('Persist', wintypes.DWORD),
                ('AttributeCount', wintypes.DWORD), ('Attributes', ctypes.c_void_p),
                ('TargetAlias', wintypes.LPWSTR), ('UserName', wintypes.LPWSTR)]

if sys.platform != 'win32':
    raise SystemExit('This optional Zotero credential helper requires Windows.')

advapi = ctypes.WinDLL('Advapi32.dll', use_last_error=True)
advapi.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(CREDENTIALW))]
advapi.CredReadW.restype = wintypes.BOOL
advapi.CredWriteW.argtypes = [ctypes.POINTER(CREDENTIALW), wintypes.DWORD]
advapi.CredWriteW.restype = wintypes.BOOL
advapi.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
advapi.CredDeleteW.restype = wintypes.BOOL
advapi.CredFree.argtypes = [ctypes.c_void_p]

def server_id():
    with urllib.request.urlopen(BASE, timeout=10) as response:
        value = response.headers.get('Zotero-Server-ID')
    if not value:
        raise RuntimeError('Zotero 10+ local API server ID is unavailable')
    return value

def _target(sid):
    return TARGET_PREFIX + sid

def load_key(sid):
    item = ctypes.POINTER(CREDENTIALW)()
    if not advapi.CredReadW(_target(sid), CRED_TYPE_GENERIC, 0, ctypes.byref(item)):
        if ctypes.get_last_error() == ERROR_NOT_FOUND:
            return None
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(item.contents.CredentialBlob, item.contents.CredentialBlobSize).decode('utf-8')
    finally:
        advapi.CredFree(item)

def _save_key(sid, key):
    raw = key.encode('utf-8')
    buf = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
    item = CREDENTIALW(Type=CRED_TYPE_GENERIC, TargetName=_target(sid), CredentialBlobSize=len(raw),
                       CredentialBlob=ctypes.cast(buf, ctypes.POINTER(ctypes.c_ubyte)),
                       Persist=CRED_PERSIST_LOCAL_MACHINE, UserName='Codex Zotero local API')
    if not advapi.CredWriteW(ctypes.byref(item), 0):
        raise ctypes.WinError(ctypes.get_last_error())

def forget_key(sid):
    if not advapi.CredDeleteW(_target(sid), CRED_TYPE_GENERIC, 0):
        if ctypes.get_last_error() != ERROR_NOT_FOUND:
            raise ctypes.WinError(ctypes.get_last_error())

def get_write_headers():
    sid = server_id()
    key = load_key(sid)
    if key is None:
        data = json.dumps({'appName': APP}).encode('utf-8')
        request = urllib.request.Request(BASE + 'local/authorize', data=data,
            headers={'Content-Type': 'application/json', 'Zotero-Server-ID': sid}, method='POST')
        with urllib.request.urlopen(request, timeout=300) as response:
            grant = json.load(response)
        key = grant['key']
        if grant.get('remember'):
            _save_key(sid, key)
        else:
            print('Zotero granted a single-use key; it was not saved.', file=sys.stderr)
    return {'Zotero-Server-ID': sid, 'Zotero-API-Key': key}

def verify_key(headers):
    # A zero-item batch creates/changes no items, but still requires write auth.
    request = urllib.request.Request(BASE + 'users/0/items', data=b'[]',
        headers={**headers, 'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status in (200, 204)
    except urllib.error.HTTPError as err:
        if err.code == 400:  # Some versions reject an empty batch after auth.
            return True
        if err.code == 401:
            return False
        raise

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if cmd == 'status':
        print('Stored reusable credential:', 'yes' if load_key(server_id()) else 'no')
    elif cmd in ('setup', 'verify'):
        headers = get_write_headers() if cmd == 'setup' else {'Zotero-Server-ID': server_id()}
        if cmd == 'verify':
            headers['Zotero-API-Key'] = load_key(headers['Zotero-Server-ID'])
            if headers['Zotero-API-Key'] is None:
                raise SystemExit('No stored credential')
        if not verify_key(headers):
            forget_key(headers['Zotero-Server-ID'])
            raise SystemExit('Stored credential invalid; rerun setup')
        print('Zotero credential validated; reusable credential stored:', bool(load_key(headers['Zotero-Server-ID'])))
    else:
        raise SystemExit('Usage: zotero_local_auth.py [status|setup|verify]')

if __name__ == '__main__':
    main()
