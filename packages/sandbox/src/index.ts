export { ContainerManager } from './container-manager.js';
export { resolveCapabilities, canEscalate, isNetworkUpgrade, isWorkspaceUpgrade, getDefaults } from './config.js';
export { resolveMounts, toDockerBinds } from './mount-resolver.js';
export type { MountBind, ResolvedMounts } from './mount-resolver.js';
export { resolveNetworkMode, buildAllowlistScript, needsIptables, isValidDomain } from './network-policy.js';
export { isDockerAvailable, imageExists, getContainerIp, getContainerPorts, detectAppNetwork, connectToNetwork, getContainerIpOnNetwork } from './docker-client.js';
export * from './constants.js';
