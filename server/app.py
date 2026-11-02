"""Self-hosted, room-based synchronization only. No streams or Stremio credentials."""
import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

from aiohttp import WSMsgType, web

LOG = logging.getLogger("stremioparty")
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
ROOM_RE = re.compile(r"^[A-HJ-NP-Z2-9]{10}$")
MEDIA_RE = re.compile(r"^[A-Za-z0-9:_-]{1,100}$")
MAX_PEERS = int(os.getenv("MAX_PEERS", "16"))
MAX_ROOMS = int(os.getenv("MAX_ROOMS", "200"))
ROOM_LIFETIME = 24 * 3600
DB_PATH = os.getenv("PARTY_DB", "/data/party.sqlite")
BASE_URL = os.getenv("BASE_URL", "http://localhost:8787").rstrip("/")
ALLOWED_ORIGINS = set(os.getenv("ALLOWED_ORIGINS", "https://web.stremio.com").split(","))
HERE = Path(__file__).resolve().parent.parent


def now_ms():
    return int(time.time() * 1000)


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def valid_name(value):
    if not isinstance(value, str):
        return None
    value = " ".join(value.split()).strip()
    if not 1 <= len(value) <= 24 or any(ord(c) < 32 for c in value):
        return None
    return value


def bounded_number(value, lo, hi):
    if type(value) not in (float, int) or value != value or not lo <= value <= hi:
        return None
    return float(value)


@dataclass(eq=False)
class Peer:
    ws: web.WebSocketResponse
    peer_id: str
    nickname: str
    host: bool = False
    timestamps: deque = field(default_factory=deque)
    last_sync: float = 0
    last_chat: float = 0


@dataclass
class Room:
    code: str
    host_hash: str
    mode: str = "host"  # 'everyone' optionally allows all members to control playback
    clients: dict = field(default_factory=dict)
    messages: deque = field(default_factory=lambda: deque(maxlen=40))
    snapshot: dict | None = None
    sequence: int = 0
    last_db_touch: float = 0

    def current_snapshot(self):
        if not self.snapshot:
            return None
        value = dict(self.snapshot)
        now = now_ms()
        if not value["paused"]:
            value["position"] = min(value["duration"], value["position"] + max(0, (now - value["serverTs"]) / 1000) * value["speed"])
        value["serverTs"] = now
        return value

    def roster(self):
        peers = [{"id": peer.peer_id, "nickname": peer.nickname, "host": peer.host}
                 for peer in self.clients.values()]
        return {"type": "roster", "peers": peers, "hostOnline": any(p.host for p in self.clients.values()), "mode": self.mode}


class PartyApp:
    def __init__(self, db_path=DB_PATH):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(db_path)
        self.db.execute("""CREATE TABLE IF NOT EXISTS rooms (
            code TEXT PRIMARY KEY, host_hash TEXT NOT NULL, mode TEXT NOT NULL,
            created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)""")
        self.db.commit()
        self.rooms = {}
        self.creation_attempts = {}

    def cleanup(self):
        epoch = int(time.time())
        self.db.execute("DELETE FROM rooms WHERE expires_at < ?", (epoch,))
        self.db.commit()
        for code, room in list(self.rooms.items()):
            if not room.clients:
                record = self.db.execute("SELECT 1 FROM rooms WHERE code=?", (code,)).fetchone()
                if not record:
                    del self.rooms[code]
        for ip, times in list(self.creation_attempts.items()):
            if not times or times[-1] < time.monotonic() - 3600:
                del self.creation_attempts[ip]

    def load(self, code):
        if code in self.rooms:
            return self.rooms[code]
        record = self.db.execute("SELECT host_hash,mode FROM rooms WHERE code=? AND expires_at>?",
                                 (code, int(time.time()))).fetchone()
        if not record:
            return None
        room = Room(code, record[0], record[1])
        self.rooms[code] = room
        return room

    def new_room(self):
        self.cleanup()
        count = self.db.execute("SELECT COUNT(*) FROM rooms").fetchone()[0]
        if count >= MAX_ROOMS:
            return None
        token = secrets.token_urlsafe(32)
        for _ in range(10):
            code = "".join(secrets.choice(ALPHABET) for _ in range(10))
            if not self.db.execute("SELECT 1 FROM rooms WHERE code=?", (code,)).fetchone():
                break
        else:
            return None
        epoch = int(time.time())
        room = Room(code, token_hash(token))
        self.db.execute("INSERT INTO rooms VALUES(?,?,?,?,?)",
                        (code, room.host_hash, room.mode, epoch, epoch + ROOM_LIFETIME))
        self.db.commit()
        self.rooms[code] = room
        return room, token

    async def emit(self, peer, payload):
        if not peer.ws.closed:
            try:
                await peer.ws.send_json(payload)
            except (ConnectionResetError, RuntimeError):
                pass

    async def broadcast(self, room, payload, except_ws=None):
        await asyncio.gather(*(self.emit(p, payload) for ws, p in list(room.clients.items())
                               if ws is not except_ws), return_exceptions=True)

    async def register(self, room, ws, msg, token=None):
        name = valid_name(msg.get("nickname"))
        if not name:
            await ws.send_json({"type": "error", "message": "Nickname must be 1–24 characters."})
            return False
        if len(room.clients) >= MAX_PEERS:
            await ws.send_json({"type": "error", "message": "Room is full."})
            return False
        key = msg.get("hostToken")
        host = (isinstance(key, str) and hmac.compare_digest(token_hash(key), room.host_hash)) or token is not None
        peer_id = msg.get("peerId")
        if not isinstance(peer_id, str) or not re.fullmatch(r"[a-f0-9-]{16,40}", peer_id):
            peer_id = secrets.token_hex(12)
        if host:
            # A duplicated/reloaded host tab cannot create two competing leaders.
            for old_ws, old in list(room.clients.items()):
                if old.host:
                    await old_ws.close(code=4001, message=b"Host connected in another tab")
        peer = Peer(ws, peer_id, name, host)
        room.clients[ws] = peer
        self.db.execute("UPDATE rooms SET expires_at=? WHERE code=?",
                        (int(time.time()) + ROOM_LIFETIME, room.code))
        room.last_db_touch = time.monotonic()
        self.db.commit()
        await self.emit(peer, {
            "type": "joined", "code": room.code, "peerId": peer.peer_id, "host": host,
            "hostToken": token, "inviteUrl": f"{BASE_URL}/r/{room.code}",
            "mode": room.mode, "snapshot": room.current_snapshot(),
            "messages": list(room.messages), "roster": room.roster(),
        })
        await self.broadcast(room, room.roster())
        return True

    @staticmethod
    def rate_ok(peer, event_type):
        stamp = time.monotonic()
        queue = peer.timestamps
        while queue and queue[0] < stamp - 1:
            queue.popleft()
        if len(queue) >= 30:
            return False
        queue.append(stamp)
        if event_type == "chat":
            if stamp - peer.last_chat < 0.5:
                return False
            peer.last_chat = stamp
        if event_type == "sync":
            if stamp - peer.last_sync < 0.12:
                return False
            peer.last_sync = stamp
        return True

    async def socket(self, request):
        origin = request.headers.get("Origin")
        if origin not in ALLOWED_ORIGINS:
            raise web.HTTPForbidden(text="Unsupported origin")
        ws = web.WebSocketResponse(heartbeat=25, max_msg_size=8192)
        await ws.prepare(request)
        room = None
        peer = None
        join_attempts = 0
        try:
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    if message.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                        break
                    continue
                try:
                    msg = json.loads(message.data)
                except (ValueError, TypeError):
                    await ws.send_json({"type": "error", "message": "Invalid message."})
                    continue
                if not isinstance(msg, dict):
                    continue
                typ = msg.get("type")
                if peer is None:
                    if typ == "create":
                        ip = request.remote or "unknown"
                        # Only opt in behind a trusted local reverse proxy.
                        if os.getenv("TRUST_PROXY") == "1":
                            import ipaddress
                            forwarded = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
                            try:
                                ipaddress.ip_address(forwarded)
                                ip = forwarded
                            except ValueError:
                                pass
                        limit = self.creation_attempts.setdefault(ip, deque(maxlen=12))
                        stamp = time.monotonic()
                        if len([t for t in limit if t > stamp - 3600]) >= 12:
                            await ws.send_json({"type": "error", "message": "Too many rooms created. Try again later."})
                            continue
                        limit.append(stamp)
                        if not valid_name(msg.get("nickname")):
                            await ws.send_json({"type": "error", "message": "Choose a nickname first."})
                            continue
                        result = self.new_room()
                        if not result:
                            await ws.send_json({"type": "error", "message": "Server room limit reached."})
                            continue
                        room, token = result
                        ok = await self.register(room, ws, msg, token)
                    elif typ == "join":
                        join_attempts += 1
                        if join_attempts > 5:
                            await ws.close(code=1008, message=b"Too many join attempts")
                            break
                        code = str(msg.get("code", "")).upper().strip()
                        room = self.load(code) if ROOM_RE.fullmatch(code) else None
                        if not room:
                            await ws.send_json({"type": "error", "message": "Room not found or expired."})
                            continue
                        ok = await self.register(room, ws, msg)
                    else:
                        await ws.send_json({"type": "error", "message": "Create or join a room first."})
                        continue
                    peer = room.clients.get(ws) if ok else None
                    continue

                if not self.rate_ok(peer, typ):
                    continue
                if typ == "ping":
                    await self.emit(peer, {"type": "pong", "serverTs": now_ms()})
                elif typ == "mode":
                    if not peer.host or msg.get("value") not in ("host", "everyone"):
                        continue
                    room.mode = msg["value"]
                    self.db.execute("UPDATE rooms SET mode=? WHERE code=?", (room.mode, room.code))
                    self.db.commit()
                    await self.broadcast(room, room.roster())
                elif typ == "chat":
                    value = msg.get("text")
                    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 500:
                        continue
                    item = {"type": "chat", "peerId": peer.peer_id, "nickname": peer.nickname,
                            "text": value.strip(), "ts": now_ms()}
                    room.messages.append(item)
                    await self.broadcast(room, item)
                elif typ == "sync":
                    if not (peer.host or room.mode == "everyone"):
                        continue
                    state = msg.get("state")
                    if not isinstance(state, dict):
                        continue
                    position = bounded_number(state.get("position"), 0, 864000)
                    duration = bounded_number(state.get("duration"), 0, 864000)
                    speed = bounded_number(state.get("speed"), 0.25, 3)
                    paused = state.get("paused")
                    media = state.get("mediaId")
                    if position is None or duration is None or speed is None or type(paused) is not bool:
                        continue
                    if media is not None and (not isinstance(media, str) or not MEDIA_RE.fullmatch(media)):
                        media = None
                    if time.monotonic() - room.last_db_touch > 60:
                        self.db.execute("UPDATE rooms SET expires_at=? WHERE code=?",
                                        (int(time.time()) + ROOM_LIFETIME, room.code))
                        self.db.commit()
                        room.last_db_touch = time.monotonic()
                    room.sequence += 1
                    room.snapshot = {"position": position, "duration": duration,
                                     "speed": speed, "paused": paused, "mediaId": media,
                                     "seq": room.sequence, "serverTs": now_ms(),
                                     "fromPeer": peer.peer_id}
                    await self.broadcast(room, {"type": "sync", "state": room.snapshot}, ws)
                elif typ == "leave":
                    break
        except asyncio.TimeoutError:
            pass
        finally:
            if room and ws in room.clients:
                del room.clients[ws]
                await self.broadcast(room, room.roster())
            await ws.close()
        return ws


PARTY_KEY = web.AppKey("party", PartyApp)


async def create_app(db_path=DB_PATH):
    app = web.Application(client_max_size=8192)
    service = PartyApp(db_path)
    app[PARTY_KEY] = service
    app.router.add_get("/ws", service.socket)
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/", landing)
    app.router.add_get("/r/{code}", landing)
    app.router.add_get("/robots.txt", robots)
    app.router.add_get("/public-config", public_config)
    app.router.add_static("/static/", HERE / "static", show_index=False)
    async def close_db(app):
        app[PARTY_KEY].db.close()
    app.on_cleanup.append(close_db)
    return app


async def healthz(request):
    return web.json_response({"ok": True, "service": "open-stremio-party"})


async def public_config(request):
    # Public metadata only; never expose server secrets, host tokens or system configuration.
    url = os.getenv("RELEASES_URL", "")
    if not url.startswith("https://"):
        url = ""
    return web.json_response({"releasesUrl": url})


async def robots(request):
    return web.Response(text="User-agent: *\nDisallow: /\n", content_type="text/plain")


async def landing(request):
    response = web.FileResponse(HERE / "static" / "index.html")
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'"
    return response


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    web.run_app(create_app(), host="0.0.0.0", port=int(os.getenv("PORT", "8787")))
