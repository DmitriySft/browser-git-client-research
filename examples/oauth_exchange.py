"""Illustrative stateless OAuth helper; expose only through the reverse proxy."""

import json
import logging
import os
import re
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

TOKEN_URL = "https://github.com/login/oauth/access_token"
MAX_BODY = 8192
TOKEN_FIELDS = {
    "access_token", "token_type", "scope", "expires_in",
    "refresh_token", "refresh_token_expires_in",
}


class UpstreamResponseError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def exchange(payload, config):
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object")
    if set(payload) == {"code", "code_verifier"}:
        if not isinstance(payload["code_verifier"], str) or not re.fullmatch(
            r"[A-Za-z0-9._~-]{43,128}", payload["code_verifier"]
        ):
            raise ValueError("Invalid PKCE verifier")
        credential = payload["code"]
        fields = {**payload, "redirect_uri": config["CALLBACK_URL"]}
    elif set(payload) == {"refresh_token"}:
        credential = payload["refresh_token"]
        fields = {**payload, "grant_type": "refresh_token"}
    else:
        raise ValueError("Unexpected request fields")
    if not isinstance(credential, str) or not credential or len(credential) > 4096:
        raise ValueError("Invalid credential")
    fields.update(
        client_id=config["GH_CLIENT_ID"], client_secret=config["GH_CLIENT_SECRET"]
    )
    request = Request(
        TOKEN_URL,
        data=urlencode(fields).encode(),
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    # Do not follow redirects that could expose the configured secret.
    with build_opener(NoRedirect()).open(request, timeout=10) as response:
        raw = response.read(MAX_BODY + 1)
    if len(raw) > MAX_BODY:
        raise UpstreamResponseError("Oversized upstream response")
    try:
        result = json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise UpstreamResponseError("Invalid upstream JSON") from error
    if not isinstance(result, dict):
        raise UpstreamResponseError("Invalid upstream response")
    if "error" in result:
        return 400, {"error": "github_rejected_exchange"}
    if not isinstance(result.get("access_token"), str) or not result["access_token"]:
        raise UpstreamResponseError("Missing upstream access token")
    return 200, {key: value for key, value in result.items() if key in TOKEN_FIELDS}


class Handler(BaseHTTPRequestHandler):
    config = {}

    def log_message(self, format, *args):
        # Base access logs include URLs; OAuth credentials must not be logged.
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        if self.headers.get("Origin") == self.config["BROWSER_ORIGIN"]:
            self.send_header("Access-Control-Allow-Origin", self.config["BROWSER_ORIGIN"])
        self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def allowed(self):
        if self.path != "/oauth/exchange":
            self.reply(404, {"error": "not_found"})
            return False
        if self.headers.get("Origin") != self.config["BROWSER_ORIGIN"]:
            self.reply(403, {"error": "origin_not_allowed"})
            return False
        return True

    def do_OPTIONS(self):
        if self.allowed():
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.config["BROWSER_ORIGIN"])
            self.send_header("Access-Control-Allow-Methods", "POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Vary", "Origin")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()

    def do_POST(self):
        if not self.allowed():
            return
        if self.headers.get("Content-Type") != "application/json":
            self.reply(415, {"error": "expected_application_json"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if self.headers.get("Transfer-Encoding") or not 0 < length <= MAX_BODY:
            self.reply(400, {"error": "invalid_body_length"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            self.reply(400, {"error": "invalid_json"})
            return
        try:
            status, body = exchange(payload, self.config)
        except (HTTPError, URLError, TimeoutError, OSError, UpstreamResponseError):
            logging.warning("GitHub token endpoint request failed")
            self.reply(502, {"error": "github_unavailable"})
            return
        except (ValueError, UnicodeError):
            self.reply(400, {"error": "invalid_exchange"})
            return
        self.reply(status, body)


if __name__ == "__main__":
    Handler.config = {
        key: os.environ[key]
        for key in ("GH_CLIENT_ID", "GH_CLIENT_SECRET", "CALLBACK_URL", "BROWSER_ORIGIN")
    }
    with HTTPServer(("0.0.0.0", 8081), Handler) as server:
        server.serve_forever()
