"""Stateless OAuth confidential-client token helper for the customer proxy.

Traefik routes only POST/OPTIONS /oauth/<client>/token here. The helper adds the
configured client ID and secret to a fixed token endpoint and returns the token
response to the browser. It never stores, logs, or caches tokens.
"""

import json
import logging
import os
import re
import signal
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_BODY = 8192
MAX_UPSTREAM_BODY = 65536
TOKEN_FIELDS = {
    "access_token", "token_type", "scope", "expires_in",
    "refresh_token", "refresh_token_expires_in", "id_token", "created_at",
}
PATH = re.compile(r"^/oauth/([a-z0-9][a-z0-9.-]*)/token$")
VERIFIER = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")
ERROR_CODE = re.compile(r"^[a-z_]{1,64}$")


class UpstreamResponseError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def load_config(environ):
    settings = json.loads(environ["PROXY_SETTINGS"])
    secrets = json.loads(environ.get("OAUTH_CLIENT_SECRETS") or "{}")
    if not isinstance(secrets, dict):
        raise ValueError("OAUTH_CLIENT_SECRETS must be a JSON object")
    clients = {}
    for name, client in (settings.get("oauthClients") or {}).items():
        secret = secrets.get(name)
        if not isinstance(secret, str) or not secret:
            logging.warning("OAuth client %s has no configured secret; it is disabled", name)
            continue
        clients[name] = {**client, "clientSecret": secret}
    return {"origins": set(settings["allowedOrigins"]), "clients": clients}


def credential(payload, key, limit=4096):
    value = payload.get(key)
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ValueError(f"Invalid {key}")
    return value


def token_request_fields(payload, client):
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object")
    grant = payload.get("grant_type")
    if grant == "authorization_code" and set(payload) == {
        "grant_type", "code", "code_verifier", "redirect_uri",
    }:
        if not VERIFIER.match(credential(payload, "code_verifier", 128)):
            raise ValueError("Invalid PKCE verifier")
        if payload["redirect_uri"] not in client["redirectUris"]:
            raise ValueError("Unregistered redirect URI")
        fields = {
            "grant_type": grant,
            "code": credential(payload, "code"),
            "code_verifier": payload["code_verifier"],
            "redirect_uri": payload["redirect_uri"],
        }
    elif grant == "refresh_token" and set(payload) == {"grant_type", "refresh_token"}:
        fields = {"grant_type": grant, "refresh_token": credential(payload, "refresh_token")}
    else:
        raise ValueError("Unexpected request fields")
    fields.update(client_id=client["clientId"], client_secret=client["clientSecret"])
    return fields


def parse_json(raw):
    if len(raw) > MAX_UPSTREAM_BODY:
        raise UpstreamResponseError("Oversized upstream response")
    try:
        result = json.loads(raw)
    except (ValueError, UnicodeError) as error:
        raise UpstreamResponseError("Invalid upstream JSON") from error
    if not isinstance(result, dict):
        raise UpstreamResponseError("Invalid upstream response")
    return result


def exchange(payload, client):
    request = Request(
        client["tokenUrl"],
        data=urlencode(token_request_fields(payload, client)).encode(),
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        # Do not follow redirects that could expose the configured secret.
        with build_opener(NoRedirect()).open(request, timeout=10) as response:
            result = parse_json(response.read(MAX_UPSTREAM_BODY + 1))
    except HTTPError as error:
        if error.code not in (400, 401):
            raise
        result = parse_json(error.read(MAX_UPSTREAM_BODY + 1))
        result.setdefault("error", "invalid_request")
    if "error" in result:
        # GitHub reports errors with HTTP 200; expose only a safe error code.
        code = result["error"] if isinstance(result["error"], str) else ""
        return 400, {"error": code if ERROR_CODE.match(code) else "token_request_rejected"}
    if not isinstance(result.get("access_token"), str) or not result["access_token"]:
        raise UpstreamResponseError("Missing upstream access token")
    return 200, {key: value for key, value in result.items() if key in TOKEN_FIELDS}


class Handler(BaseHTTPRequestHandler):
    config = {"origins": set(), "clients": {}}
    server_version = "oauth-helper"
    sys_version = ""

    def log_message(self, format, *args):
        # Default access logs include request lines; never log OAuth traffic.
        pass

    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        match = PATH.match(self.path)
        client = self.config["clients"].get(match.group(1)) if match else None
        if client is None:
            self.reply(404, {"error": "not_found"})
            return
        # CORS is enforced by Traefik; this only rejects unexpected browser origins.
        if self.headers.get("Origin") not in self.config["origins"]:
            self.reply(403, {"error": "origin_not_allowed"})
            return
        if (self.headers.get("Content-Type") or "").split(";")[0].strip() != "application/json":
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
            status, body = exchange(payload, client)
        except (ValueError, UnicodeError):
            self.reply(400, {"error": "invalid_request"})
            return
        except (HTTPError, URLError, TimeoutError, OSError, UpstreamResponseError) as error:
            # HTTP 404 from GitHub usually means an unknown client ID.
            detail = f"HTTP {error.code}" if isinstance(error, HTTPError) else type(error).__name__
            logging.warning("Token endpoint request failed for OAuth client %s: %s", match.group(1), detail)
            self.reply(502, {"error": "token_endpoint_unavailable"})
            return
        self.reply(status, body)

    def do_GET(self):
        self.reply(404, {"error": "not_found"})


def main():
    logging.basicConfig(level=logging.WARNING, format="oauth-helper %(levelname)s %(message)s")
    Handler.config = load_config(os.environ)
    # Python ignores SIGTERM as container PID 1 unless a handler is installed.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    address = (os.environ.get("OAUTH_HELPER_HOST", "127.0.0.1"), int(os.environ.get("OAUTH_HELPER_PORT", "8082")))
    with ThreadingHTTPServer(address, Handler) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
