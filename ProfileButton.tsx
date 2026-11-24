/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { openUserProfile } from "@utils/discord";
import { findStoreLazy } from "@webpack";
import { useStateFromStores } from "@webpack/common";

interface SearchContext { type: string; guildId?: string; channelId?: string; }
interface SearchQuery { author_id?: string[]; mentions?: string[]; }
interface SearchQueryStoreType { getSearchResultsQuery(id: string): SearchQuery | null; }

const SearchQueryStore: SearchQueryStoreType = findStoreLazy("SearchQueryStore");

// Mirrors how Discord keys search state by context.
const searchId = (ctx: SearchContext) => ctx.type === "GUILD" ? ctx.guildId : ctx.type === "DMS" ? ctx.type : ctx.channelId;

export const ProfileButton = ErrorBoundary.wrap(({ searchContext }: { searchContext: SearchContext; }) => {
    const userId = useStateFromStores([SearchQueryStore], () => {
        const id = searchId(searchContext);
        const query = id ? SearchQueryStore.getSearchResultsQuery(id) : null;
        return query?.author_id?.[0] ?? query?.mentions?.[0];
    });
    if (!userId) return null;
    return <Button variant="secondary" size="small" onClick={() => openUserProfile(userId)}>Profile</Button>;
}, { noop: true });
