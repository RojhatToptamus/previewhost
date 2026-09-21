import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Socket, createServer } from 'node:net';
import koffi from 'koffi';

const kernel = koffi.load('kernel32.dll');
const moduleHandle = kernel.func('void * __stdcall GetModuleHandleW(const char16_t *)')(null);
const address = kernel.func('void * __stdcall GetProcAddress(void *, const char *)');
const openAddress = address(moduleHandle, 'uv_open_osfhandle');
const getAddress = address(moduleHandle, 'uv_get_osfhandle');
console.log(JSON.stringify({ node: process.version, arch: process.arch, uv_open_osfhandle: Boolean(openAddress), uv_get_osfhandle: Boolean(getAddress) }));
assert.ok(openAddress && getAddress, 'Node must export its own libuv descriptor conversion functions');
const adopt = koffi.proto('int adopt(void *)');
const get = koffi.proto('void * get(int)');
const open = kernel.func('void * __stdcall CreateFileW(const char16_t *, uint32, uint32, void *, uint32, uint32, void *)');
const close = kernel.func('int __stdcall CloseHandle(void *)');
const serverPid = kernel.func('int __stdcall GetNamedPipeServerProcessId(void *, _Out_ uint32 *)');
const error = kernel.func('uint32 __stdcall GetLastError()');
const pipe = `\\\\.\\pipe\\previewhost-probe-${randomUUID()}`;
const sockets = new Set();
const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.pipe(socket); });
server.listen(pipe);
await once(server, 'listening');
let handle, socket;
try {
  handle = open(pipe, 0xc0000000, 0, null, 3, 0x40000000 | 0x00100000 | 0x00010000, null);
  assert.notEqual(koffi.address(handle), 0xffffffffffffffffn, `CreateFileW: ${error()}`);
  const pid = [0];
  assert.ok(serverPid(handle, pid), `GetNamedPipeServerProcessId: ${error()}`);
  assert.equal(pid[0], process.pid, 'Identity must come from the connected handle before any write');
  const fd = koffi.call(openAddress, adopt, handle);
  assert.ok(fd >= 0);
  assert.equal(koffi.address(koffi.call(getAddress, get, fd)), koffi.address(handle));
  handle = undefined; // descriptor now owns this exact handle
  socket = new Socket({ fd, readable: true, writable: true });
  const data = once(socket, 'data');
  socket.write('DUMMY_connected_handle_marker');
  assert.equal((await data)[0].toString(), 'DUMMY_connected_handle_marker');
  const ended = once(socket, 'end');
  socket.end();
  await ended;
  const closed = socket.closed ? undefined : once(socket, 'close');
  await closed;
  console.log(JSON.stringify({ connectedServerIdentity: pid[0] === process.pid, exactHandleAdoption: true, roundtrip: true, halfClose: true }));
} finally {
  socket?.destroy();
  if (handle) close(handle);
  for (const peer of sockets) peer.destroy();
  await new Promise(resolve => server.close(resolve));
}
