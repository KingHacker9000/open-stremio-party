import asyncio
import pytest
from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer
from server.app import create_app, PARTY_KEY

HEADERS = {"Origin": "https://web.stremio.com"}


async def event_of_type(ws, wanted, limit=10):
    for _ in range(limit):
        incoming = await ws.receive_json(timeout=2)
        if incoming.get("type") == wanted:
            return incoming
    raise AssertionError(f"Expected {wanted}")


@pytest.mark.asyncio
async def test_room_persistence_and_roles(tmp_path):
    db_path = str(tmp_path / 'rooms.sqlite')
    async with TestServer(await create_app(db_path)) as server:
        async with TestClient(server) as client:
            r = await client.get('/healthz')
            assert (await r.json())['ok']
            r = await client.get('/')
            assert r.status == 200
            host = await client.ws_connect('/ws', headers=HEADERS)
            await host.send_json({"type": "create", "nickname": "Host", "peerId": "0123456789abcdef"})
            creation = await event_of_type(host, 'joined')
            assert creation['host'] and creation['hostToken']
            code, key = creation['code'], creation['hostToken']
            assert len(code) == 10
            guest = await client.ws_connect('/ws', headers=HEADERS)
            await guest.send_json({"type": "join", "code": code, "nickname": "Friend", "peerId": "abcdef0123456789"})
            joined = await event_of_type(guest, 'joined')
            assert joined['host'] is False and joined['hostToken'] is None
            assert joined['roster']['hostOnline']
            await guest.send_json({"type": "sync", "state": {"position": 10, "duration": 100, "paused": False, "speed": 1}})
            # Only the host may move everyone's playback in host-controlled mode.
            assert not joined['snapshot']
            await host.send_json({"type": "sync", "state": {"position": 25.5, "duration": 100, "paused": False, "speed": 1, "mediaId": "tt1234567"}})
            new_sync = await event_of_type(guest, 'sync')
            assert new_sync['state']['position'] == 25.5
            assert new_sync['state']['mediaId'] == 'tt1234567'
            await guest.send_json({"type": "chat", "text": "Hello everyone!"})
            chat = await event_of_type(host, 'chat')
            assert chat['text'] == 'Hello everyone!'
            await host.send_json({"type": "mode", "value": "everyone"})
            roster = await event_of_type(guest, 'roster')
            assert roster['mode'] == 'everyone'
            # Shared control mode permits guest playback events to reach the host.
            await asyncio.sleep(0.15)
            await guest.send_json({"type": "sync", "state": {"position": 40, "duration": 100, "paused": False, "speed": 1}})
            shared = await event_of_type(host, 'sync')
            assert shared['state']['position'] == 40
            await host.send_json({"type": "leave"})
            await host.close()
            offline = await event_of_type(guest, 'roster')
            assert not offline['hostOnline']
            await guest.close()
    # The room configuration survives a server restart (same SQLite database).
    async with TestServer(await create_app(db_path)) as server:
        async with TestClient(server) as client:
            host2 = await client.ws_connect('/ws', headers=HEADERS)
            await host2.send_json({"type": "join", "code": code, "nickname": "Host again", "hostToken": key})
            joined2 = await event_of_type(host2, 'joined')
            assert joined2['host']
            assert joined2['mode'] == 'everyone'
            await host2.close()


@pytest.mark.asyncio
async def test_origin_name_and_bad_room(tmp_path):
    async with TestServer(await create_app(str(tmp_path / 'rooms.db'))) as server:
        async with TestClient(server) as client:
            with pytest.raises(Exception):
                await client.ws_connect('/ws', headers={"Origin": "https://evil.example"})
            ws = await client.ws_connect('/ws', headers=HEADERS)
            await ws.send_json({"type": "create", "nickname": ""})
            error = await event_of_type(ws, 'error')
            assert 'nickname' in error['message'].lower()
            await ws.send_json({"type": "join", "nickname": "Friend", "code": "AAAAAAAAAA"})
            error = await event_of_type(ws, 'error')
            assert 'not found' in error['message']
            await ws.close()


@pytest.mark.asyncio
async def test_host_replacement_at_capacity(tmp_path, monkeypatch):
    monkeypatch.setattr('server.app.MAX_PEERS', 1)
    async with TestServer(await create_app(str(tmp_path / 'rooms.db'))) as server:
        async with TestClient(server) as client:
            old = await client.ws_connect('/ws', headers=HEADERS)
            await old.send_json({'type': 'create', 'nickname': 'Host'})
            room = await event_of_type(old, 'joined')
            replacement = await client.ws_connect('/ws', headers=HEADERS)
            await replacement.send_json({'type': 'join', 'code': room['code'], 'nickname': 'Host',
                                         'hostToken': room['hostToken']})
            # Consume the old connection's queued roster before its close frame.
            while (await old.receive(timeout=2)).type != WSMsgType.CLOSE:
                pass
            assert old.close_code == 4001
            joined = await event_of_type(replacement, 'joined')
            assert joined['host']
            assert len(joined['roster']['peers']) == 1
            guest = await client.ws_connect('/ws', headers=HEADERS)
            await guest.send_json({'type': 'join', 'code': room['code'], 'nickname': 'Guest'})
            assert (await event_of_type(guest, 'error'))['message'] == 'Room is full.'
            await guest.close()
            await replacement.close()


@pytest.mark.asyncio
async def test_invalid_sync_and_unauthorized_controls(tmp_path):
    app = await create_app(str(tmp_path / 'rooms.db'))
    async with TestServer(app) as server:
        async with TestClient(server) as client:
            host = await client.ws_connect('/ws', headers=HEADERS)
            await host.send_json({'type': 'create', 'nickname': 'Host'})
            joined = await event_of_type(host, 'joined')
            guest = await client.ws_connect('/ws', headers=HEADERS)
            await guest.send_json({'type': 'join', 'nickname': 'Guest', 'code': joined['code'], 'hostToken': 'wrong'})
            assert not (await event_of_type(guest, 'joined'))['host']
            room = app[PARTY_KEY].rooms[joined['code']]
            state = {'position': 10, 'duration': 90, 'paused': True, 'speed': 1}
            await guest.send_json({'type': 'mode', 'value': 'everyone'})
            await guest.send_json({'type': 'sync', 'state': state})
            # A ping is a barrier: prior messages on this socket have been processed.
            await guest.send_json({'type': 'ping'})
            await event_of_type(guest, 'pong')
            assert room.mode == 'host' and room.snapshot is None
            for bad in ({'position': 100}, {'duration': 0}, {'speed': float('nan')},
                        {'position': True}, {'paused': 1}):
                await asyncio.sleep(0.13)
                await host.send_json({'type': 'sync', 'state': {**state, **bad}})
                await host.send_json({'type': 'ping'})
                await event_of_type(host, 'pong')
                assert room.snapshot is None
            await host.close()
            await guest.close()


@pytest.mark.asyncio
async def test_cached_room_cannot_bypass_expiry(tmp_path):
    app = await create_app(str(tmp_path / 'rooms.db'))
    service = app[PARTY_KEY]
    room, _ = service.new_room()
    service.db.execute('UPDATE rooms SET expires_at=0 WHERE code=?', (room.code,))
    service.db.commit()
    assert service.load(room.code) is None
    service.db.close()


@pytest.mark.asyncio
async def test_torrent_selection_requests_permissions_and_public_fields(tmp_path):
    app = await create_app(str(tmp_path / 'rooms.db'))
    async with TestServer(app) as server:
        async with TestClient(server) as client:
            host = await client.ws_connect('/ws', headers=HEADERS)
            await host.send_json({'type': 'create', 'nickname': 'Host'})
            created = await event_of_type(host, 'joined')
            assert 'torrent-selection' in created['features']
            guests = []
            for name in ('Guest', 'Other'):
                ws = await client.ws_connect('/ws', headers=HEADERS)
                await ws.send_json({'type': 'join', 'nickname': name, 'code': created['code']})
                joined = await event_of_type(ws, 'joined')
                guests.append((ws, joined['peerId']))
            guest, guest_id = guests[0]
            other = guests[1][0]
            source = {'infoHash': 'a' * 40, 'fileIdx': 8, 'url': 'https://secret.example/token',
                      'announce': ['https://tracker.example/passkey']}
            await guest.send_json({'type': 'select', 'source': source})
            rejected = await event_of_type(guest, 'error')
            assert rejected['fatal'] is False
            await host.send_json({'type': 'select', 'source': source, 'mediaId': 'tt1234567:1:9',
                                  'state': {'position': 22, 'duration': 90, 'speed': 1, 'paused': True}})
            for ws in (guest, other):
                selection = await event_of_type(ws, 'selection')
                assert selection['source'] == {'infoHash': 'a' * 40, 'fileIdx': 8}
                assert selection['state']['position'] == 22
                assert selection['mediaId'] == 'tt1234567:1:9'
                assert 'secret.example' not in str(selection) and 'passkey' not in str(selection)
            await guest.send_json({'type': 'request-selection'})
            request = await event_of_type(host, 'selection-request')
            assert request['peerId'] == guest_id
            await host.send_json({'type': 'select', 'source': {'infoHash': 'b' * 40, 'fileIdx': 3},
                                  'targetPeer': guest_id, 'state': None})
            targeted = await event_of_type(guest, 'selection')
            assert targeted['source']['fileIdx'] == 3 and targeted['state'] is None
            await other.send_json({'type': 'ping'})
            assert (await other.receive_json(timeout=2))['type'] == 'pong'
            await host.send_json({'type': 'mode', 'value': 'everyone'})
            await event_of_type(guest, 'roster')
            await guest.send_json({'type': 'select', 'source': source})
            assert (await event_of_type(guest, 'error'))['fatal'] is False
            for index in (-1, True, 1.5, 65536):
                await host.send_json({'type': 'select', 'source': {'infoHash': 'a' * 40, 'fileIdx': index}})
                assert (await event_of_type(host, 'error'))['fatal'] is False
            await host.send_json({'type': 'leave'})
            assert not (await event_of_type(guest, 'roster'))['hostOnline']
            await host.close()
            await guest.send_json({'type': 'request-selection'})
            assert 'offline' in (await event_of_type(guest, 'error'))['message']
            await guest.close()
            await other.close()
