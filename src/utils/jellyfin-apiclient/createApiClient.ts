import { ApiClient } from 'jellyfin-apiclient';

import { safeDecodeURIComponent } from 'utils/url';

/**
 * Encodes a value for use as a parameter when creating the ApiClient.
 * Ensuring that it is properly decoded before encoding to avoid double-encoding issues.
 * (In case a webview passes an already encoded value for example.)
 */
const encodeParam = (value: string) => encodeURIComponent(safeDecodeURIComponent(value));

// An item page asks for its item from several places at once (the page itself, plugins such as
// Jellyfin Enhanced): calls for the same item this close together share one request, each caller
// getting its own copy. Short enough that a poll (the loading version picker asks every second)
// still sees fresh data.
const SHARED_ITEM_WINDOW_MS = 500;

function shareItemRequests(apiClient: ApiClient) {
    const getItem = apiClient.getItem.bind(apiClient);
    const recent = new Map<string, { at: number, promise: ReturnType<typeof getItem> }>();

    apiClient.getItem = (userId: string, itemId: string) => {
        const key = `${userId}:${itemId}`;
        const now = Date.now();
        let entry = recent.get(key);
        if (!entry || now - entry.at > SHARED_ITEM_WINDOW_MS) {
            const promise = getItem(userId, itemId);
            entry = { at: now, promise };
            recent.set(key, entry);
            promise.catch(() => recent.delete(key));
            for (const [k, e] of recent) {
                if (now - e.at > SHARED_ITEM_WINDOW_MS) recent.delete(k);
            }
        }
        // Plain JSON from the server: a JSON round trip is a full copy.
        return entry.promise.then(item => JSON.parse(JSON.stringify(item)));
    };

    return apiClient;
}

/** Creates a new ApiClient instance with the provided parameters, encoding them as needed. */
export function createApiClient(
    serverUrl: string,
    appName: string,
    appVersion: string,
    deviceName: string,
    deviceId: string
) {
    return shareItemRequests(new ApiClient(
        serverUrl,
        encodeParam(appName),
        encodeParam(appVersion),
        encodeParam(deviceName),
        encodeParam(deviceId)
    ));
}
