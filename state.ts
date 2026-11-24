/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { proxyLazy } from "@utils/lazy";
import { Logger } from "@utils/Logger";
import { lodash, zustandCreate } from "@webpack/common";

export const logger = new Logger("PeopleSearch");

export const FetchModes = {
    Cached: "cached",
    Slow: "slow",
    Fast: "fast",
} as const;
export type FetchMode = typeof FetchModes[keyof typeof FetchModes];

export interface JobState {
    kind: "members" | "bios" | "avatars" | null;
    done: number;
    total: number;
    note: string;
    version: number;
}

interface JobStore {
    <T>(selector: (state: JobState) => T): T;
    setState(patch: Partial<JobState> | ((state: JobState) => Partial<JobState>)): void;
}

const initialJob: JobState = { kind: null, done: 0, total: 0, note: "", version: 0 };
export const useJob: JobStore = proxyLazy(() => zustandCreate(() => initialJob));
export const setJob = (patch: Partial<JobState>) => useJob.setState(patch);
export const bump = () => useJob.setState(s => ({ version: s.version + 1 }));
export const refresh = proxyLazy(() => lodash.throttle(bump, 250));

let runId = 0;

export function beginJob(kind: JobState["kind"], total: number, note = "") {
    setJob({ kind, done: 0, total, note });
    return ++runId;
}

export const isCurrent = (id: number) => id === runId;

export function abortJob(note: string) {
    runId++;
    setJob({ kind: null, note });
    return false;
}

export function finishJob(id: number) {
    if (!isCurrent(id)) return false;
    setJob({ kind: null, note: "" });
    return true;
}
