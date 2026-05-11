/**
 * @agw/schemas — Zod validation schemas for configuration.
 *
 * Separated from @agw/types so that packages needing only TypeScript
 * interfaces don't take a runtime dependency on zod.
 */

export {
  cliPluginSchema,
  httpEndpointSchema,
  httpPluginSchema,
  openAPIServiceSchema,
  pluginsSchema,
} from './plugins.js';
