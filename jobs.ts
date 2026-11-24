/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { fetchUserProfile } from "@utils/discord";
import { sleep } from "@utils/misc";
import { FluxDispatcher, lodash, UserProfileStore, UserStore } from "@webpack/common";

import { ingestProfile } from "./collect";
import { flushNow, getProfile, knownMemberCount, setProfile } from "./db";
import { abortJob, beginJob, bump, FetchMode, FetchModes, finishJob, isCurrent, logger, setJob } from "./state";

let cancelRequest: (() => void) | undefined;

export function stopJob() {
    abortJob("");
    cancelRequest?.();
    flushNow();
}

interface RequestError {
    status?: number;
    body?: { retry_after?: number; };
}

const isRequestError = (e: unknown): e is RequestError => typeof e === "object" && e !== null && "status" in e;

function ingestFromStore(userId: string, guildId: string | null) {
    const profile = UserProfileStore.getUserProfile(userId);
    const guildProfile = guildId ? UserProfileStore.getGuildMemberProfile(userId, guildId) : null;
    if (!profile || (guildId && !guildProfile)) return false;
    ingestProfile({
        user: UserStore.getUser(userId) ?? { id: userId },
        user_profile: { bio: profile.bio, pronouns: profile.pronouns },
        guild_member_profile: guildId && guildProfile ? { guild_id: guildId, bio: guildProfile.bio, pronouns: guildProfile.pronouns } : null,
        connected_accounts: profile.connectedAccounts ?? [],
        badges: profile.badges,
    });
    return true;
}

const MAX_FAILURES = 3;

const DELAYS: Record<Exclude<FetchMode, "cached">, [number, number]> = {
    slow: [3000, 5000],
    fast: [900, 1300],
};

export function staleProfiles(ids: string[], maxAgeMs: number) {
    const now = Date.now();
    return ids.filter(id => {
        const p = getProfile(id);
        return !p || now - p.fetchedAt > maxAgeMs;
    });
}

export const profileDelayMs = (mode: FetchMode) => mode === FetchModes.Cached ? 0 : (DELAYS[mode][0] + DELAYS[mode][1]) / 2;

export async function fetchBios(guildId: string | null, todo: string[], mode: FetchMode) {
    if (mode === FetchModes.Cached || !todo.length) return true;

    const id = beginJob("bios", todo.length);
    const [min, max] = DELAYS[mode];
    let penalty = 1;
    let failures = 0;

    for (let i = 0; i < todo.length && isCurrent(id); i++) {
        if (ingestFromStore(todo[i], guildId)) {
            setJob({ done: i + 1 });
            continue;
        }
        try {
            await fetchUserProfile(todo[i], guildId ? { guild_id: guildId } : undefined, false);
            penalty = Math.max(1, penalty / 2);
            failures = 0;
        } catch (e) {
            if (!isCurrent(id)) break;
            const err: RequestError = isRequestError(e) ? e : {};
            if (err.status === 403 || err.status === 404) {
                setProfile(todo[i], { bio: "", pronouns: "", guildBios: {}, guildPronouns: {}, connections: [], badges: [], fetchedAt: Date.now() });
            } else {
                if (err.status) logger.warn(`Fetching a profile failed with status ${err.status}.`);
                else logger.error("Fetching a profile failed.", e);
                if (++failures >= MAX_FAILURES) return abortJob(`Stopped after ${MAX_FAILURES} failed profile requests in a row. Wait a while before running again.`);
                if (err.status === 429) {
                    const wait = (err.body?.retry_after ?? 30) * 1000 + 5000;
                    penalty = Math.min(penalty * 2, 16);
                    logger.warn(`Rate limited, waiting ${Math.round(wait / 1000)}s and slowing down to ${penalty}x.`);
                    setJob({ note: `Rate limited by Discord, pausing for ${Math.round(wait / 1000)} seconds.` });
                    await sleep(wait);
                    if (isCurrent(id)) setJob({ note: "" });
                    i--;
                    continue;
                }
            }
        }
        if (!isCurrent(id)) break;
        setJob({ done: i + 1 });
        await sleep((min + Math.random() * (max - min)) * penalty);
    }
    return finishJob(id);
}

const MEMBER_QUERY_DELAY = 750;
const QUERY_LIMIT = 100;
const MAX_MEMBER_QUERIES = 300;
const FULL_LIST_LIMIT = 1000;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789_.";

const checked = new Map<string, Set<string>>();
const crawls = new Map<string, string[]>();

export const isChecked = (guildId: string, userId: string) => !!checked.get(guildId)?.has(userId);
export const isCrawled = (guildId: string) => crawls.get(guildId)?.length === 0;

export function forgetMemberLookups() {
    checked.clear();
    crawls.clear();
}

export async function checkMembers(guildId: string, ids: string[], presences: boolean) {
    const batches = lodash.chunk(ids, QUERY_LIMIT);
    const id = beginJob("members", batches.length, `Checking which of ${ids.length} people are in the server.`);
    let set = checked.get(guildId);
    if (!set) checked.set(guildId, set = new Set());

    for (let i = 0; i < batches.length && isCurrent(id); i++) {
        const got = await requestMembers({ guildId, userIds: batches[i], presences });
        if (!isCurrent(id)) break;
        if (got !== null) for (const userId of batches[i]) set.add(userId);
        setJob({ done: i + 1 });
        bump();
        await sleep(MEMBER_QUERY_DELAY);
    }
    return finishJob(id);
}

interface MemberRequest {
    guildId: string;
    query?: string;
    limit?: number;
    userIds?: string[];
    presences: boolean;
}

function requestMembers({ guildId, ...request }: MemberRequest) {
    const nonce = request.userIds ? `vc-ps-${Date.now()}` : undefined;
    return new Promise<number | null>(resolve => {
        let got: number | null = null;
        let timer = setTimeout(done, 10000);
        function done() {
            clearTimeout(timer);
            cancelRequest = undefined;
            FluxDispatcher.unsubscribe("GUILD_MEMBERS_CHUNK_BATCH", onChunk);
            resolve(got);
        }
        function onChunk({ chunks }: { chunks: { guildId: string; nonce?: string | null; members: unknown[]; }[]; }) {
            const mine = chunks.filter(c => c.guildId === guildId && (c.nonce ?? undefined) === nonce);
            if (!mine.length) return;
            got = mine.reduce((n, c) => n + c.members.length, got ?? 0);
            clearTimeout(timer);
            timer = setTimeout(done, 1500);
        }
        cancelRequest = done;
        FluxDispatcher.subscribe("GUILD_MEMBERS_CHUNK_BATCH", onChunk);
        FluxDispatcher.dispatch({ type: "GUILD_MEMBERS_REQUEST", guildIds: [guildId], ...request, nonce });
    });
}

export async function loadMembers(guildId: string, expected: number, presences: boolean) {
    const id = beginJob("members", 1);

    if (expected <= FULL_LIST_LIMIT) {
        await requestMembers({ guildId, query: "", limit: 0, presences });
        if (!isCurrent(id) || knownMemberCount(guildId) >= expected * 0.95) return finishJob(id);
    }

    let queue = crawls.get(guildId);
    if (!queue) crawls.set(guildId, queue = [...ALPHABET]);
    for (let done = 0; queue.length && isCurrent(id); done++) {
        if (done >= MAX_MEMBER_QUERIES) return abortJob(`Stopped after ${MAX_MEMBER_QUERIES} member lookups to stay gentle on Discord. Run again to continue.`);
        const prefix = queue[0];
        const got = await requestMembers({ guildId, query: prefix, limit: QUERY_LIMIT, presences }) ?? 0;
        if (!isCurrent(id)) break;
        queue.shift();
        if (got >= QUERY_LIMIT && prefix.length < 8) queue.push(...[...ALPHABET].map(c => prefix + c));
        setJob({ done: done + 1, total: done + 1 + queue.length, note: `${knownMemberCount(guildId)} of about ${expected} members found.` });
        await sleep(MEMBER_QUERY_DELAY);
    }
    return finishJob(id);
}
