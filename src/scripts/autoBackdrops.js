import { clearBackdrop, setBackdropImages, setBackdrops } from '../components/backdrop/backdrop';
import * as userSettings from './settings/userSettings';
import libraryMenu from './libraryMenu';
import { pageClassOn } from '../utils/dashboard';
import { queryClient } from 'utils/query/queryClient';
import { getBrandingOptionsQuery } from 'apps/dashboard/features/branding/api/useBrandingOptions';
import { SPLASHSCREEN_URL } from 'constants/branding';
import { ServerConnections } from 'lib/jellyfin-apiclient';

const cache = {};

function enabled() {
    return userSettings.enableBackdrops();
}

// A random pick of the library's backdrops costs the server a third of a second: a pick is kept in
// the browser and shown at once on the next page load, and a fresh one replaces it every half hour.
const STORED_BACKDROPS_TTL_MS = 30 * 60 * 1000;

function readStoredBackdrops(key) {
    try {
        return JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
        return null;
    }
}

function fetchBackdropItemIds(apiClient, key, types, parentId) {
    const options = {
        SortBy: 'IsFavoriteOrLiked,Random',
        Limit: 20,
        Recursive: true,
        IncludeItemTypes: types,
        ImageTypes: 'Backdrop',
        ParentId: parentId,
        EnableTotalRecordCount: false,
        MaxOfficialRating: parentId ? '' : 'PG-13'
    };
    return apiClient.getItems(apiClient.getCurrentUserId(), options).then(function (result) {
        const images = result.Items.map(function (i) {
            return {
                Id: i.Id,
                tag: i.BackdropImageTags[0],
                ServerId: i.ServerId
            };
        });
        cache[key] = JSON.stringify(images);
        try {
            localStorage.setItem(key, JSON.stringify({ at: Date.now(), images }));
        } catch {
            // Storage full or blocked: the in-memory copy still serves this session.
        }
        return images;
    });
}

function getBackdropItemIds(apiClient, userId, types, parentId) {
    const key = `backdrops2_${userId + (types || '') + (parentId || '')}`;
    const data = cache[key];

    if (data) {
        console.debug(`Found backdrop id list in cache. Key: ${key}`);
        return Promise.resolve(JSON.parse(data));
    }

    const stored = readStoredBackdrops(key);
    if (stored?.images?.length) {
        cache[key] = JSON.stringify(stored.images);
        if (Date.now() - stored.at > STORED_BACKDROPS_TTL_MS) {
            fetchBackdropItemIds(apiClient, key, types, parentId).catch(() => { /* keep the stored pick */ });
        }
        return Promise.resolve(stored.images);
    }

    return fetchBackdropItemIds(apiClient, key, types, parentId);
}

function showBackdrop(type, parentId) {
    const apiClient = ServerConnections.currentApiClient();

    if (apiClient) {
        getBackdropItemIds(apiClient, apiClient.getCurrentUserId(), type, parentId).then(function (images) {
            if (images.length) {
                setBackdrops(images.map(function (i) {
                    i.BackdropImageTags = [i.tag];
                    return i;
                }));
            } else {
                clearBackdrop();
            }
        });
    }
}

async function showSplashScreen() {
    const api = ServerConnections.getApi();
    const brandingOptions = await queryClient.fetchQuery(getBrandingOptionsQuery(api));
    if (brandingOptions.SplashscreenEnabled) {
        setBackdropImages([
            api.getUri(SPLASHSCREEN_URL, { t: Date.now() })
        ]);
    } else {
        clearBackdrop();
    }
}

pageClassOn('pageshow', 'page', function () {
    const page = this;

    if (!page.classList.contains('selfBackdropPage')) {
        if (page.classList.contains('backdropPage')) {
            const type = page.getAttribute('data-backdroptype');
            if (type === 'splashscreen') {
                showSplashScreen();
            } else if (enabled()) {
                const parentId = page.classList.contains('globalBackdropPage') ? '' : libraryMenu.getTopParentId();
                showBackdrop(type, parentId);
            } else {
                page.classList.remove('backdropPage');
                clearBackdrop();
            }
        } else {
            clearBackdrop();
        }
    }
});
