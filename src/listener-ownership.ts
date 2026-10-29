import { execFile } from 'node:child_process';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { endianness } from 'node:os';

// The supervisor imports this module. Keep it to Node built-ins: an embedder may install it for another user.

export type ListenerResult = 'owned' | 'missing' | 'non-loopback' | 'foreign' | 'unavailable';

/**
 * Classifies the TCP listeners on `port` from the target's own user: `owned` when every one binds loopback,
 * belongs to `target` or a descendant, and one of them binds 127.0.0.1, where the owner connects. It needs
 * no other user's processes, `ps` from others, or root. It reads this process's network namespace.
 */
export async function listenerOwnership(target: number, port: number): Promise<ListenerResult> {
  try { return process.platform === 'linux' ? await fromProc(target, port) : await fromLsof(target, port); }
  catch { return 'unavailable'; }
}

/** Linux: socket tables and descriptors from /proc, which `hidepid` and ProtectProc=invisible leave readable for own processes. */
async function fromProc(target: number, port: number): Promise<ListenerResult> {
  const listeners = new Map<string, boolean>();
  let ipv4 = false;
  for (const [table, bytes] of [['tcp', 4], ['tcp6', 16]] as const) {
    let rows: string;
    try { rows = await readFile(`/proc/self/net/${table}`, 'utf8'); }
    catch (error) { if (table === 'tcp6' && (error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const row of rows.split('\n').slice(1)) {
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
      const fields = row.trim().split(/\s+/);
      if (fields.length < 10 || fields[3] !== '0A') continue;
      const [address, hexPort] = fields[1].split(':');
      if (Number.parseInt(hexPort, 16) !== port) continue;
      listeners.set(fields[9], isLoopback(address, bytes));
      if (bytes === 4 && isLoopback(address, bytes)) ipv4 = true;
    }
  }
  if (!listeners.size) return 'missing';
  if ([...listeners.values()].includes(false)) return 'non-loopback';
  const held = new Set<string>();
  for (const pid of await descendants(target, procParents)) {
    let descriptors: string[];
    try { descriptors = await readdir(`/proc/${pid}/fd`); } catch { continue; }
    for (const descriptor of descriptors) {
      const socket = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${descriptor}`).catch(() => ''));
      if (socket) held.add(socket[1]);
    }
  }
  if (![...listeners.keys()].every(inode => held.has(inode))) return 'foreign';
  return ipv4 ? 'owned' : 'missing';
}

/** /proc/net prints each 32-bit address word in host byte order. Only 127.0.0.1 and ::1 count. */
function isLoopback(hex: string, bytes: 4 | 16): boolean {
  if (hex.length !== bytes * 2) return false;
  const address = Buffer.alloc(bytes);
  for (let offset = 0; offset < bytes; offset += 4) {
    const word = Number.parseInt(hex.slice(offset * 2, offset * 2 + 8), 16);
    if (endianness() === 'LE') address.writeUInt32LE(word, offset); else address.writeUInt32BE(word, offset);
  }
  return address.equals(bytes === 4 ? Buffer.from([127, 0, 0, 1]) : Buffer.from('00000000000000000000000000000001', 'hex'));
}

async function procParents(): Promise<Array<[number, number]>> {
  const pairs: Array<[number, number]> = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => undefined);
    // pid (comm) state ppid ...; comm may contain spaces and parentheses.
    const parent = stat ? Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) : NaN;
    if (Number.isInteger(parent)) pairs.push([Number(name), parent]);
  }
  return pairs;
}

/**
 * macOS: lsof and ps as the target's user. lsof cannot see another user's sockets, so only an owned
 * 127.0.0.1 listener proves that no other user holds the address the owner connects to.
 */
async function fromLsof(target: number, port: number): Promise<ListenerResult> {
  let output: string;
  try { output = await run(process.platform === 'darwin' ? '/usr/sbin/lsof' : '/usr/bin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn']); }
  catch (error) {
    // lsof exits 1 without output when nothing matches.
    if ((error as { code?: unknown }).code === 1 && !(error as { stdout?: string }).stdout) return 'missing';
    throw error;
  }
  const listeners: Array<{ pid: number; address: string }> = [];
  let pid: number | undefined;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) listeners.push({ pid, address: line.slice(1) });
  }
  if (!listeners.length) return 'missing';
  if (listeners.some(({ address }) => address !== `127.0.0.1:${port}` && address !== `[::1]:${port}`)) return 'non-loopback';
  const owned = await descendants(target, async () => (await run('/bin/ps', ['-axo', 'pid=,ppid='])).trim().split('\n')
    .map(row => row.trim().split(/\s+/).map(Number) as [number, number]));
  if (!listeners.every(({ pid }) => owned.has(pid))) return 'foreign';
  return listeners.some(({ address }) => address === `127.0.0.1:${port}`) ? 'owned' : 'missing';
}

async function descendants(target: number, parents: () => Promise<Array<[number, number]>>): Promise<Set<number>> {
  const children = new Map<number, number[]>();
  for (const [pid, parent] of await parents()) children.set(parent, [...(children.get(parent) ?? []), pid]);
  const owned = new Set([target]);
  for (const pid of owned) for (const child of children.get(pid) ?? []) owned.add(child);
  return owned;
}

function run(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(executable, args, { timeout: 2_000, maxBuffer: 4 * 1024 * 1024, env: { LC_ALL: 'C' } },
    (error, stdout) => error ? reject(Object.assign(error, { stdout })) : resolve(stdout)));
}
