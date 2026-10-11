import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto';
import type { BaseItemDtoQueryResult } from '@jellyfin/sdk/lib/generated-client/models/base-item-dto-query-result';

export interface SectionOptions {
    enableOverflow: boolean
}

export type SectionContainerElement = {
    fetchData: () => Promise<BaseItemDtoQueryResult | BaseItemDto[]>
    getItemsHtml: (items: BaseItemDto[]) => void
    parentContainer: HTMLElement
    /** Where the row's last items are kept, so a page load shows them before the server answers. */
    cacheKey?: string
} & Element;
