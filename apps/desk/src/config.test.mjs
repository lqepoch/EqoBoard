import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.mjs';

test('missing optional port variables use documented defaults', () => {
  const config = loadConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.futu.host, '127.0.0.1');
  assert.equal(config.futu.port, 12345);
  assert.equal(config.alpaca.dataBase, 'https://data.alpaca.markets');
  assert.equal(config.alpaca.feed, 'indicative');
});

test('valid explicit TCP ports and loopback host are accepted', () => {
  const config = loadConfig({
    DESK_PORT: '3001',
    FUTU_OPEND_WEBSOCKET_PORT: '65535',
    FUTU_OPEND_HOST: 'localhost',
    APCA_API_BASE_URL: 'https://api.alpaca.markets',
  });
  assert.equal(config.port, 3001);
  assert.equal(config.futu.port, 65535);
  assert.equal(config.futu.host, 'localhost');
});

for (const value of ['', ' ', '\t', '0', '-1', '65536', '999999', '1.2', '1e2', 'Infinity', '12345x']) {
  test(`Futu TCP port ${JSON.stringify(value)} fails before client startup`, () => {
    assert.throws(() => loadConfig({ FUTU_OPEND_WEBSOCKET_PORT: value }), /FUTU_OPEND_WEBSOCKET_PORT invalid/);
  });
  test(`Desk HTTP port ${JSON.stringify(value)} fails before HTTP bind`, () => {
    assert.throws(() => loadConfig({ DESK_PORT: value }), /DESK_PORT invalid/);
  });
}

test('refuse non-loopback OpenD host and unknown Alpaca trading host', () => {
  assert.throws(() => loadConfig({ FUTU_OPEND_HOST: '192.0.2.1' }), /loopback/);
  assert.throws(() => loadConfig({ APCA_API_BASE_URL: 'https://fake.example' }), /Alpaca trading host/);
});
