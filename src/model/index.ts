/**
 * Pikiclaw "Model" layer — barrel export.
 *
 * The Model layer is one of the four physical layers in pikiclaw's
 * architecture (Terminal / Agent / **Model** / Tool). It centralises:
 *   - Provider/Profile data model (types.ts)
 *   - Read-only catalog of providers/models from models.dev (catalog.ts)
 *   - Persistence (store.ts) over ~/.pikiclaw/setting.json
 *   - Feishu-style credential validation (validation.ts)
 *   - Per-agent credential injection at spawn time (injector.ts)
 *
 * Adding a new agent driver only needs to:
 *   1. Define a new AgentInjector entry in injector.ts
 *   2. Read `resolveAgentInjection(agentId)` before spawning
 */

export type {
  ProviderKind, ProviderConfig, ProviderValidationStatus,
  ModelProfileConfig, ModelLayerConfig,
  ModelsDevCatalog, ModelsDevProvider, ModelsDevModel,
} from './types.js';

export {
  getModelsDevCatalog, getCatalogProvider, getCatalogModel, searchCatalogProviders,
} from './catalog.js';

export {
  listProviders, getProvider, addProvider, updateProvider, removeProvider, setProviderValidation,
  listProfiles, getProfile, addProfile, updateProfile, removeProfile,
  getActiveProfileId, getActiveProfile, setActiveProfile,
  type AddProviderInput, type UpdateProviderInput,
  type AddProfileInput, type UpdateProfileInput,
} from './store.js';

export { validateProvider, type ProviderValidationResult } from './validation.js';

export {
  resolveAgentInjection, isAgentBoundToProfile,
  type InjectedSpawnConfig,
} from './injector.js';

export {
  getProviderModelList, invalidateProviderModels,
  peekProviderModelList, peekProviderModelInfo, prefetchProviderModels,
} from './provider-models.js';
