/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Naystie
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const TICK_MS = 250;
export const COOLDOWN_MS = 15_000;
export const FOCUS_HOLD_MS = 1500;
export const CROWD_SMOOTHING = TICK_MS / 2000;

const SECOND = 1000 / TICK_MS;
const SPEECH_SAMPLES = 60 * SECOND;
const MIN_UTTERANCE = 3;
const MAX_UTTERANCE = 10 * SECOND;
const FLOOR_DB = -40;
const ACTIVE_MARGIN_DB = 15.9;
const REFERENCE_DB = -9;
const TOLERANCE_DB = 3;
const HEADROOM_DB = 10;
const ATTACK_DB = 6;
const RELEASE_DB = 1.5;
const SURGE_SAMPLES = 4;

const BLOCK_SAMPLES = 2.5 * SECOND;
const MIN_LISTEN = 8 * SECOND;
const MAX_LISTEN = 20 * SECOND;
const SURE_DB = TOLERANCE_DB / 2;
const PRIOR_DB = 2;
const PRIOR_HALF_LIFE = 7 * 24 * 60 * 60 * 1000;

const LOSS_LIMIT = 0.1;

const CHANGE_SAMPLES = 7.5 * SECOND;
const CHANGE_SLACK_DB = 3;
const CHANGE_LIMIT_DB = 9;

const FLAT_SAMPLES = 4 * SECOND;
const FLAT_DB = 4;
const NOISE_WINDOW_MS = 60_000;
const NOISE_ON = 30 * SECOND;
const NOISE_OFF = 15 * SECOND;
const NOISE_BELOW_DB = 12;
const OPEN_ON = 54 * SECOND;
const OPEN_OFF = 42 * SECOND;
const OPEN_DB = 6;

const FOCUS_DB = 10;
const CROWD_START = 1.5;
const CROWD_DB = 6;
const CROWD_MAX_DB = 8;

export type Noise = "noise" | "open" | null;

export interface Memory {
    loudness: number;
    at: number;
}

export interface Limits {
    level: number;
    minVolume: number;
    maxVolume: number;
    shout: boolean;
}

export interface Decision {
    volume: number;
    gain: number;
}

interface Utterance {
    squares: number[];
    at: number;
}

interface Heard {
    at: number;
    length: number;
    flat: boolean;
}

export interface Speaker {
    current: number[];
    utterances: Utterance[];
    heard: Heard[];
    prior: { level: number; weight: number; } | null;
    level: number | null;
    ready: boolean;
    relearning: boolean;
    noise: Noise;
    noiseLevel: number;
    block: number[];
    blockBase: number | null;
    blockSince: number;
    up: number;
    down: number;
    upSince: number;
    downSince: number;
    concealed: number;
    decoded: number;
    gain: number;
    volume: number | null;
    changedAt: number;
}

export function toSlider(amplitude: number) {
    if (amplitude <= 0) return 0;

    const ratio = amplitude / 100;
    return 100 * (ratio < 1 ? ratio ** (1 / 2.8) : 20 * Math.log10(ratio) / 6 + 1);
}

export function fromSlider(slider: number) {
    if (slider <= 0) return 0;

    const ratio = slider / 100;
    return 100 * (ratio < 1 ? ratio ** 2.8 : 10 ** ((ratio - 1) * 6 / 20));
}

function gainOf(volume: number) {
    return 20 * Math.log10(volume / 100);
}

const toDb = (square: number) => 10 * Math.log10(square);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

function deviation(values: number[]) {
    const mean = sum(values) / values.length;
    return Math.sqrt(sum(values.map(value => (value - mean) ** 2)) / values.length);
}

function rms(squares: number[]) {
    return toDb(sum(squares) / squares.length);
}

// how loud someone is while actually talking like itu p.56 so pauses and quiet trailing bits don't pull it down
function activeLevel(squares: number[]) {
    let level = rms(squares);

    for (let i = 0; i < 10; i++) {
        const threshold = 10 ** ((level - ACTIVE_MARGIN_DB) / 10);
        const next = rms(squares.filter(square => square > threshold));
        if (next - level < 0.01) return next;

        level = next;
    }

    return level;
}

function measure(squares: number[]) {
    const blocks: number[] = [];
    for (let i = 0; i + BLOCK_SAMPLES <= squares.length; i += BLOCK_SAMPLES) blocks.push(activeLevel(squares.slice(i, i + BLOCK_SAMPLES)));

    const error = blocks.length >= 2 ? deviation(blocks) / Math.sqrt(blocks.length) : Infinity;
    return {
        level: activeLevel(squares),
        sure: squares.length >= MAX_LISTEN || squares.length >= MIN_LISTEN && error <= SURE_DB,
        weight: Math.max(error, 0.5) ** -2
    };
}

function estimate(speaker: Speaker) {
    const { prior, utterances } = speaker;
    const fresh = utterances.length ? measure(utterances.flatMap(({ squares }) => squares)) : null;

    if (fresh && prior) speaker.level = (fresh.weight * fresh.level + prior.weight * prior.level) / (fresh.weight + prior.weight);
    else speaker.level = fresh?.level ?? prior?.level ?? null;

    if (!fresh?.sure) {
        speaker.ready = prior != null;
        return null;
    }

    speaker.ready = true;
    speaker.relearning = false;
    return fresh.level;
}

export function createSpeaker(memory: Memory | undefined, volume: number, now: number): Speaker {
    const speaker: Speaker = {
        current: [],
        utterances: [],
        heard: [],
        prior: memory ? { level: memory.loudness, weight: 0.5 ** ((now - memory.at) / PRIOR_HALF_LIFE) / PRIOR_DB ** 2 } : null,
        level: null,
        ready: false,
        relearning: false,
        noise: null,
        noiseLevel: -Infinity,
        block: [],
        blockBase: null,
        blockSince: 0,
        up: 0,
        down: 0,
        upSince: 0,
        downSince: 0,
        concealed: NaN,
        decoded: NaN,
        gain: gainOf(volume),
        volume: null,
        changedAt: 0
    };

    estimate(speaker);
    return speaker;
}

function detectChange(speaker: Speaker, squares: number[], now: number) {
    if (!speaker.block.length) {
        if (speaker.up === 0 && speaker.down === 0) speaker.blockBase = speaker.ready ? speaker.level : null;
        speaker.blockSince = now;
    }

    speaker.block.push(...squares);
    if (speaker.block.length < CHANGE_SAMPLES) return;

    const level = activeLevel(speaker.block);
    const { blockBase: base, blockSince: since } = speaker;
    speaker.block = [];
    if (base == null) return;

    if (speaker.up === 0) speaker.upSince = since;
    if (speaker.down === 0) speaker.downSince = since;
    speaker.up = Math.max(0, speaker.up + level - base - CHANGE_SLACK_DB);
    speaker.down = Math.max(0, speaker.down + base - level - CHANGE_SLACK_DB);

    const start = speaker.up > CHANGE_LIMIT_DB ? speaker.upSince : speaker.down > CHANGE_LIMIT_DB ? speaker.downSince : null;
    if (start == null) return;

    speaker.utterances = speaker.utterances.filter(({ at }) => at >= start);
    speaker.prior = null;
    speaker.up = speaker.down = 0;
    speaker.relearning = true;
    speaker.changedAt = 0;
}

function noiseOf({ heard, noise }: Speaker): Noise {
    let talking = 0, flat = 0;
    for (const { length, flat: isFlat } of heard) {
        talking += length;
        if (isFlat) flat += length;
    }

    if (flat >= (noise === "noise" ? NOISE_OFF : NOISE_ON)) return "noise";
    if (talking >= (noise === "open" ? OPEN_OFF : OPEN_ON)) return "open";
    return null;
}

function finish(speaker: Speaker, now: number) {
    const squares = speaker.current;
    speaker.current = [];

    const level = activeLevel(squares);
    const loud = squares.length >= MIN_UTTERANCE && level >= FLOOR_DB;
    const flat = loud && squares.length >= FLAT_SAMPLES && deviation(squares.map(toDb)) < FLAT_DB;

    speaker.heard.push({ at: now, length: squares.length, flat });
    if (flat) speaker.noiseLevel = level;
    if (!loud || flat || speaker.noise === "open") return null;

    speaker.utterances.push({ squares, at: now });
    let samples = sum(speaker.utterances.map(({ squares }) => squares.length));
    while (samples > SPEECH_SAMPLES) samples -= speaker.utterances.shift()!.squares.length;

    detectChange(speaker, squares, now);
    return estimate(speaker);
}

export function hear(speaker: Speaker, level: number | null, now: number, concealed = NaN, decoded = NaN) {
    const lost = concealed - speaker.concealed;
    const played = decoded - speaker.decoded;
    speaker.concealed = concealed;
    speaker.decoded = decoded;

    if (lost > 0 && played >= 0 && lost >= LOSS_LIMIT * (lost + played)) return null;

    while (speaker.heard.length && now - speaker.heard[0].at >= NOISE_WINDOW_MS) speaker.heard.shift();
    speaker.noise = noiseOf(speaker);

    if (level == null) return speaker.current.length ? finish(speaker, now) : null;

    speaker.current.push(level * level);
    return speaker.current.length >= MAX_UTTERANCE ? finish(speaker, now) : null;
}

export function volumeFor(measured: number, { level, minVolume, maxVolume }: Limits): Decision {
    const target = REFERENCE_DB + gainOf(level);
    const volume = Math.min(maxVolume, Math.max(minVolume, 100 * 10 ** ((target - measured) / 20)));

    return { volume, gain: gainOf(volume) };
}

export function decide(measured: number, limits: Limits, gain: number) {
    const decision = volumeFor(measured, limits);
    return Math.abs(decision.gain - gain) >= TOLERANCE_DB ? decision : null;
}

export function shape(speaker: Speaker, volume: number, saved: number, { level, minVolume, shout }: Limits, duck: number) {
    const target = REFERENCE_DB + gainOf(level);
    const fit = (loudness: number) => 100 * 10 ** ((target - loudness) / 20);
    const { current, noise } = speaker;

    let next = volume;
    if (shout && current.length >= 2) next = Math.min(next, fit(rms(current.slice(-SURGE_SAMPLES)) - HEADROOM_DB));
    if (noise === "open") next = Math.min(next, saved) * 10 ** (-OPEN_DB / 20);

    const talking = current.length >= 1.5 * SECOND && deviation(current.slice(-FLAT_SAMPLES).map(toDb)) >= FLAT_DB;
    if (noise === "noise" && !talking) next = Math.min(next, saved, fit(speaker.noiseLevel + NOISE_BELOW_DB));

    return Math.max(Math.min(minVolume, volume), next * 10 ** (-duck / 20));
}

export function duckFor(focused: boolean, focusTalking: boolean, crowd: number) {
    if (focused) return 0;

    const crowdDb = Math.min(CROWD_MAX_DB, Math.max(0, CROWD_DB * (crowd - CROWD_START)));
    return Math.max(focusTalking ? FOCUS_DB : 0, crowdDb);
}

export function ramp(from: number, to: number) {
    if (from < 1) return Math.min(to, 1);

    const step = 20 * Math.log10(to / from);
    const max = step < 0 ? ATTACK_DB : RELEASE_DB;
    if (Math.abs(step) <= max) return to;

    return from * 10 ** (Math.sign(step) * max / 20);
}
