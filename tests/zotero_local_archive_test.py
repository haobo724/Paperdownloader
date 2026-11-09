import io, json, pathlib, sys, unittest
from unittest import mock
from urllib.error import HTTPError

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import zotero_local_archive as bridge


class Response:
    status = 200
    def __init__(self, result): self.result = result
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def read(self, *_): return json.dumps(self.result).encode('utf-8')


class LocalArchiveTests(unittest.TestCase):
    def setUp(self):
        self.sid = mock.patch.object(bridge.auth, 'server_id', return_value='test-server').start()
        self.key = mock.patch.object(bridge.auth, 'load_key', return_value='fake-secret').start()
        self.addCleanup(mock.patch.stopall)

    def test_creates_in_explicit_collection_and_keeps_key_out_of_result(self):
        with mock.patch.object(bridge.urllib.request, 'urlopen', return_value=Response({'success': {'0': 'ABCDEFGH'}, 'failed': {}})) as post:
            result = bridge.archive_item({'url':'https://example.org/paper', 'title':'A study', 'collectionKey':'ABCD2345', 'pdfPath':'paper.pdf'})
        self.assertTrue(result['ok'])
        request = post.call_args.args[0]
        body = json.loads(request.data)
        self.assertEqual(body[0]['collections'], ['ABCD2345'])
        self.assertEqual(body[0]['extra'], 'Local PDF: paper.pdf')
        self.assertNotIn('fake-secret', json.dumps(result))

    def test_http_success_with_item_failure_does_not_report_success(self):
        with mock.patch.object(bridge.urllib.request, 'urlopen', return_value=Response({'success': {}, 'failed': {'0': {'message':'bad item'}}})):
            self.assertFalse(bridge.archive_item({'url':'https://example.org/paper'})['ok'])

    def test_missing_key_does_not_prompt_or_write(self):
        self.key.return_value = None
        with mock.patch.object(bridge.urllib.request, 'urlopen') as post:
            result=bridge.archive_item({'url':'https://example.org/paper'})
        self.assertFalse(result['ok'])
        self.assertIn('authorization is required',result['reason'])
        post.assert_not_called()

    def test_rejected_key_is_forgotten_without_retrying_write(self):
        err = HTTPError('http://127.0.0.1/', 401, 'Unauthorized', {}, io.BytesIO())
        with mock.patch.object(bridge.urllib.request, 'urlopen', side_effect=err) as post, mock.patch.object(bridge.auth, 'forget_key') as forget:
            result=bridge.archive_item({'url':'https://example.org/paper'})
        self.assertFalse(result['ok'])
        self.assertEqual(post.call_count,1)
        forget.assert_called_once_with('test-server')

    def test_invalid_collection_does_not_write(self):
        with mock.patch.object(bridge.urllib.request, 'urlopen') as post:
            result=bridge.archive_item({'url':'https://example.org/paper', 'collectionKey':'not valid'})
        self.assertFalse(result['ok'])
        post.assert_not_called()


if __name__ == '__main__': unittest.main()
