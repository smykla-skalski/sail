import corpus from './model-routing-corpus.json' with { type: 'json' };
import { hasUnresolvedModelAlias } from './cross-validation.ts';
import { shipRiskLevels, type ShipRisk } from './ship-risk-policy.ts';

export const modelRouteRoles = [
  'exploration',
  'implementation',
  'debugging',
  'review',
  'ci-triage',
] as const;
export type ModelRouteRole = (typeof modelRouteRoles)[number];
export type ModelRoute = {
  role: ModelRouteRole;
  risk: ShipRisk;
  provider: 'claude' | 'codex' | 'opencode';
  model: string;
  variant?: string;
};
export type ModelRoutingSettings = {
  routes: ModelRoute[];
  independentReviewRisks: ShipRisk[];
};
export type ModelRouteRequest = {
  role: ModelRouteRole;
  risk: ShipRisk;
  implementingModels?: string[];
};
export type ModelRouteSelection = {
  route: ModelRoute | null;
  independentReviewRequired: boolean;
  reason: string | null;
};

export const modelRoutingSettingsKey = 'sai-model-routing';

const providers = new Set(['claude', 'codex', 'opencode']);
const risks = new Set<string>(shipRiskLevels);
const roles = new Set<string>(modelRouteRoles);

function isRole(value: unknown): value is ModelRouteRole {
  return typeof value === 'string' && roles.has(value);
}

function isRisk(value: unknown): value is ShipRisk {
  return typeof value === 'string' && risks.has(value);
}

function isModelRoute(value: unknown): value is ModelRoute {
  return (
    !!value &&
    typeof value === 'object' &&
    'role' in value &&
    isRole(value.role) &&
    'risk' in value &&
    isRisk(value.risk) &&
    'provider' in value &&
    typeof value.provider === 'string' &&
    providers.has(value.provider) &&
    'model' in value &&
    typeof value.model === 'string' &&
    !!value.model.trim() &&
    (!('variant' in value) || value.variant === undefined || typeof value.variant === 'string')
  );
}

function normalizedModel(value: string): string {
  return value.slice(value.indexOf(':') + 1).toLowerCase();
}

export function parseModelRoutingSettings(raw: string | null): ModelRoutingSettings {
  if (raw === null) return { routes: [], independentReviewRisks: [] };
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object') throw new Error('Invalid settings');
    if (!('routes' in value) || !Array.isArray(value.routes)) throw new Error('Invalid routes');
    if (!value.routes.every(isModelRoute)) throw new Error('Invalid route');
    const routes = value.routes;
    if (
      'independentReviewRisks' in value &&
      (!Array.isArray(value.independentReviewRisks) || !value.independentReviewRisks.every(isRisk))
    )
      throw new Error('Invalid review risks');
    const deduplicated = new Map(routes.map((route) => [`${route.role}\0${route.risk}`, route]));
    const independentReviewRisks: ShipRisk[] =
      'independentReviewRisks' in value && Array.isArray(value.independentReviewRisks)
        ? [...new Set(value.independentReviewRisks.filter(isRisk))]
        : routes.length > 0
          ? ['medium', 'high']
          : [];
    return { routes: [...deduplicated.values()], independentReviewRisks };
  } catch {
    return { routes: [], independentReviewRisks: [...shipRiskLevels] };
  }
}

export function selectModelRoute(
  settings: ModelRoutingSettings,
  request: ModelRouteRequest,
): ModelRouteSelection {
  const independentReviewRequired = settings.independentReviewRisks.includes(request.risk);
  const route = settings.routes.find(
    (candidate) => candidate.role === request.role && candidate.risk === request.risk,
  );
  if (!route)
    return {
      route: null,
      independentReviewRequired,
      reason:
        settings.routes.length === 0 && !independentReviewRequired
          ? null
          : `No ${request.risk}-risk ${request.role} model route is configured.`,
    };
  if (hasUnresolvedModelAlias(route.model))
    return {
      route: null,
      independentReviewRequired,
      reason: `The ${request.role} route must use an exact model ID, not ${route.model}.`,
    };
  if (route.provider === 'opencode' && !route.model.includes(':'))
    return {
      route: null,
      independentReviewRequired,
      reason: 'OpenCode routes require an exact provider:model ID.',
    };
  if (request.role !== 'review' && independentReviewRequired) {
    const review = settings.routes.find(
      (candidate) => candidate.role === 'review' && candidate.risk === request.risk,
    );
    if (
      !review ||
      hasUnresolvedModelAlias(review.model) ||
      normalizedModel(review.model) === normalizedModel(route.model)
    )
      return {
        route: null,
        independentReviewRequired,
        reason: `${request.risk}-risk ${request.role} work requires an exact independent review route.`,
      };
  }
  if (
    request.role === 'review' &&
    independentReviewRequired &&
    (request.implementingModels ?? []).some(
      (model) =>
        hasUnresolvedModelAlias(model) || normalizedModel(model) === normalizedModel(route.model),
    )
  )
    return {
      route: null,
      independentReviewRequired,
      reason:
        'Independent review requires an exact model different from every implementation model.',
    };
  return { route, independentReviewRequired, reason: null };
}

export type RoutingEvaluation = {
  revision: string;
  accepted: number;
  acceptedTotal: number;
  failuresPrevented: number;
  failureTotal: number;
};

export function evaluateModelRouting(settings: ModelRoutingSettings): RoutingEvaluation {
  const accepted = corpus.acceptedTasks.filter(
    (task) =>
      isRole(task.role) &&
      isRisk(task.risk) &&
      selectModelRoute(settings, {
        role: task.role,
        risk: task.risk,
        implementingModels: 'implementingModels' in task ? task.implementingModels : undefined,
      }).route,
  ).length;
  const failuresPrevented = corpus.failureCases.filter((failure) => {
    if (!isRole(failure.role) || !isRisk(failure.risk)) return false;
    const route = settings.routes.find(
      (candidate) => candidate.role === failure.role && candidate.risk === failure.risk,
    );
    if (!route) return true;
    const candidate = { ...route, model: failure.model };
    const next = {
      ...settings,
      routes: settings.routes.map((item) => (item === route ? candidate : item)),
    };
    return !selectModelRoute(next, {
      role: failure.role,
      risk: failure.risk,
      implementingModels: 'implementingModels' in failure ? failure.implementingModels : undefined,
    }).route;
  }).length;
  return {
    revision: corpus.revision,
    accepted,
    acceptedTotal: corpus.acceptedTasks.length,
    failuresPrevented,
    failureTotal: corpus.failureCases.length,
  };
}
