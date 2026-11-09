"""Metadata-only local Zotero archive bridge. Never emit API credentials."""
import json
import re
import sys
import urllib.error
import urllib.request
import zotero_local_auth as auth


def archive_item(data):
    if not isinstance(data, dict) or not isinstance(data.get('url'), str) or not data['url']:
        return {'ok': False, 'reason': 'Article URL is required.'}
    collection = data.get('collectionKey')
    if collection is not None and (not isinstance(collection, str) or not re.fullmatch(r'[A-Z0-9]{8}', collection)):
        return {'ok': False, 'reason': 'Invalid Zotero collection key.'}
    try:
        sid = auth.server_id()
        key = auth.load_key(sid)
    except Exception:
        return {'ok': False, 'reason': 'Zotero 10+ local API or Windows credential storage is unavailable.'}
    if not key:
        return {'ok': False, 'skipped': True, 'reason': 'Zotero local API authorization is required. Run the shared authorization helper setup and let the user approve in Zotero.'}
    item = {'itemType': 'journalArticle', 'title': data.get('title') or data['url'], 'url': data['url']}
    if data.get('pdfPath'):
        item['extra'] = 'Local PDF: ' + data['pdfPath']
    if collection:
        item['collections'] = [collection]
    request = urllib.request.Request(auth.BASE + 'users/0/items',
        data=json.dumps([item], ensure_ascii=False).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Zotero-Server-ID': sid, 'Zotero-API-Key': key},
        method='POST')
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
            status = response.status
    except urllib.error.HTTPError as err:
        if err.code == 401:
            try:
                auth.forget_key(sid)
            except OSError:
                return {'ok': False, 'status': 401, 'reason': 'Zotero rejected the local authorization and its cached credential could not be removed.'}
            return {'ok': False, 'status': 401, 'reason': 'Zotero local authorization was rejected. Run the shared helper setup and let the user approve again.'}
        return {'ok': False, 'status': err.code, 'reason': 'Zotero local API rejected the request. Check Zotero and the target collection.'}
    except Exception:
        return {'ok': False, 'reason': 'Zotero local API request failed; check the library for an item before retrying.'}
    if not isinstance(result, dict) or result.get('failed') or not result.get('success', {}).get('0'):
        return {'ok': False, 'status': status, 'reason': 'Zotero did not confirm item creation; check the library before retrying.'}
    item_key = result['success']['0']
    return {'ok': True, 'status': status, 'location': auth.BASE + 'users/0/items/' + item_key,
            'raw': json.dumps(result, ensure_ascii=False)}


def main():
    try:
        data = json.load(sys.stdin)
        result = archive_item(data)
    except Exception:
        result = {'ok': False, 'reason': 'Invalid archive request.'}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
