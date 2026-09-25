import {
  ProjectId,
  type PrismModelPreference,
  type PrismRole,
  type ModelCapabilities,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import type { ProviderInstanceEntry } from "../../providerInstances";
import type { ModelEsque } from "../chat/providerIconUtils";
import { planScopedSettingsPatch } from "./scopedSettings";

export function prismModelKey(entry: Pick<PrismModelPreference, "instanceId" | "model">) {
  return JSON.stringify([entry.instanceId, entry.model]);
}

export function movePrismPreference(
  models: readonly PrismModelPreference[],
  index: number,
  direction: -1 | 1,
) {
  const destination = index + direction;
  if (index < 0 || index >= models.length || destination < 0 || destination >= models.length)
    return models;
  const next = [...models];
  [next[index], next[destination]] = [next[destination]!, next[index]!];
  return next;
}

export function prismEffortOptions(capabilities: ModelCapabilities | null | undefined) {
  const descriptor = capabilities?.optionDescriptors?.find(
    (option) =>
      option.type === "select" && ["effort", "reasoningEffort", "variant"].includes(option.id),
  );
  return descriptor?.type === "select"
    ? descriptor.options.filter((option) => !descriptor.promptInjectedValues?.includes(option.id))
    : [];
}

/** Project overrides store complete kits, while environment updates accept deep patches. */
export function planPrismModelsPatch(
  scope: Parameters<typeof planScopedSettingsPatch>[0],
  environments: Parameters<typeof planScopedSettingsPatch>[1],
  role: PrismRole,
  models: readonly PrismModelPreference[],
) {
  const plan = planScopedSettingsPatch(scope, environments, { prismRoles: { [role]: { models } } });
  return {
    ...plan,
    serverWrites: plan.serverWrites.map((write) => {
      const overrides = write.patch.projectSettingsOverrides;
      const settings = environments.find((env) => env.environmentId === write.environmentId)
        ?.serverConfig?.settings;
      if (!overrides || !settings) return write;
      return {
        ...write,
        patch: {
          ...write.patch,
          projectSettingsOverrides: Object.fromEntries(
            Object.entries(overrides).map(([id, override]) => {
              const roles = resolveProjectSettings(settings, ProjectId.make(id)).settings
                .prismRoles;
              return [
                id,
                { ...override, prismRoles: { ...roles, [role]: { ...roles[role], models } } },
              ];
            }),
          ),
        },
      };
    }),
  };
}

export function prismModelChoices(
  entries: readonly Pick<
    ProviderInstanceEntry,
    "instanceId" | "displayName" | "enabled" | "isAvailable" | "models"
  >[],
  options: ReadonlyMap<ProviderInstanceId, readonly ModelEsque[]>,
  disabledReason: (instanceId: ProviderInstanceId, model: string) => string | null,
) {
  return entries
    .filter((entry) => entry.enabled && entry.isAvailable)
    .flatMap((entry) =>
      (options.get(entry.instanceId) ?? [])
        .filter((model) => !model.isUnavailable && !disabledReason(entry.instanceId, model.slug))
        .map((model) => ({
          preference: { instanceId: entry.instanceId, model: model.slug },
          label: `${entry.displayName} / ${model.name}`,
          efforts: prismEffortOptions(
            entry.models.find((candidate) => candidate.slug === model.slug)?.capabilities,
          ),
        })),
    );
}
