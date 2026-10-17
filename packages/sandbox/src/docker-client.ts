import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { CONTAINER_LABEL_KEY, MAX_STDOUT, MAX_STDERR } from './constants.js';
import type { SandboxExecResult } from '@agw/types';

const dockerInstances = new Map<string, Docker>();

export function getDocker(socketPath: string): Docker {
  let instance = dockerInstances.get(socketPath);
  if (!instance) {
    instance = new Docker({ socketPath });
    dockerInstances.set(socketPath, instance);
  }
  return instance;
}

export function resetDocker(): void {
  dockerInstances.clear();
}

export async function isDockerAvailable(socketPath: string): Promise<boolean> {
  try {
    const docker = getDocker(socketPath);
    await docker.ping();
    return true;
  } catch (err) {
    console.warn('[sandbox] Docker ping failed:', (err as Error).message);
    return false;
  }
}

export async function imageExists(socketPath: string, imageName: string): Promise<boolean> {
  try {
    const docker = getDocker(socketPath);
    await docker.getImage(imageName).inspect();
    return true;
  } catch {
    return false;
  }
}

export interface CreateContainerOpts {
  socketPath: string;
  name: string;
  image: string;
  binds: string[];
  workdir: string;
  networkMode: string;
  labels: Record<string, string>;
  cpu: number;
  memoryMb: number;
  pidsLimit: number;
  /** /dev/shm size in bytes. Desktop containers need 256MB+ for Chrome. */
  shmSize?: number;
  /** Override the image's CMD. If omitted, the image's default CMD is used. */
  cmd?: string[];
  /** Port bindings for host access. Keys are container ports like '6080/tcp'. */
  portBindings?: Record<string, { HostIp?: string; HostPort?: string }[]>;
}

export async function createContainer(opts: CreateContainerOpts): Promise<string> {
  const docker = getDocker(opts.socketPath);

  const memBytes = opts.memoryMb * 1024 * 1024;

  const exposedPorts: Record<string, Record<string, never>> = {};
  if (opts.portBindings) {
    for (const port of Object.keys(opts.portBindings)) {
      exposedPorts[port] = {};
    }
  }

  const containerConfig: Record<string, unknown> = {
    name: opts.name,
    Image: opts.image,
    WorkingDir: opts.workdir,
    Labels: opts.labels,
    Tty: false,
    OpenStdin: false,
    Env: [
      'HOME=/home/sandbox',
      'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'LANG=C.UTF-8',
      'NODE_ENV=production',
      'TERM=xterm',
    ],
    HostConfig: {
      Init: true,
      Binds: opts.binds,
      NetworkMode: opts.networkMode,
      NanoCpus: Math.floor(opts.cpu * 1e9),
      Memory: memBytes,
      MemorySwap: memBytes,
      PidsLimit: opts.pidsLimit,
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      CapAdd: [],
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,size=268435456',
        '/var/tmp': 'rw,noexec,nosuid,size=134217728',
      },
      ReadonlyRootfs: false,
      OomScoreAdj: 500,
      Ulimits: [
        { Name: 'nofile', Soft: 1024, Hard: 4096 },
        { Name: 'core', Soft: 0, Hard: 0 },
      ],
      ...(opts.shmSize ? { ShmSize: opts.shmSize } : {}),
      ...(opts.portBindings ? { PortBindings: opts.portBindings } : {}),
    },
    User: '1000:1000',
  };

  if (opts.cmd) {
    containerConfig.Cmd = opts.cmd;
  }
  if (Object.keys(exposedPorts).length > 0) {
    containerConfig.ExposedPorts = exposedPorts;
  }

  const container = await docker.createContainer(containerConfig as any);

  await container.start();
  return container.id;
}

export async function getContainerPorts(socketPath: string, containerId: string): Promise<Record<string, number>> {
  const docker = getDocker(socketPath);
  const container = docker.getContainer(containerId);
  const info = await container.inspect();
  const ports = info.NetworkSettings?.Ports || {};
  const result: Record<string, number> = {};
  for (const [containerPort, bindings] of Object.entries(ports)) {
    if (Array.isArray(bindings) && bindings.length > 0) {
      const hostPort = parseInt((bindings[0] as any).HostPort, 10);
      if (!isNaN(hostPort)) {
        result[containerPort] = hostPort;
      }
    }
  }
  return result;
}

export async function detectAppNetwork(socketPath: string): Promise<string | null> {
  try {
    if (!existsSync('/.dockerenv')) return null;
    const docker = getDocker(socketPath);
    const hn = hostname();
    const container = docker.getContainer(hn);
    const info = await container.inspect();
    const networks = info.NetworkSettings?.Networks;
    if (networks) {
      for (const name of Object.keys(networks)) {
        if (name !== 'bridge' && name !== 'host' && name !== 'none') return name;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function connectToNetwork(socketPath: string, containerId: string, networkName: string): Promise<void> {
  const docker = getDocker(socketPath);
  const network = docker.getNetwork(networkName);
  await network.connect({ Container: containerId });
}

export async function getContainerIpOnNetwork(socketPath: string, containerId: string, networkName: string): Promise<string | null> {
  try {
    const docker = getDocker(socketPath);
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    const net = info.NetworkSettings?.Networks?.[networkName];
    return (net as any)?.IPAddress || null;
  } catch {
    return null;
  }
}

export async function getContainerIp(socketPath: string, containerId: string): Promise<string | null> {
  try {
    const docker = getDocker(socketPath);
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    const networks = info.NetworkSettings?.Networks;
    if (networks) {
      for (const net of Object.values(networks)) {
        if ((net as any).IPAddress) return (net as any).IPAddress;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function execInContainer(
  socketPath: string,
  containerId: string,
  command: string,
  workdir: string,
  timeoutMs: number,
): Promise<SandboxExecResult> {
  const docker = getDocker(socketPath);
  const container = docker.getContainer(containerId);

  const exec = await container.exec({
    Cmd: ['/bin/sh', '-c', command],
    WorkingDir: workdir,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  return new Promise<SandboxExecResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let done = false;

    const cleanup = () => { stdoutStream.destroy(); stderrStream.destroy(); };

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        stream.destroy();
        cleanup();
        resolve({ exitCode: 124, stdout: stdout.slice(0, MAX_STDOUT), stderr: 'Command timed out' });
      }
    }, timeoutMs);

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    const stdoutBuf: Buffer[] = [];
    const stderrBuf: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    const bufferCap = MAX_STDOUT * 2;

    stdoutStream.on('data', (chunk: Buffer) => {
      if (stdoutSize < bufferCap) {
        stdoutBuf.push(chunk);
        stdoutSize += chunk.length;
      }
    });
    stderrStream.on('data', (chunk: Buffer) => {
      if (stderrSize < bufferCap) {
        stderrBuf.push(chunk);
        stderrSize += chunk.length;
      }
    });

    docker.modem.demuxStream(stream, stdoutStream, stderrStream);

    stream.on('end', async () => {
      if (done) return;
      done = true;
      clearTimeout(timer);

      stdout = Buffer.concat(stdoutBuf).toString('utf8');
      stderr = Buffer.concat(stderrBuf).toString('utf8');

      const truncatedStdout = stdout.length > MAX_STDOUT
        ? stdout.slice(0, MAX_STDOUT) + `\n[... output truncated, ${Math.round(stdout.length / 1024)}KB total]`
        : stdout;
      const truncatedStderr = stderr.length > MAX_STDERR
        ? stderr.slice(0, MAX_STDERR) + `\n[... stderr truncated, ${Math.round(stderr.length / 1024)}KB total]`
        : stderr;

      try {
        const info = await exec.inspect();
        resolve({
          exitCode: info.ExitCode ?? 1,
          stdout: truncatedStdout,
          stderr: truncatedStderr,
        });
      } catch {
        resolve({
          exitCode: 1,
          stdout: truncatedStdout,
          stderr: truncatedStderr,
        });
      }
    });

    stream.on('error', (err: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
  });
}

export async function removeContainer(socketPath: string, containerId: string): Promise<void> {
  try {
    const docker = getDocker(socketPath);
    const container = docker.getContainer(containerId);
    try {
      await container.stop({ t: 5 });
    } catch {
      // already stopped
    }
    await container.remove({ force: true });
  } catch {
    // already removed
  }
}

export async function listSandboxContainers(
  socketPath: string,
): Promise<Array<{ id: string; name: string; state: string; labels: Record<string, string> }>> {
  const docker = getDocker(socketPath);
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [CONTAINER_LABEL_KEY] },
  });
  return containers.map(c => ({
    id: c.Id,
    name: (c.Names[0] ?? '').replace(/^\//, ''),
    state: c.State,
    labels: c.Labels,
  }));
}
