import { BaseItemKind } from '@jellyfin/sdk/lib/generated-client/models/base-item-kind';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import { CollectionType } from '@jellyfin/sdk/lib/generated-client/models/collection-type';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { CardShape } from 'components/cardbuilder/utils/shape';
import { useApi } from '../../../../../hooks/useApi';
import { addSection, getCardOptionsFromType, getItemTypesFromCollectionType, getTitleFromType, isLivetv, isMovies, isMusic, isTVShows, sortSections } from '../utils/search';
import { useArtistsSearch } from './useArtistsSearch';
import { usePeopleSearch } from './usePeopleSearch';
import { useStudiosSearch } from './useStudiosSearch';
import { useVideoSearch } from './useVideoSearch';
import { Section } from '../types';
import { useLiveTvSearch } from './useLiveTvSearch';
import { fetchItemsByType } from './fetchItemsByType';
import { useProgramsSearch } from './useProgramsSearch';
import { LIVETV_CARD_OPTIONS } from '../constants/liveTvCardOptions';

export const useSearchItems = (
    parentId?: string,
    collectionType?: CollectionType,
    searchTerm?: string
) => {
    const { data: artists, isPending: isArtistsPending } = useArtistsSearch(parentId, collectionType, searchTerm);
    const { data: people, isPending: isPeoplePending } = usePeopleSearch(parentId, collectionType, searchTerm);
    const { data: studios, isPending: isStudiosPending } = useStudiosSearch(parentId, collectionType, searchTerm);
    const { data: videos, isPending: isVideosPending } = useVideoSearch(parentId, collectionType, searchTerm);
    const { data: programs, isPending: isProgramsPending } = useProgramsSearch(parentId, collectionType, searchTerm);
    const { data: liveTvSections, isPending: isLiveTvPending } = useLiveTvSearch(parentId, collectionType, searchTerm);
    const { api, user } = useApi();
    const userId = user?.Id;

    const isArtistsEnabled = !isArtistsPending || (collectionType && !isMusic(collectionType));
    const isPeopleEnabled = !isPeoplePending || (collectionType && !isMovies(collectionType) && !isTVShows(collectionType));
    const isStudiosEnabled = !isStudiosPending || (collectionType && !isMovies(collectionType) && !isTVShows(collectionType));
    const isVideosEnabled = !isVideosPending || collectionType;
    const isProgramsEnabled = !isProgramsPending || collectionType;
    const isLiveTvEnabled = !isLiveTvPending || !collectionType || !isLivetv(collectionType);

    const itemTypes: BaseItemKind[] = getItemTypesFromCollectionType(collectionType);
    const isMissing = itemTypes.includes(BaseItemKind.Episode) && !user?.Configuration?.DisplayMissingEpisodes ? false : undefined;
    const isLiveTvOnly = !!collectionType && isLivetv(collectionType);

    // The items themselves, asked for alongside the other searches rather than after them all:
    // with Gelato this is the slowest of them (the addons' catalogs), so waiting for the others
    // first only added their time to it.
    const { data: searchData, isPending: isItemsPending } = useQuery({
        queryKey: ['Search', 'ItemsByType', collectionType, parentId, searchTerm, isMissing],
        queryFn: ({ signal }) => fetchItemsByType(
            api!,
            userId,
            {
                includeItemTypes: itemTypes,
                parentId,
                searchTerm,
                isMissing,
                limit: 800
            },
            { signal }
        ),
        enabled: !!api && !!userId && !isLiveTvOnly
    });

    const isPending = !(
        !!api
        && !!userId
        && !!isArtistsEnabled
        && !!isPeopleEnabled
        && !!isStudiosEnabled
        && !!isVideosEnabled
        && !!isLiveTvEnabled
        && !!isProgramsEnabled
        && (isLiveTvOnly || !isItemsPending)
    );

    const data = useMemo(() => {
        if (isPending) {
            return undefined;
        }

        if (liveTvSections && isLiveTvOnly) {
            return sortSections(liveTvSections);
        }

        const sections: Section[] = [];

        addSection(sections, 'Artists', artists?.Items, {
            coverImage: true
        });

        addSection(sections, 'Programs', programs?.Items, {
            ...LIVETV_CARD_OPTIONS
        });

        addSection(sections, 'People', people?.Items, {
            coverImage: true
        });

        addSection(sections, 'Studios', studios?.Items, {
            shape: CardShape.SquareOverflow
        });

        addSection(sections, 'HeaderVideos', videos?.Items, {
            showParentTitle: true
        });

        if (searchData?.Items) {
            for (const itemType of itemTypes) {
                const items: BaseItemDto[] = [];
                for (const searchItem of searchData.Items) {
                    if (searchItem.Type === itemType) {
                        items.push(searchItem);
                    }
                }
                addSection(sections, getTitleFromType(itemType), items, getCardOptionsFromType(itemType));
            }
        }

        return sortSections(sections);
    }, [isPending, isLiveTvOnly, liveTvSections, artists, programs, people, studios, videos, searchData, itemTypes]);

    return { data, isPending };
};
