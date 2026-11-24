import { useEffect, useMemo, useRef, useState } from 'react';
import {
  validatePluginConfigValue,
  type PluginConfigScalarField,
  type PluginConfigSchemaField,
  type PluginConfigValue,
} from '@lesliechan721/aw-plugin-core';

import type { ConfigSuggestionsResponseV1 } from '../utils/plugin-config-suggestions.js';
import type { TuiController } from './controller.js';
import type { ConfigProfileOptions } from './model.js';
import type { ConfigReferenceDraft } from './config-references.js';
import { safeConfigText } from './config-value-presentation.js';

export interface ConfigSuggestionLookup {
  pluginId: string;
  options: ConfigProfileOptions;
  fieldPath: (string | number)[];
  dependencyValues?: Record<string, PluginConfigValue>;
  draftLayers?: { common?: ConfigReferenceDraft; platform?: ConfigReferenceDraft };
  draftValues?: Record<string, PluginConfigValue>;
}

export function configSuggestionScalar(
  definition: PluginConfigSchemaField | undefined,
): PluginConfigScalarField | undefined {
  if (!definition || definition.type === 'array' || definition.type === 'object') return undefined;
  return 'suggestions' in definition && definition.suggestions ? definition : undefined;
}

const EMPTY_SUGGESTIONS: ConfigSuggestionsResponseV1['items'] = [];

export function useConfigSuggestions(
  controller: TuiController, frameId: string, lookup: ConfigSuggestionLookup | undefined,
  definition: PluginConfigScalarField | undefined,
): {
  items: ConfigSuggestionsResponseV1['items'];
  notice?: string;
  refresh: () => void;
} {
  const key = lookup ? JSON.stringify([frameId, lookup]) : undefined;
  const [refresh, setRefresh] = useState<{ key: string; id: number }>();
  const refreshId = refresh?.key === key ? refresh?.id : undefined;
  const [result, setResult] = useState<{
    key: string;
    refreshId?: number;
    response: ConfigSuggestionsResponseV1;
  }>();
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    if (key === undefined) return;
    const [, current] = JSON.parse(key) as [string, ConfigSuggestionLookup];
    const abort = new AbortController();
    request.current = abort;
    void controller.getConfigSuggestions(current, refreshId !== undefined, abort.signal).then((response) => {
      if (!abort.signal.aborted && request.current === abort) setResult({ key, refreshId, response });
    }).catch(() => {
      if (!abort.signal.aborted && request.current === abort) {
        setResult({ key, refreshId, response: { schemaVersion: 1, status: 'unavailable', items: [] } });
      }
    });
    return () => abort.abort();
  }, [controller, key, refreshId]);
  const response = result?.key === key && result?.refreshId === refreshId ? result?.response : undefined;
  // A provider cache entry may be shared by fields with different scalar constraints.
  const items = useMemo(() => {
    if (response?.status !== 'ok' || !definition) return EMPTY_SUGGESTIONS;
    const validItems = response.items.filter((item) => validatePluginConfigValue(definition, item.value).length === 0);
    return validItems.length ? validItems : EMPTY_SUGGESTIONS;
  }, [response, definition]);
  return {
    items,
    notice: key === undefined ? undefined : !response ? '正在获取动态建议…'
      : response.status === 'ok' && items.length > 0 ? undefined
      : (response.message && safeConfigText(response.message)) || (response.status === 'ok'
        ? '没有动态建议，可使用自定义值。' : '暂时无法获取动态建议，可使用自定义值。'),
    refresh: () => {
      if (key === undefined) return;
      request.current?.abort();
      setRefresh({ key, id: (refreshId ?? 0) + 1 });
    },
  };
}
