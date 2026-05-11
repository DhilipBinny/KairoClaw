// Re-export from @agw/plugins — backward compatible
export {
  registerAllPlugins,
  reloadPlugins,
  registerCliPlugins,
  registerHttpPlugins,
  importOpenAPIService,
  importAllOpenAPIServices,
  setOpenAPILogger,
  loadPlugins,
  savePlugins,
  detectBase64Image,
  sniffBase64Mime,
  extFromContentType,
} from '@agw/plugins';

export type {
  PluginToolRegistry,
  PluginSecretsResolver,
  PluginMediaStore,
} from '@agw/plugins';
