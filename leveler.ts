/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Nays
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const TICK_MS = 250;
const MIN_UTTERANCE_SAMPLES = 3;
const MAX_UTTERANCE_SAMPLES = 40;
const HISTORY_UTTERANCES = 24;
const MIN_UTTERANCES = 6;
const RECENT_UTTERANCES = 3;
const SHIFT_DB = 10;
const NOISE_GAP_DB = 25;
const REFERENCE_DB = -10;
const ATTACK_DB = 6;
const RELEASE_DB = 1.5;
const SURGE_SAMPLES = 4;

export interface Speaker {
    current: number[];
    utterances: number[];
    needed: number;
    shifted: boolean;
    gain: number;
    volume: number | null;
    changedAt: number;
}

export interface Limits {
    level: number;
    minVolume: number;
    maxVolume: number;
    floor: number;
    tolerance: number;
    headroom: number;
}

export interface Decision {
    volume: number;
    gain: number;
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

export function gainOf(volume: number) {
    return 20 * Math.log10(volume / 100);
}

function median(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function rms(squares: number[]) {
    return 10 * Math.log10(squares.reduce((sum, square) => sum + square, 0) / squares.length);
}

export function createSpeaker(prior?: number, volume = 100): Speaker {
    return {
        current: [],
        utterances: prior == null ? [] : Array(MIN_UTTERANCES).fill(prior),
        needed: MIN_UTTERANCES,
        shifted: false,
        gain: gainOf(volume),
        volume: null,
        changedAt: 0
    };
}

export function loudness(speaker: Speaker) {
    const { utterances, needed } = speaker;
    if (utterances.length < needed) return null;

    const anchor = [...utterances].sort((a, b) => b - a)[Math.floor(utterances.length / 4)];
    return median(utterances.filter(value => value >= anchor - NOISE_GAP_DB));
}

function finish(speaker: Speaker, floor: number) {
    const { current, utterances } = speaker;
    speaker.current = [];
    if (current.length < MIN_UTTERANCE_SAMPLES) return;

    const level = rms(current);
    if (level < floor) return;

    utterances.push(level);
    if (utterances.length > HISTORY_UTTERANCES) utterances.shift();

    const measured = loudness(speaker);
    if (measured == null || utterances.length < MIN_UTTERANCES + RECENT_UTTERANCES) return;

    const recent = utterances.slice(-RECENT_UTTERANCES);
    if (recent.every(value => value - measured > SHIFT_DB) || recent.every(value => measured - value > SHIFT_DB)) {
        speaker.utterances = recent;
        speaker.needed = RECENT_UTTERANCES;
        speaker.shifted = true;
    }
}

export function observe(speaker: Speaker, level: number | null, floor: number) {
    if (level == null) {
        if (speaker.current.length) finish(speaker, floor);
        return;
    }

    speaker.current.push(level * level);
    if (speaker.current.length >= MAX_UTTERANCE_SAMPLES) finish(speaker, floor);
}

export function volumeFor(measured: number, { level, minVolume, maxVolume, floor }: Limits): Decision | null {
    if (measured < floor) return null;

    const target = REFERENCE_DB + gainOf(level);
    const volume = Math.min(maxVolume, Math.max(minVolume, 100 * 10 ** ((target - measured) / 20)));

    return { volume, gain: gainOf(volume) };
}

export function limit(speaker: Speaker, volume: number, { level, minVolume, headroom }: Limits) {
    const { current } = speaker;
    if (current.length < 2) return volume;

    const target = REFERENCE_DB + gainOf(level) + headroom;
    const ceiling = 100 * 10 ** ((target - rms(current.slice(-SURGE_SAMPLES))) / 20);

    return Math.min(volume, Math.max(minVolume, ceiling));
}

export function decide(measured: number, limits: Limits, gain: number) {
    const decision = volumeFor(measured, limits);
    return decision && Math.abs(decision.gain - gain) >= limits.tolerance ? decision : null;
}

export function ramp(from: number, to: number) {
    if (from < 1) return Math.min(to, 1);

    const step = 20 * Math.log10(to / from);
    const max = step < 0 ? ATTACK_DB : RELEASE_DB;
    if (Math.abs(step) <= max) return to;

    return from * 10 ** (Math.sign(step) * max / 20);
}
