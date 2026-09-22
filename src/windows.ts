import koffi from 'koffi';
import { closeSync, lstatSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PreviewError } from './errors.js';

// Loaded only on Windows. Handles belong to this process and are never inheritable.
let api: ReturnType<typeof load> | undefined;
function win() { return api ??= load(); }
function load() {
  const kernel = koffi.load('kernel32.dll');
  const security = koffi.load('advapi32.dll');
  const network = koffi.load('iphlpapi.dll');
  const attributes = koffi.struct({ length: 'uint32', descriptor: 'void *', inherit: 'int' });
  const overlapped = koffi.struct({ internal: 'uintptr_t', internalHigh: 'uintptr_t', offset: 'uint32', offsetHigh: 'uint32', event: 'void *' });
  const basicLimits = koffi.struct({ processTime: 'int64', jobTime: 'int64', flags: 'uint32', minimum: 'size_t', maximum: 'size_t', active: 'uint32', affinity: 'uintptr_t', priority: 'uint32', scheduling: 'uint32' });
  const limits = koffi.struct({ basic: basicLimits, io: koffi.array('uint64', 6), processMemory: 'size_t', jobMemory: 'size_t', peakProcess: 'size_t', peakJob: 'size_t' });
  return {
    attributes, limits,
    error: kernel.func('uint32 __stdcall GetLastError()'),
    close: kernel.func('int __stdcall CloseHandle(void *)'),
    free: kernel.func('void * __stdcall LocalFree(void *)'),
    current: kernel.func('void * __stdcall GetCurrentProcess()'),
    module: kernel.func('void * __stdcall GetModuleHandleW(const char16_t *)'),
    procedure: kernel.func('void * __stdcall GetProcAddress(void *, const char *)'),
    adoptPipe: koffi.proto('int previewhost_adopt_pipe(void *)'),
    openProcess: kernel.func('void * __stdcall OpenProcess(uint32, int, uint32)'),
    times: kernel.func('int __stdcall GetProcessTimes(void *, _Out_ uint64 *, _Out_ uint64 *, _Out_ uint64 *, _Out_ uint64 *)'),
    createJob: kernel.func('void * __stdcall CreateJobObjectW(void *, const char16_t *)'),
    setJob: kernel.func('int __stdcall SetInformationJobObject(void *, int, const void *, uint32)'),
    assignJob: kernel.func('int __stdcall AssignProcessToJobObject(void *, void *)'),
    queryJob: kernel.func('int __stdcall QueryInformationJobObject(void *, int, _Out_ void *, uint32, void *)'),
    inJob: kernel.func('int __stdcall IsProcessInJob(void *, void *, _Out_ int *)'),
    terminateJob: kernel.func('int __stdcall TerminateJobObject(void *, uint32)'),
    tcp: network.func('uint32 __stdcall GetExtendedTcpTable(_Out_ void *, _Inout_ uint32 *, int, uint32, int, uint32)'),
    openToken: security.func('int __stdcall OpenProcessToken(void *, uint32, _Out_ void **)'),
    tokenInfo: security.func('int __stdcall GetTokenInformation(void *, int, _Out_ void *, uint32, _Out_ uint32 *)'),
    sidString: security.func('int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)'),
    descriptor: security.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *, uint32, _Out_ void **, void *)'),
    securityInfo: security.func('uint32 __stdcall GetNamedSecurityInfoW(const char16_t *, int, uint32, _Out_ void **, void *, _Out_ void **, void *, _Out_ void **)'),
    handleSecurity: security.func('uint32 __stdcall GetSecurityInfo(void *, int, uint32, _Out_ void **, void *, _Out_ void **, void *, _Out_ void **)'),
    ace: security.func('int __stdcall GetAce(void *, uint32, _Out_ void **)'),
    mkdir: kernel.func('__stdcall', 'CreateDirectoryW', 'int', ['str16', koffi.pointer(attributes)]),
    open: kernel.func('void * __stdcall CreateFileW(const char16_t *, uint32, uint32, void *, uint32, uint32, void *)'),
    waitPipe: kernel.func('int __stdcall WaitNamedPipeW(const char16_t *, uint32)'),
    lock: kernel.func('__stdcall', 'LockFileEx', 'int', ['void *', 'uint32', 'uint32', 'uint32', 'uint32', koffi.inout(koffi.pointer(overlapped))]),
    move: kernel.func('int __stdcall MoveFileExW(const char16_t *, const char16_t *, uint32)'),
    fileAttributes: kernel.func('uint32 __stdcall GetFileAttributesW(const char16_t *)'),
  };
}

function failure(operation: string): PreviewError {
  return new PreviewError('CLEANUP_INCOMPLETE', `Windows ${operation} failed (${win().error()}).`);
}
function sidText(sid: unknown): string {
  const out = [null];
  if (!win().sidString(sid, out)) throw failure('SID inspection');
  try { return koffi.decode(out[0], 'char16_t', -1); }
  finally { win().free(out[0]); }
}
let identity: { user: string; owner: string } | undefined;
function currentIdentity() {
  if (identity) return identity;
  const token = [null];
  if (!win().openToken(win().current(), 0x0008, token)) throw failure('token inspection');
  try {
    const value = { user: '', owner: '' };
    for (const [key, type] of [['user', 1], ['owner', 4]] as const) {
      const length = [0];
      win().tokenInfo(token[0], type, null, 0, length);
      if (!length[0] || length[0] > 65_536) throw failure('token size');
      const buffer = Buffer.alloc(length[0]);
      if (!win().tokenInfo(token[0], type, buffer, buffer.length, length)) throw failure('token inspection');
      value[key] = sidText(koffi.decode(buffer, 'void *'));
    }
    return identity = value;
  } finally { win().close(token[0]); }
}

function privateStorageError(code: number): Error {
  if (code === 2 || code === 3) return Object.assign(new Error('Private storage path is missing.'), { code: 'ENOENT' });
  return new PreviewError('UNAUTHORIZED', `Cannot inspect private storage (${code}).`);
}

function restrictedAcl(dacl: unknown, label: string): number {
  if (!dacl) throw new PreviewError('UNAUTHORIZED', `${label} requires a restricted ACL.`);
  const allowed = [currentIdentity().user, 'S-1-5-18', 'S-1-5-32-544'];
  const count = koffi.decode(dacl, 4, 'uint16') as number;
  let inheritance = 0;
  for (let i = 0; i < count; i++) {
    const entry = [null];
    if (!win().ace(dacl, i, entry)) throw failure('ACL inspection');
    const header = Buffer.from(koffi.decode(entry[0], 'uint8', 4));
    // Accept only ordinary allow entries for known principals. Unknown ACE forms fail closed.
    if (header[0] !== 0 || header.readUInt16LE(2) < 16) throw new PreviewError('UNAUTHORIZED', `${label} has an unsupported ACL entry.`);
    const sid = sidText(koffi.address(entry[0]) + 8n);
    if (!allowed.includes(sid)) throw new PreviewError('UNAUTHORIZED', `${label} permits another account.`);
    if (!(header[1] & 0x04)) inheritance |= header[1] & 0x03; // OI/CI without NO_PROPAGATE.
  }
  return inheritance;
}

/** Authenticate the connected pipe's account boundary before giving that same handle to HTTP. */
export async function connectWindowsPipe(path: string, signal: AbortSignal): Promise<Socket> {
  const api = win();
  const adopt = api.procedure(api.module(null), 'uv_open_osfhandle');
  if (!adopt) throw new PreviewError('UNSUPPORTED_PLATFORM', 'This Node build cannot adopt a verified Windows pipe.');
  // OVERLAPPED and anonymous SQOS: the pipe server must never impersonate this client.
  let handle;
  for (;;) {
    signal.throwIfAborted();
    handle = api.open(path, 0xc0000000, 0, null, 3, 0x40000000 | 0x00100000, null);
    if (koffi.address(handle) !== 0xffffffffffffffffn) break;
    if (api.error() !== 231) throw failure('Docker pipe open');
    // ERROR_PIPE_BUSY: wait for a server instance before connecting. No HTTP bytes have been sent.
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      api.waitPipe.async(path, 15_000, (error: Error | null, ready: number) => {
        signal.removeEventListener('abort', abort);
        if (error || !ready) reject(error ?? new PreviewError('CLEANUP_INCOMPLETE', 'The local Docker pipe did not become available.'));
        else resolve();
      });
    });
  }
  let adopted = false;
  try {
    const owner = [null], dacl = [null], descriptor = [null];
    const result = api.handleSecurity(handle, 6, 0x1 | 0x4, owner, null, dacl, null, descriptor);
    if (result !== 0) throw new PreviewError('UNAUTHORIZED', `Cannot inspect connected Docker pipe (${result}).`);
    try {
      if (!owner[0] || ![currentIdentity().user, 'S-1-5-18', 'S-1-5-32-544'].includes(sidText(owner[0]))) {
        throw new PreviewError('UNAUTHORIZED', 'Docker pipe has an untrusted owner.');
      }
      restrictedAcl(dacl[0], 'Docker pipe');
    } finally { api.free(descriptor[0]); }
    // Use Node's exported libuv function, not another DLL's independent C runtime descriptor table.
    const fd = koffi.call(adopt, api.adoptPipe, handle) as number;
    if (fd < 0) throw new PreviewError('START_FAILED', 'The verified Docker pipe could not be adopted.');
    adopted = true;
    // libuv duplicates stdio descriptors and leaves the original open. Refuse that ownership exception.
    if (fd <= 2) { closeSync(fd); throw new PreviewError('START_FAILED', 'Docker pipe adoption requires open standard streams.'); }
    try { return new Socket({ fd, readable: true, writable: true }); }
    catch (error) { closeSync(fd); throw error; }
  } finally { if (!adopted) api.close(handle); }
}

/** Existing ACLs are validated, never silently repaired. SYSTEM and administrators retain OS authority. */
export function assertWindowsPrivate(path: string): void {
  const attributes = win().fileAttributes(path);
  if (attributes === 0xffffffff) throw privateStorageError(win().error());
  if (attributes & 0x400) throw new PreviewError('UNAUTHORIZED', 'Private storage must not contain a reparse point.');
  const owner = [null], dacl = [null], descriptor = [null];
  const result = win().securityInfo(path, 1, 0x00000001 | 0x00000004, owner, null, dacl, null, descriptor);
  if (result !== 0) throw privateStorageError(result);
  try {
    if (!owner[0] || !dacl[0]) throw new PreviewError('UNAUTHORIZED', 'Private storage requires an owner and a restricted ACL.');
    const account = currentIdentity(), actualOwner = sidText(owner[0]);
    // Elevated Windows tokens can create administrator-owned files. That group is already inside the ACL trust boundary.
    if (actualOwner !== account.user && !(actualOwner === account.owner && actualOwner === 'S-1-5-32-544')) {
      throw new PreviewError('UNAUTHORIZED', 'Private storage has an untrusted owner.');
    }
    const inheritance = restrictedAcl(dacl[0], 'Private storage');
    // Otherwise new children can fall back to the creator token's default DACL.
    if ((attributes & 0x10) && inheritance !== 0x03) throw new PreviewError('UNAUTHORIZED', 'Private directories must propagate restricted permissions to files and subdirectories.');
  } finally { win().free(descriptor[0]); }
}

export function makeWindowsPrivateDirectory(path: string): void {
  try {
    if (!lstatSync(path).isDirectory()) throw new PreviewError('UNAUTHORIZED', 'Private storage is not a directory.');
    assertWindowsPrivate(path);
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parent = dirname(path);
  // Existing parents need not be private (for example the user-selected project root).
  try { lstatSync(parent); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === path) throw error;
    makeWindowsPrivateDirectory(parent);
  }
  const descriptor = [null];
  const user = currentIdentity().user;
  const sddl = `O:${user}D:P(A;OICI;FA;;;${user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`;
  if (!win().descriptor(sddl, 1, descriptor, null)) throw failure('private descriptor creation');
  try {
    if (!win().mkdir(path, { length: koffi.sizeof(win().attributes), descriptor: descriptor[0], inherit: 0 }) && win().error() !== 183) throw failure('private directory creation');
  } finally { win().free(descriptor[0]); }
  assertWindowsPrivate(path);
}

/** Lock a sentinel byte beyond the bounded owner identifier; Node can still read/write the identifier. */
export function lockWindowsFile(path: string): () => void {
  assertWindowsPrivate(path);
  // OPEN_EXISTING, OPEN_REPARSE_POINT, share read/write but not delete. Never inherit this handle.
  const handle = win().open(path, 0xc0000000, 3, null, 3, 0x00200000, null);
  if (koffi.address(handle) === 0xffffffffffffffffn) throw failure('lock open');
  const offset = { internal: 0, internalHigh: 0, offset: 0xffffffff, offsetHigh: 0, event: null };
  if (!win().lock(handle, 3, 0, 1, 0, offset)) { // EXCLUSIVE | FAIL_IMMEDIATELY
    const code = win().error(); win().close(handle);
    if (code === 33) throw Object.assign(new Error('Lock is busy.'), { code: 'EAGAIN' });
    throw new PreviewError('CLEANUP_INCOMPLETE', `Windows lock failed (${code}).`);
  }
  return () => { if (!win().close(handle)) throw failure('lock close'); };
}

export function publishWindowsFile(from: string, to: string): void {
  // Same-directory replacement only. File data was flushed by the caller before this operation.
  if (dirname(from) !== dirname(to)) throw new PreviewError('CLEANUP_INCOMPLETE', 'Record publication must stay in its directory.');
  if (!win().move(from, to, 0x1 | 0x8)) throw failure('record publication');
}

export function windowsProcessStart(handle = win().current()): string {
  const creation = [0n], exit = [0n], kernel = [0n], user = [0n];
  if (!win().times(handle, creation, exit, kernel, user)) throw failure('process identity');
  return String(creation[0]);
}

export function createWindowsJob(pid: number, started: string) {
  const job = win().createJob(null, null);
  if (!job) throw failure('job creation');
  let assigned = false;
  try {
    const buffer = Buffer.alloc(koffi.sizeof(win().limits));
    koffi.encode(buffer, win().limits, { basic: { flags: 0x2000 } }); // KILL_ON_JOB_CLOSE; no breakaway flags.
    if (!win().setJob(job, 9, buffer, buffer.length)) throw failure('job limits');
    const processHandle = win().openProcess(0x0100 | 0x0001 | 0x1000, 0, pid);
    if (!processHandle) throw failure('supervisor open');
    try {
      if (windowsProcessStart(processHandle) !== started) throw new PreviewError('START_FAILED', 'The Windows supervisor identity changed.');
      if (!win().assignJob(job, processHandle)) throw failure('job assignment');
      assigned = true;
    } finally { win().close(processHandle); }
  } finally { if (!assigned) win().close(job); }
  let closed = false;
  return {
    contains(pid: number): boolean {
      if (closed) return false;
      const handle = win().openProcess(0x1000, 0, pid);
      if (!handle) return false;
      try {
        const inside = [0];
        if (!win().inJob(handle, job, inside)) throw failure('job membership');
        return Boolean(inside[0]);
      } finally { win().close(handle); }
    },
    async stop(): Promise<void> {
      if (closed) return;
      if (!win().terminateJob(job, 1)) throw failure('job termination');
      const deadline = performance.now() + 3000;
      do {
        // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: ActiveProcesses follows four LARGE_INTEGERs and two DWORDs.
        const accounting = Buffer.alloc(48);
        if (!win().queryJob(job, 1, accounting, accounting.length, null)) throw failure('job accounting');
        if (accounting.readUInt32LE(40) === 0) {
          if (!win().close(job)) throw failure('job close');
          closed = true; return;
        }
        await delay(25);
      } while (performance.now() < deadline);
      throw new PreviewError('CLEANUP_INCOMPLETE', 'Windows job processes have not all exited. Retry stop.');
    },
  };
}

export function assertWindowsListener(port: number, job: ReturnType<typeof createWindowsJob>): void {
  let found = false;
  for (const family of [2, 23]) { // AF_INET, AF_INET6; TCP_TABLE_OWNER_PID_LISTENER
    let table: Buffer | undefined;
    const length = [0];
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = win().tcp(table ?? null, length, 0, family, 3, 0);
      if (result === 0 && table) break;
      if (result !== 122 || length[0] > 16 * 1024 * 1024) throw failure('listener inspection');
      table = Buffer.alloc(length[0]);
      if (attempt === 2) throw failure('listener table changed');
    }
    if (!table || table.length < 4) throw failure('listener table');
    const count = table.readUInt32LE(0), stride = family === 2 ? 24 : 56;
    if (4 + count * stride > table.length) throw failure('listener table size');
    for (let i = 0; i < count; i++) {
      const row = table.subarray(4 + i * stride, 4 + (i + 1) * stride);
      const portOffset = family === 2 ? 8 : 20;
      if (row.readUInt16BE(portOffset) !== port) continue;
      found = true;
      const loopback = family === 2 ? row.subarray(4, 8).equals(Buffer.from([127, 0, 0, 1]))
        : row.subarray(0, 16).equals(Buffer.from('00000000000000000000000000000001', 'hex'));
      if (!loopback) throw new PreviewError('START_FAILED', `Native port ${port} has a non-loopback listener.`);
      if (!job.contains(row.readUInt32LE(family === 2 ? 20 : 52))) throw new PreviewError('START_FAILED', `Native port ${port} belongs to a process outside the owned group.`);
    }
  }
  if (!found) throw new PreviewError('START_FAILED', `No owned listener was observed on native port ${port}.`);
}
