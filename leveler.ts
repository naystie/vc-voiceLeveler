/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Nays
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const TICK_MS = 250;
export const LISTEN_SECONDS = 20;
const LISTEN_SAMPLES = LISTEN_SECONDS * 1000 / TICK_MS;
const SPEECH_SAMPLES = 60_000 / TICK_MS;
const MIN_UTTERANCE_SAMPLES = 3;
const MAX_UTTERANCE_SAMPLES = 40;
const ACTIVE_MARGIN_DB = 15.9;
const REFERENCE_DB = -9;
const ATTACK_DB = 6;
const RELEASE_DB = 1.5;
const SURGE_SAMPLES = 4;

export interface Speaker {
    current: number[];
    speech: number[];
    level: number | null;
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

function rms(squares: number[]) {
    return 10 * Math.log10(squares.reduce((sum, square) => sum + square, 0) / squares.length);
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

export function createSpeaker(prior?: number, volume = 100): Speaker {
    return {
        current: [],
        speech: [],
        level: prior ?? null,
        gain: gainOf(volume),
        volume: null,
        changedAt: 0
    };
}

function finish(speaker: Speaker, floor: number) {
    const { current, speech } = speaker;
    speaker.current = [];
    if (current.length < MIN_UTTERANCE_SAMPLES || rms(current) < floor) return;

    speech.push(...current);
    if (speech.length > SPEECH_SAMPLES) speech.splice(0, speech.length - SPEECH_SAMPLES);
    if (speech.length >= LISTEN_SAMPLES) speaker.level = activeLevel(speech);
}

export function observe(speaker: Speaker, level: number | null, floor: number) {
    if (level == null) {
        if (speaker.current.length) finish(speaker, floor);
        return;
    }

    speaker.current.push(level * level);
    if (speaker.current.length >= MAX_UTTERANCE_SAMPLES) finish(speaker, floor);
}

export function listened(speaker: Speaker) {
    return speaker.speech.length * TICK_MS / 1000;
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
