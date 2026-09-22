import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, stat } from 'node:fs/promises';
import koffi from 'koffi';

/** Broaden only the fixture being tested, then restore its private permissions. */
export async function publicAccess(path: string, enabled: boolean): Promise<void> {
  if (process.platform === 'win32') {
    execFileSync('icacls.exe', [path, ...(enabled ? ['/grant', '*S-1-1-0:(R)'] : ['/remove:g', '*S-1-1-0'])]);
  } else {
    await chmod(path, (await stat(path)).isDirectory() ? (enabled ? 0o755 : 0o700) : (enabled ? 0o644 : 0o600));
  }
}

// Set permissions only on this test's own pipe. Opening this handle sends no HTTP bytes.
export function pipePermissions(endpoint: string, publicAccess: boolean): void {
  const kernel = koffi.load('kernel32.dll'), security = koffi.load('advapi32.dll');
  const user = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-5-[\d-]+/)![0];
  const descriptor = [null], dacl = [null], present = [0], defaulted = [0];
  const convert = security.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *, uint32, _Out_ void **, void *)');
  const read = security.func('int __stdcall GetSecurityDescriptorDacl(void *, _Out_ int *, _Out_ void **, _Out_ int *)');
  const set = security.func('uint32 __stdcall SetSecurityInfo(void *, int, uint32, void *, void *, void *, void *)');
  const open = kernel.func('void * __stdcall CreateFileW(const char16_t *, uint32, uint32, void *, uint32, uint32, void *)');
  const close = kernel.func('int __stdcall CloseHandle(void *)');
  const free = kernel.func('void * __stdcall LocalFree(void *)');
  assert.ok(convert(`D:P(A;;GA;;;${user})(A;;GA;;;SY)(A;;GA;;;BA)${publicAccess ? '(A;;GA;;;WD)' : ''}`, 1, descriptor, null));
  try {
    assert.ok(read(descriptor[0], present, dacl, defaulted));
    assert.equal(present[0], 1);
    const handle = open(endpoint, 0xc0040000, 0, null, 3, 0x00100000, null);
    assert.notEqual(koffi.address(handle), 0xffffffffffffffffn);
    try { assert.equal(set(handle, 6, 0x4, null, null, dacl[0], null), 0); }
    finally { assert.ok(close(handle)); }
  } finally { free(descriptor[0]); }
}
