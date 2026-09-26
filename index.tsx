/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Nays
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { debounce } from "@shared/debounce";
import definePlugin, { OptionType } from "@utils/types";
import type { MediaEngineConnection, User } from "@vencord/discord-types";
import { Alerts, MediaEngineStore, Menu, RTCConnectionStore, SelectedChannelStore, showToast, UserStore, VoiceStateStore } from "@webpack/common";

import { createSpeaker, decide, Decision, fromSlider, limit, Limits, loudness, observe, ramp, Speaker, TICK_MS, toSlider, volumeFor } from "./leveler";
import { Status, StatusPanel, StatusState, useStatus } from "./StatusPanel";

const STORE_KEY = "VoiceLeveler_speakers";
const PUBLISH_EVERY = 1000 / TICK_MS;
const SAVE_EVERY = 5 * 60_000 / TICK_MS;
const DAY = 24 * 60 * 60 * 1000;
const CEILING = IS_DISCORD_DESKTOP ? 500 : 100;
const DANGER = { confirmVariant: "critical-primary" };

interface Audio {
    type: string;
    audioLevel: number;
    audioDetected: boolean;
}

interface Stats {
    rtp?: {
        inbound?: Record<string, Audio[]>;
    };
}

interface Memory {
    loudness: number;
    at: number;
}

const speakers = new Map<string, Speaker>();
const manual = new Set<string>();
let learned: Record<string, Memory> = {};
let timer: ReturnType<typeof setInterval> | undefined;
let channelId: string | undefined;
let ticks = 0;
let busy = false;
let published = "";

const percent = (value: number) => `${Math.round(value)}%`;
const decibels = (value: number) => `${Math.round(value)} dB`;
const seconds = (value: number) => `${Math.round(value)}s`;
const days = (value: number) => Math.round(value) === 1 ? "1 day" : `${Math.round(value)} days`;

const simpleMode = () => !settings.store.advanced;

const relevel = debounce(relevelNow, 300);
const setLevel = debounce((value: number) => { settings.store.level = value; }, 100);

function ResetSetting() {
    return (
        <SettingsSection name="Reset Auto Level" id="vc-voice-leveler-reset" description="Forget everyone's volume and start over." inlineSetting>
            <Button variant="dangerSecondary" size="small" onClick={reset}>Reset</Button>
        </SettingsSection>
    );
}

const settings = definePluginSettings({
    status: {
        type: OptionType.COMPONENT,
        component: StatusPanel
    },
    level: {
        type: OptionType.SLIDER,
        displayName: "Voice Level",
        description: "How loud everyone should sound",
        markers: [0, 50, 100, 150, 200, 250, 300],
        default: 100,
        stickToMarkers: false,
        componentProps: { onValueRender: percent },
        onChange: relevel
    },
    advanced: {
        type: OptionType.BOOLEAN,
        displayName: "Advanced Settings",
        description: "Show more options",
        default: false
    },
    lowest: {
        type: OptionType.SLIDER,
        displayName: "Lowest Volume",
        description: "Never turn anyone down below this",
        markers: [0, 25, 50, 75, 100],
        default: 50,
        stickToMarkers: false,
        componentProps: { onValueRender: percent },
        isValid: (value: number) => value <= settings.store.highest || "Must be lower than highest volume",
        onChange: relevel,
        hidden: simpleMode
    },
    highest: {
        type: OptionType.SLIDER,
        displayName: "Highest Volume",
        description: "Never turn anyone up above this",
        markers: [100, 200, 300, 400, 500],
        default: 200,
        stickToMarkers: false,
        componentProps: { onValueRender: percent },
        isValid: (value: number) => value >= settings.store.lowest || "Must be higher than lowest volume",
        onChange: relevel,
        hidden: simpleMode
    },
    floor: {
        type: OptionType.SLIDER,
        displayName: "Noise Floor",
        description: "Anything quieter is treated as background noise",
        markers: [-80, -70, -60, -50, -40, -30, -20],
        default: -40,
        stickToMarkers: false,
        componentProps: { onValueRender: decibels },
        hidden: simpleMode
    },
    tolerance: {
        type: OptionType.SLIDER,
        description: "Ignore differences smaller than this",
        markers: [0, 2, 4, 6, 8, 10, 12],
        default: 3,
        stickToMarkers: false,
        componentProps: { onValueRender: decibels },
        hidden: simpleMode
    },
    cooldown: {
        type: OptionType.SLIDER,
        displayName: "Wait Between Changes",
        description: "How long to wait before changing someone again",
        markers: [0, 10, 20, 30, 40, 50, 60],
        default: 15,
        stickToMarkers: false,
        componentProps: { onValueRender: seconds },
        hidden: simpleMode
    },
    headroom: {
        type: OptionType.SLIDER,
        displayName: "Shout Limit",
        description: "Quickly turn down anyone who gets this much too loud",
        markers: [0, 5, 10, 15, 20, 25, 30],
        default: 10,
        stickToMarkers: false,
        componentProps: { onValueRender: decibels },
        hidden: simpleMode
    },
    memory: {
        type: OptionType.SLIDER,
        displayName: "Remember For",
        description: "How long to remember each person's volume",
        markers: [1, 3, 7, 14, 30, 60, 90],
        default: 30,
        stickToMarkers: true,
        componentProps: { onValueRender: days },
        hidden: simpleMode
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "",
        default: true,
        onChange: relevel,
        hidden: simpleMode
    },
    active: {
        type: OptionType.BOOLEAN,
        description: "Turn Auto Level on or off",
        default: true,
        hidden: true,
        onChange() {
            sync();
            publish();
        }
    },
    excluded: {
        type: OptionType.CUSTOM,
        default: [] as string[]
    },
    reset: {
        type: OptionType.COMPONENT,
        component: ResetSetting,
        hidden: simpleMode
    }
});

function limits(): Limits {
    const { level, lowest, highest, floor, tolerance, headroom } = settings.store;
    return {
        level: fromSlider(level),
        minVolume: fromSlider(lowest),
        maxVolume: fromSlider(Math.min(highest, CEILING)),
        floor,
        tolerance,
        headroom
    };
}

function voiceConnection() {
    let found: MediaEngineConnection | undefined;
    MediaEngineStore.getMediaEngine().eachConnection(connection => { found = connection; }, "default");
    return found;
}

function isExcluded(userId: string) {
    return settings.store.excluded.includes(userId);
}

function isSkippedBot(userId: string) {
    return settings.store.ignoreBots && UserStore.getUser(userId)?.bot === true;
}

function statusOf(userId: string): Status {
    const slider = MediaEngineStore.getLocalVolume(userId);
    const volume = toSlider(slider);

    if (!settings.store.active) return { label: "Off for everyone", volume };
    if (slider <= 0) return { label: "Muted by you", volume };
    if (isExcluded(userId)) return { label: "Turned off", volume };
    if (manual.has(userId)) return { label: "You changed their volume", volume };
    if (isSkippedBot(userId)) return { label: "Bots are ignored", volume };

    const speaker = speakers.get(userId);
    if (speaker == null || speaker.utterances.length === 0) return { label: "Hasn't talked yet", volume };

    if (speaker.volume == null || speaker.volume === slider) {
        const label = loudness(speaker) == null ? `Listening (${speaker.utterances.length}/${speaker.needed})` : "No change needed";
        return { label, volume };
    }

    const direction = speaker.volume > slider ? "Turned up" : "Turned down";
    return {
        label: slider === 100 ? direction : `${direction} from ${percent(volume)}`,
        volume: toSlider(speaker.volume),
        leveled: true
    };
}

function statusText({ label, volume, leveled }: Status) {
    return leveled && volume != null ? `${label} to ${percent(volume)}` : label;
}

function publish() {
    const { active, excluded } = settings.store;
    const state: StatusState = { active, speakers: {}, excluded, clearExcluded, turnOn };

    const voiceChannelId = SelectedChannelStore.getVoiceChannelId();
    const inCall = voiceChannelId == null ? [] : Object.keys(VoiceStateStore.getVoiceStatesForChannel(voiceChannelId));
    const me = UserStore.getCurrentUser().id;

    for (const userId of new Set([...inCall, ...speakers.keys(), ...manual, ...excluded])) {
        if (userId !== me) state.speakers[userId] = statusOf(userId);
    }

    const snapshot = JSON.stringify([active, state.speakers, excluded]);
    if (snapshot === published) return;

    published = snapshot;
    useStatus.setState(state, true);
}

function apply(speaker: Speaker, { volume, gain }: Decision, now: number) {
    speaker.volume = volume;
    speaker.gain = gain;
    speaker.changedAt = now;
}

function drive(connection: MediaEngineConnection, userId: string, speaker: Speaker, bounds: Limits) {
    if (speaker.volume == null) return;

    const engine = connection.localVolumes[userId] ?? 100;
    const next = ramp(engine, limit(speaker, speaker.volume, bounds));
    if (next !== engine) connection.setLocalVolume(userId, next);
}

function release(connection: MediaEngineConnection | undefined, userId: string) {
    const speaker = speakers.get(userId);
    if (connection && speaker?.volume != null) connection.setLocalVolume(userId, MediaEngineStore.getLocalVolume(userId));
    speakers.delete(userId);
}

function releaseAll() {
    const connection = voiceConnection();
    for (const userId of [...speakers.keys()]) release(connection, userId);
}

function remember() {
    return DataStore.set(STORE_KEY, learned);
}

function seed(userId: string) {
    const speaker = createSpeaker(learned[userId]?.loudness, MediaEngineStore.getLocalVolume(userId));
    speakers.set(userId, speaker);
    return speaker;
}

async function tick() {
    if (busy) return;

    const connection = voiceConnection();
    if (!connection || MediaEngineStore.isDeaf()) return;

    busy = true;
    const stats = await connection.getStats().catch(() => null) as Stats | null;
    busy = false;

    const inbound = stats?.rtp?.inbound;
    if (inbound == null || timer === undefined) return;

    const now = Date.now();
    const bounds = limits();

    for (const [userId, streams] of Object.entries(inbound)) {
        if (manual.has(userId)) continue;

        if (isExcluded(userId) || isSkippedBot(userId) || MediaEngineStore.getLocalVolume(userId) <= 0) {
            release(connection, userId);
            continue;
        }

        const audio = streams.find(stream => stream.type === "audio");
        if (!audio) continue;

        const speaker = speakers.get(userId) ?? seed(userId);
        observe(speaker, audio.audioDetected && audio.audioLevel > 0 ? audio.audioLevel : null, bounds.floor);
        drive(connection, userId, speaker, bounds);
        if (!speaker.shifted && now - speaker.changedAt < settings.store.cooldown * 1000) continue;

        const measured = loudness(speaker);
        if (measured == null) continue;

        learned[userId] = { loudness: measured, at: now };

        const decision = decide(measured, bounds, speaker.gain);
        speaker.shifted = false;
        if (decision) apply(speaker, decision, now);
    }

    for (const userId of [...speakers.keys()]) {
        if (!(userId in inbound)) release(connection, userId);
    }

    ticks++;
    if (ticks % PUBLISH_EVERY === 0) publish();
    if (ticks % SAVE_EVERY === 0) remember();
}

function relevelNow() {
    const now = Date.now();
    const bounds = limits();

    for (const speaker of speakers.values()) {
        const measured = loudness(speaker);
        if (measured == null) continue;

        const decision = volumeFor(measured, bounds);
        if (decision) apply(speaker, decision, now);
    }

    publish();
}

function sync() {
    if (settings.store.active && RTCConnectionStore.isConnected()) {
        const current = RTCConnectionStore.getChannelId();
        if (current !== channelId) {
            channelId = current;
            manual.clear();
        }

        timer ??= setInterval(tick, TICK_MS);
        return;
    }

    if (SelectedChannelStore.getVoiceChannelId() == null) channelId = undefined;
    if (timer === undefined) return;

    clearInterval(timer);
    timer = undefined;
    releaseAll();
    publish();
    remember();
}

async function reset() {
    const confirmed = await Alerts.confirm({
        title: "Reset Auto Level?",
        body: "Auto level will forget how loud everyone is",
        confirmText: "Reset",
        ...DANGER
    });
    if (!confirmed) return;

    releaseAll();
    learned = {};
    publish();
    await DataStore.del(STORE_KEY);
    showToast("Auto Level reset");
}

function toggle(userId: string) {
    const { excluded } = settings.store;

    if (manual.has(userId) || excluded.includes(userId)) {
        manual.delete(userId);
        settings.store.excluded = excluded.filter(id => id !== userId);
    } else {
        settings.store.excluded = [...excluded, userId];
        release(voiceConnection(), userId);
    }

    publish();
}

function clearExcluded() {
    settings.store.excluded = [];
    publish();
}

function turnOn() {
    settings.store.active = true;
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user: User; }) => {
    const { active, excluded } = settings.use(["active", "excluded", "ignoreBots"]);
    const { speakers: status }: StatusState = useStatus();

    const group = findGroupChildrenByChildId("user-volume", children);
    if (!group) return;

    const skipped = isSkippedBot(user.id);

    group.splice(group.findIndex(child => child?.props?.id === "user-volume") + 1, 0,
        <Menu.MenuCheckboxItem
            id="vc-voice-leveler"
            label="Auto Level"
            subtext={statusText(status[user.id] ?? statusOf(user.id))}
            checked={active && !skipped && !manual.has(user.id) && !excluded.includes(user.id)}
            disabled={!active || skipped}
            action={() => toggle(user.id)}
        />
    );
};

const audioDeviceContextPatch: NavContextMenuPatchCallback = (children, { renderOutputDevices }: { renderOutputDevices?: boolean; }) => {
    const { active, level } = settings.use(["active", "level"]);
    if (!renderOutputDevices) return;

    children.push(
        <Menu.MenuSeparator />,
        <Menu.MenuCheckboxItem
            id="vc-voice-leveler-active"
            label="Auto Level"
            checked={active}
            action={() => { settings.store.active = !active; }}
        />,
        <Menu.MenuControlItem
            id="vc-voice-leveler-level"
            label="Voice Level"
            control={(props, ref) => (
                <Menu.MenuSliderControl
                    ref={ref}
                    {...props}
                    minValue={10}
                    maxValue={300}
                    value={level}
                    onChange={setLevel}
                    renderValue={percent}
                />
            )}
        />
    );
};

export default definePlugin({
    name: "VoiceLeveler",
    description: "Evens out everyone's volume in voice chat",
    authors: [{ name: "Nays", id: 344871509677965313n }],
    tags: ["Voice"],
    settings,

    contextMenus: {
        "user-context": userContextPatch,
        "audio-device-context": audioDeviceContextPatch
    },

    flux: {
        RTC_CONNECTION_STATE: sync,
        AUDIO_SET_LOCAL_VOLUME({ userId, context }: { userId: string; context: string; }) {
            if (context !== "default") return;

            manual.add(userId);
            speakers.delete(userId);
            publish();
        }
    },

    async start() {
        const stored = await DataStore.get<Record<string, Memory>>(STORE_KEY) ?? {};
        const expired = Date.now() - settings.store.memory * DAY;

        for (const userId in stored) {
            if (stored[userId].at > expired) learned[userId] = stored[userId];
        }

        sync();
        publish();
    },

    async stop() {
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }

        releaseAll();
        manual.clear();
        channelId = undefined;
        publish();
        await remember();
    }
});
