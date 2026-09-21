// Disposable dummy-only Windows pipe probe. Parent PowerShell bounds blocking Win32 calls.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
const result = value => writeFileSync(config.result, JSON.stringify(value));
let stage = 'account';
try {
  assert.equal(process.platform, 'win32');
  const whoami = join(process.env.SystemRoot, 'System32', 'whoami.exe');
  const sid = execFileSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 2000 }).match(/S-1-5-[\d-]+/)[0];
  assert.equal(sid, config.accountSid);
  assert.doesNotMatch(execFileSync(whoami, ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 2000 }), /S-1-5-32-544(?:[",\s]|$)/);
  if (config.role === 'client') {
    stage = 'client';
    const { Docker } = await import(pathToFileURL(join(config.productRoot, 'dist', 'docker.js')));
    const docker = await Docker.connect(config.pipe);
    if (config.foreign) {
      await assert.rejects(config.attach ? docker.attach('fixture')
        : docker.request('POST', '/containers/create', { marker: 'DUMMY_BODY' }),
      { code: 'UNAUTHORIZED', message: 'Docker pipe has an untrusted owner.' });
    } else if (config.attach) {
      const stream = await docker.attach('fixture');
      try {
        stream.send('DUMMY_INITIALIZATION\n');
        const deadline = performance.now() + 5000;
        while (!existsSync(config.serverResult)) {
          assert.ok(performance.now() < deadline, 'Server did not observe dummy initialization.');
          await delay(25);
        }
      } finally { await stream.close(); }
    } else assert.equal(await docker.engineId(), 'fixture-engine');
    result({ ok: true, ordinaryAccount: true, rejectedOwner: config.foreign });
  } else {
    stage = 'server-create';
    const koffi = createRequire(join(config.productRoot, 'package.json'))('koffi');
    const kernel = koffi.load('kernel32.dll'), security = koffi.load('advapi32.dll');
    const attributes = koffi.struct({ length: 'uint32', descriptor: 'void *', inherit: 'int' });
    const convert = security.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *, uint32, _Out_ void **, void *)');
    const create = kernel.func('__stdcall', 'CreateNamedPipeW', 'void *', ['str16', 'uint32', 'uint32', 'uint32', 'uint32', 'uint32', 'uint32', koffi.pointer(attributes)]);
    const connect = kernel.func('int __stdcall ConnectNamedPipe(void *, void *)');
    const read = kernel.func('int __stdcall ReadFile(void *, _Out_ void *, uint32, _Out_ uint32 *, void *)');
    const write = kernel.func('int __stdcall WriteFile(void *, const void *, uint32, _Out_ uint32 *, void *)');
    const flush = kernel.func('int __stdcall FlushFileBuffers(void *)');
    const close = kernel.func('int __stdcall CloseHandle(void *)');
    const free = kernel.func('void * __stdcall LocalFree(void *)');
    const lastError = kernel.func('uint32 __stdcall GetLastError()');
    const inspect = security.func('uint32 __stdcall GetSecurityInfo(void *, int, uint32, _Out_ void **, void *, _Out_ void **, void *, _Out_ void **)');
    const getAce = security.func('int __stdcall GetAce(void *, uint32, _Out_ void **)');
    const toSid = security.func('int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)');
    const sidText = pointer => {
      const text = [null]; assert.ok(toSid(pointer, text));
      try { return koffi.decode(text[0], 'char16_t', -1); } finally { free(text[0]); }
    };
    const descriptor = [null];
    const allowed = [config.victimSid, 'S-1-5-18', 'S-1-5-32-544'];
    assert.ok(convert(`O:${sid}D:P${allowed.map(id => `(A;;GA;;;${id})`).join('')}`, 1, descriptor, null));
    let handle;
    try {
      // Duplex, FIRST_PIPE_INSTANCE, byte mode, blocking, REJECT_REMOTE_CLIENTS, one instance.
      handle = create(config.pipe, 0x00080003, 0x00000008, 1, 4096, 4096, 0,
        { length: koffi.sizeof(attributes), descriptor: descriptor[0], inherit: 0 });
      assert.notEqual(koffi.address(handle), 0xffffffffffffffffn);
    } finally { free(descriptor[0]); }
    try {
      const owner = [null], dacl = [null], actual = [null];
      assert.equal(inspect(handle, 6, 5, owner, null, dacl, null, actual), 0);
      try {
        assert.equal(sidText(owner[0]), sid);
        const sids = [];
        for (let i = 0; i < koffi.decode(dacl[0], 4, 'uint16'); i++) {
          const entry = [null]; assert.ok(getAce(dacl[0], i, entry));
          assert.equal(koffi.decode(entry[0], 'uint8'), 0);
          sids.push(sidText(koffi.address(entry[0]) + 8n));
        }
        assert.deepEqual(sids.sort(), allowed.sort());
      } finally { free(actual[0]); }
      writeFileSync(config.ready, 'ready');
      stage = 'server-connect';
      if (!connect(handle, null)) assert.equal(lastError(), 535); // Client already connected.
      let bytes = 0;
      const chunk = () => {
        const buffer = Buffer.alloc(4096), count = [0];
        if (!read(handle, buffer, buffer.length, count, null)) assert.ok([109, 232].includes(lastError()));
        bytes += count[0]; return buffer.subarray(0, count[0]);
      };
      stage = 'server-read';
      if (config.foreign) {
        assert.equal(chunk().length, 0, 'Rejected client sent bytes.');
      } else {
        let header = '';
        while (!header.includes('\r\n\r\n')) {
          const part = chunk(); assert.ok(part.length && bytes <= 8192); header += part.toString('utf8');
        }
        assert.ok(header.startsWith(config.attach ? 'POST /v1.40/containers/fixture/attach?' : 'GET /v1.40/info '));
        const body = JSON.stringify({ ID: 'fixture-engine' });
        const response = Buffer.from(config.attach
          ? 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'
          : `HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        const written = [0]; assert.ok(write(handle, response, response.length, written, null));
        assert.equal(written[0], response.length);
        if (config.attach) {
          let input = '';
          while (!input.endsWith('\n')) { const part = chunk(); assert.ok(part.length && bytes <= 8192); input += part.toString('utf8'); }
          assert.equal(input, 'DUMMY_INITIALIZATION\n');
        }
        assert.ok(flush(handle));
      }
      result({ ok: true, ordinaryAccount: true, ownerMatchesServer: true, aclMatchesVictim: true, bytes });
    } finally { assert.ok(close(handle)); }
  }
} catch (error) {
  result({ ok: false, stage, code: error.code ?? error.name, message: String(error.message).slice(0, 512) });
  process.exitCode = 1;
}
