import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { CONTAINER_LABEL_KEY, MAX_STDOUT, MAX_STDERR } from './constants.js';
import type { SandboxExecResult } from '@agw/types';

let dockerInstance: Docker | null = null;

export function getDocker(socketPath: string): Docker {
  if (!dockerInstance) {
    dockerInstance = new Docker({ socketPath });
  }
  return dockerInstance;
}

export function resetDocker(): void {
  dockerInstance = null;
}

/**
 * Check if Docker daemon is reachable.
 */
export async function isDockerAvailable(socketPath: string): Promise<boolean> {
  try {
    const docker = getDocker(socketPath);
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an image exists locally.
 */
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

/**
 * Create and start a sandbox container.
 */
export async function createContainer(opts: CreateContainerOpts): Promise<string> {
  const docker = getDocker(opts.socketPath);

  const container = await docker.createContainer({
    name: opts.name,
    Image: opts.image,
    Cmd: ['sleep', 'infinity'],
    WorkingDir: opts.workdir,
    Labels: opts.labels,
    Tty: false,
    OpenStdin: false,
    HostConfig: {
      Binds: opts.binds,
      NetworkMode: opts.networkMode,
      NanoCpus: Math.floor(opts.cpu * 1e9),
      Memory: opts.memoryMb * 1024 * 1024,
      PidsLimit: opts.pidsLimit,
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID', 'NET_BIND_SERVICE'],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=268435456' },
      ReadonlyRootfs: false,
    },
    User: '1000:1000',
  });

  await container.start();
  return container.id;
}

/**
 * Execute a command inside a running container.
 */
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

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        stream.destroy();
        resolve({ exitCode: 124, stdout: stdout.slice(0, MAX_STDOUT), stderr: 'Command timed out' });
      }
    }, timeoutMs);

    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    const stdoutBuf: Buffer[] = [];
    const stderrBuf: Buffer[] = [];

    stdoutStream.on('data', (chunk: Buffer) => stdoutBuf.push(chunk));
    stderrStream.on('data', (chunk: Buffer) => stderrBuf.push(chunk));

    docker.modem.demuxStream(stream, stdoutStream, stderrStream);

    stream.on('end', async () => {
      if (done) return;
      done = true;
      clearTimeout(timer);

      stdout = Buffer.concat(stdoutBuf).toString('utf8');
      stderr = Buffer.concat(stderrBuf).toString('utf8');

      try {
        const info = await exec.inspect();
        resolve({
          exitCode: info.ExitCode ?? 1,
          stdout: stdout.slice(0, MAX_STDOUT),
          stderr: stderr.slice(0, MAX_STDERR),
        });
      } catch {
        resolve({
          exitCode: 1,
          stdout: stdout.slice(0, MAX_STDOUT),
          stderr: stderr.slice(0, MAX_STDERR),
        });
      }
    });

    stream.on('error', (err: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Stop and remove a container.
 */
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

/**
 * List all sandbox containers managed by KairoClaw.
 */
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

