import json
import threading
import unittest
from http.client import HTTPConnection
from http.server import HTTPServer
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs

import oauth_exchange as oauth

CONFIG = {
    "GH_CLIENT_ID": "test-client",
    "GH_CLIENT_SECRET": "test-secret",
    "CALLBACK_URL": "https://client.example/callback",
    "BROWSER_ORIGIN": "https://client.example",
}
CODE = {"code": "test-code", "code_verifier": "a" * 43}


class ExchangeTests(unittest.TestCase):
    def upstream(self, result):
        opener = MagicMock()
        opener.open.return_value.__enter__.return_value.read.return_value = json.dumps(result).encode()
        return patch.object(oauth, "build_opener", return_value=opener), opener

    def test_code_exchange_is_fixed_and_filters_response(self):
        mocked, opener = self.upstream({"access_token": "token", "client_secret": "unwanted"})
        with mocked:
            self.assertEqual(oauth.exchange(CODE, CONFIG), (200, {"access_token": "token"}))
        request = opener.open.call_args.args[0]
        fields = parse_qs(request.data.decode())
        self.assertEqual(request.full_url, oauth.TOKEN_URL)
        self.assertEqual(fields["client_secret"], ["test-secret"])
        self.assertEqual(fields["redirect_uri"], [CONFIG["CALLBACK_URL"]])
        self.assertEqual(fields["code_verifier"], [CODE["code_verifier"]])

    def test_refresh(self):
        mocked, opener = self.upstream({"access_token": "next", "refresh_token": "next-refresh"})
        with mocked:
            status, result = oauth.exchange({"refresh_token": "old"}, CONFIG)
        self.assertEqual(status, 200)
        self.assertEqual(result["refresh_token"], "next-refresh")
        fields = parse_qs(opener.open.call_args.args[0].data.decode())
        self.assertEqual(fields["grant_type"], ["refresh_token"])

    def test_rejects_input_without_upstream_request(self):
        with patch.object(oauth, "build_opener") as opener:
            for payload in ([], {}, {**CODE, "client_id": "other"}, {**CODE, "code_verifier": "short"}):
                with self.subTest(payload=payload), self.assertRaises(ValueError):
                    oauth.exchange(payload, CONFIG)
            opener.assert_not_called()

    def test_github_error_and_malformed_response(self):
        mocked, _ = self.upstream({"error": "bad_verification_code", "error_description": "private"})
        with mocked:
            self.assertEqual(oauth.exchange(CODE, CONFIG), (400, {"error": "github_rejected_exchange"}))
        mocked, _ = self.upstream({})
        with mocked, self.assertRaises(oauth.UpstreamResponseError):
            oauth.exchange(CODE, CONFIG)

    def test_no_redirects(self):
        self.assertIsNone(oauth.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example"))

    def test_http_boundary(self):
        class TestHandler(oauth.Handler):
            config = CONFIG

        with HTTPServer(("127.0.0.1", 0), TestHandler) as server:
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                connection = HTTPConnection(*server.server_address, timeout=5)
                connection.request("POST", "/oauth/exchange", "{}", {"Content-Type": "application/json"})
                response = connection.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                mocked, _ = self.upstream({"access_token": "token"})
                with mocked:
                    connection.request("POST", "/oauth/exchange", json.dumps(CODE), {
                        "Origin": CONFIG["BROWSER_ORIGIN"], "Content-Type": "application/json",
                    })
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.getheader("Cache-Control"), "no-store")
                    self.assertEqual(response.getheader("Access-Control-Allow-Origin"), CONFIG["BROWSER_ORIGIN"])
                    self.assertEqual(json.loads(response.read()), {"access_token": "token"})
                connection.close()
            finally:
                server.shutdown()
                thread.join()


if __name__ == "__main__":
    unittest.main()
