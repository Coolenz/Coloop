import type { ProviderConfig } from '../../shared/contracts'
import type { ModelPricing } from '../../shared/model-usage'

/** Resolved once for a run. An unavailable configured decision model is not a
 * reason to silently select another provider. */
export interface DecisionModelRoute {
  provider: ProviderConfig
  apiKey: string
  role: 'default' | 'decision'
  pricing: ModelPricing
}
