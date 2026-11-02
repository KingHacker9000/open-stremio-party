import asyncio
import pytest
from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer
from server.app import create_app

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
