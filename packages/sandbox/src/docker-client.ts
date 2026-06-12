import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
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
  } catch {
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
}

export async function createContainer(opts: CreateContainerOpts): Promise<string> {
  const docker = getDocker(opts.socketPath);

  const memBytes = opts.memoryMb * 1024 * 1024;

  const container = await docker.createContainer({
    name: opts.name,
    Image: opts.image,
    Cmd: ['sleep', 'infinity'],
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
    },
    User: '1000:1000',
  });

  await container.start();
  return container.id;
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
