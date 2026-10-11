// The options the series page asks for its seasons with, shared with the hover prefetch
// (components/shortcuts): the prefetched answer is only used for the same request.
export const SEASONS_FIELDS = 'ItemCounts,PrimaryImageAspectRatio,CanDelete,MediaSourceCount';

export function getSeasonsQuery(userId) {
    return {
        userId: userId,
        Fields: SEASONS_FIELDS
    };
}
