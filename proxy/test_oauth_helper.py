import json
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from io import BytesIO
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.parse import parse_qs

import oauth_helper as oauth

ORIGIN = "http://localhost:5130"
SETTINGS = {
    "allowedOrigins": [ORIGIN],
    "oauthClients": {
        "github": {
            "tokenUrl": "https://github.com/login/oauth/access_token",
            "clientId": "test-client",
            "redirectUris": [f"{ORIGIN}/oauth/callback"],
        },
        "unconfigured": {
            "tokenUrl": "https://gitlab.example/oauth/token",
            "clientId": "other",
            "redirectUris": [f"{ORIGIN}/oauth/callback"],
        },
    },
}
CONFIG = oauth.load_config({
    "PROXY_SETTINGS": json.dumps(SETTINGS),
    "OAUTH_CLIENT_SECRETS": json.dumps({"github": "test-secret"}),
})
CLIENT = CONFIG["clients"]["github"]
CODE = {
    "grant_type": "authorization_code",
    "code": "test-code",
    "code_verifier": "a" * 43,
    "redirect_uri": f"{ORIGIN}/oauth/callback",
}


def upstream(result):
    opener = MagicMock()
    opener.open.return_value.__enter__.return_value.read.return_value = json.dumps(result).encode()
    return patch.object(oauth, "build_opener", return_value=opener), opener


class ConfigTests(unittest.TestCase):
    def test_clients_without_secret_are_disabled(self):
        self.assertEqual(set(CONFIG["clients"]), {"github"})
        self.assertEqual(CONFIG["origins"], {ORIGIN})

    def test_missing_secrets_variable(self):
        config = oauth.load_config({"PROXY_SETTINGS": json.dumps(SETTINGS)})
        self.assertEqual(config["clients"], {})


class ExchangeTests(unittest.TestCase):
    def test_code_exchange_adds_client_credentials_and_filters_response(self):
        mocked, opener = upstream({"access_token": "token", "client_secret": "unwanted"})
        with mocked:
            self.assertEqual(oauth.exchange(CODE, CLIENT), (200, {"access_token": "token"}))
        request = opener.open.call_args.args[0]
        fields = parse_qs(request.data.decode())
        self.assertEqual(request.full_url, SETTINGS["oauthClients"]["github"]["tokenUrl"])
        self.assertEqual(fields["client_id"], ["test-client"])
        self.assertEqual(fields["client_secret"], ["test-secret"])
        self.assertEqual(fields["redirect_uri"], [CODE["redirect_uri"]])
        self.assertEqual(fields["code_verifier"], [CODE["code_verifier"]])
        self.assertEqual(fields["grant_type"], ["authorization_code"])

    def test_refresh(self):
        mocked, opener = upstream({"access_token": "next", "refresh_token": "next-refresh"})
        with mocked:
            status, result = oauth.exchange({"grant_type": "refresh_token", "refresh_token": "old"}, CLIENT)
        self.assertEqual((status, result["refresh_token"]), (200, "next-refresh"))
        fields = parse_qs(opener.open.call_args.args[0].data.decode())
        self.assertEqual(fields["grant_type"], ["refresh_token"])
        self.assertEqual(fields["refresh_token"], ["old"])

    def test_rejects_input_without_upstream_request(self):
        payloads = [
            [], {}, {**CODE, "client_id": "other"}, {**CODE, "code_verifier": "short"},
            {**CODE, "redirect_uri": "https://evil.example/callback"},
            {**CODE, "grant_type": "client_credentials"},
            {"grant_type": "refresh_token", "refresh_token": ""},
            {"grant_type": "password", "username": "a", "password": "b"},
        ]
        with patch.object(oauth, "build_opener") as opener:
            for payload in payloads:
                with self.subTest(payload=payload), self.assertRaises(ValueError):
                    oauth.exchange(payload, CLIENT)
            opener.assert_not_called()

    def test_provider_errors_expose_only_safe_codes(self):
        mocked, _ = upstream({"error": "bad_verification_code", "error_description": "private"})
        with mocked:
            self.assertEqual(oauth.exchange(CODE, CLIENT), (400, {"error": "bad_verification_code"}))
        mocked, _ = upstream({"error": "<script>"})
        with mocked:
            self.assertEqual(oauth.exchange(CODE, CLIENT), (400, {"error": "token_request_rejected"}))
        mocked, _ = upstream({})
        with mocked, self.assertRaises(oauth.UpstreamResponseError):
            oauth.exchange(CODE, CLIENT)

    def test_rfc6749_http_400_error(self):
        opener = MagicMock()
        opener.open.side_effect = HTTPError(
            "https://x", 400, "Bad Request", {}, BytesIO(b'{"error":"invalid_grant"}'))
        with patch.object(oauth, "build_opener", return_value=opener):
            self.assertEqual(oauth.exchange(CODE, CLIENT), (400, {"error": "invalid_grant"}))

    def test_no_redirects(self):
        self.assertIsNone(oauth.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example"))


class HttpBoundaryTests(unittest.TestCase):
    def setUp(self):
        class TestHandler(oauth.Handler):
            config = CONFIG

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.connection = HTTPConnection(*self.server.server_address, timeout=5)

    def tearDown(self):
        self.connection.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def post(self, path, body, headers):
        self.connection.request("POST", path, body, headers)
        response = self.connection.getresponse()
        return response.status, response.getheader("Cache-Control"), json.loads(response.read())

    def test_routes_and_validation(self):
        json_headers = {"Origin": ORIGIN, "Content-Type": "application/json"}
        self.assertEqual(self.post("/oauth/unconfigured/token", "{}", json_headers)[0], 404)
        self.assertEqual(self.post("/oauth/github/other", "{}", json_headers)[0], 404)
        self.assertEqual(self.post("/oauth/github/token", "{}", {"Content-Type": "application/json"})[0], 403)
        self.assertEqual(self.post("/oauth/github/token", "{}", {"Origin": ORIGIN, "Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.post("/oauth/github/token", "{}", json_headers)[0], 400)
        mocked, _ = upstream({"access_token": "token"})
        with mocked:
            status, cache, body = self.post("/oauth/github/token", json.dumps(CODE), json_headers)
        self.assertEqual((status, cache, body), (200, "no-store", {"access_token": "token"}))


if __name__ == "__main__":
    unittest.main()
