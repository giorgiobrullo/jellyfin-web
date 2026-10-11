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
const SHARED_ITEM_WINDOW_MS = 800;

// An item asked for ahead of its page (the pointer resting on its card): the page's own request
// takes it, once, instead of waiting for the server. Dropped after a while, and on any change
// made through the client, so a page never shows an item older than that.
const PREFETCHED_ITEM_TTL_MS = 15000;

function shareItemRequests(apiClient: ApiClient) {
    const getItem = apiClient.getItem.bind(apiClient);
    const recent = new Map<string, { at: number, promise: ReturnType<typeof getItem> }>();
    const prefetched = new Map<string, { at: number, promise: ReturnType<typeof getItem> }>();

    const takePrefetched = (key: string, now: number) => {
        const entry = prefetched.get(key);
        prefetched.delete(key);
        return entry && now - entry.at <= PREFETCHED_ITEM_TTL_MS ? entry.promise : null;
    };

    apiClient.getItem = (userId: string, itemId: string) => {
        const key = `${userId}:${itemId}`;
        const now = Date.now();
        let entry = recent.get(key);
        if (!entry || now - entry.at > SHARED_ITEM_WINDOW_MS) {
            const promise = takePrefetched(key, now) || getItem(userId, itemId);
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

    apiClient.prefetchItem = (userId: string, itemId: string) => {
        const key = `${userId}:${itemId}`;
        const now = Date.now();
        const shared = recent.get(key);
        const entry = prefetched.get(key);
        if (shared && now - shared.at <= SHARED_ITEM_WINDOW_MS) {
            return shared.promise;
        }
        if (entry && now - entry.at <= PREFETCHED_ITEM_TTL_MS) {
            return entry.promise;
        }
        const promise = getItem(userId, itemId);
        prefetched.set(key, { at: now, promise });
        promise.catch(() => prefetched.delete(key));
        for (const [k, e] of prefetched) {
            if (now - e.at > PREFETCHED_ITEM_TTL_MS) prefetched.delete(k);
        }
        return promise;
    };

    const fetch = apiClient.fetch.bind(apiClient);
    apiClient.fetch = (request: { type?: string }, includeAuthorization?: boolean) => {
        if (request?.type && request.type.toUpperCase() !== 'GET') {
            prefetched.clear();
        }
        return fetch(request, includeAuthorization);
    };

    // Several parts of the app ask for the signed-in user at start-up, before the first answer is
    // cached: they share the request in flight.
    const getCurrentUser = apiClient.getCurrentUser.bind(apiClient);
    let currentUserInFlight: ReturnType<typeof getCurrentUser> | null = null;
    let userAnswered = false;
    const fetchCurrentUser = (enableCache?: boolean) => {
        if (currentUserInFlight) {
            return currentUserInFlight;
        }
        const promise = getCurrentUser(enableCache);
        currentUserInFlight = promise;
        const clear = () => {
            if (currentUserInFlight === promise) currentUserInFlight = null;
        };
        promise.then(() => {
            userAnswered = true;
            clear();
        }, clear);
        return promise;
    };

    // Until the server answers, the user saved by the last answer (the apiclient keeps it for
    // this): the app starts without waiting for /Users/{id}. The apiclient does the same on its
    // own only while it has made no request at all, and at start-up the page title's request to
    // /System/Info/Public always comes first. Only until the server first answers: after that, a
    // missing user (signed out, deleted) is asked for again.
    apiClient.getCurrentUser = (enableCache?: boolean) => {
        const fresh = fetchCurrentUser(enableCache);
        if (!userAnswered && enableCache !== false && !(apiClient as unknown as { _currentUser?: unknown })._currentUser) {
            const saved = readSavedUser(apiClient);
            if (saved) {
                fresh.catch(() => { /* the saved user stands in */ });
                return Promise.resolve(saved);
            }
        }
        return fresh;
    };

    return apiClient;
}

function readSavedUser(apiClient: ApiClient) {
    const userId = apiClient.getCurrentUserId();
    const serverId = apiClient.serverId();
    if (!userId || !serverId) {
        return null;
    }
    try {
        const saved = JSON.parse(localStorage.getItem(`user-${userId}-${serverId}`) || 'null');
        return saved?.Id === userId ? saved : null;
    } catch {
        return null;
    }
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
