/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Naystie
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import { SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { debounce } from "@shared/debounce";
import { Devs } from "@utils/constants";
import { proxyLazy } from "@utils/lazy";
import definePlugin, { OptionType } from "@utils/types";
import type { MediaEngineConnection, User } from "@vencord/discord-types";
import { Alerts, MediaEngineStore, Menu, RTCConnectionStore, SelectedChannelStore, showToast, UserStore, VoiceStateStore, zustandCreate } from "@webpack/common";

import { LevelerButton } from "./components";
import { COOLDOWN_MS, createSpeaker, CROWD_SMOOTHING, decide, Decision, duckFor, FOCUS_HOLD_MS, fromSlider, hear, Limits, Memory, ramp, shape, Speaker, TICK_MS, toSlider, volumeFor } from "./leveler";
import managedStyle from "./styles.css?managed";

const STORE_KEY = "VoiceLeveler_levels";
const PUBLISH_EVERY = 1000 / TICK_MS;
const SAVE_EVERY = 60_000 / TICK_MS;
const DAY = 24 * 60 * 60 * 1000;
const CEILING = IS_DISCORD_DESKTOP ? 500 : 100;

interface InboundAudio {
    type: string;
    audioLevel: number;
    audioDetected: boolean | number;
    decodingPLC?: number;
    decodingNormal?: number;
}

interface Stats {
    rtp?: {
        inbound?: Record<string, InboundAudio[]>;
    };
}

interface Status {
    label: string;
    volume?: number;
    leveled?: boolean;
    off?: boolean;
}

interface StatusState {
    speakers: Partial<Record<string, Status>>;
    focus: string[];
}

export const useStatus = proxyLazy(() => zustandCreate((): StatusState => ({ speakers: {}, focus: [] })));

const speakers = new Map<string, Speaker>();
const manual = new Set<string>();
const focus = new Set<string>();
const talkedAt = new Map<string, number>();
let learned: Record<string, Memory> = {};
let unsaved = false;
let running = false;
let timer: ReturnType<typeof setInterval> | undefined;
let channelId: string | undefined;
let ticks = 0;
let busy = false;
let published = "";
let crowd = 0;

export const percent = (value: number) => `${Math.round(value)}%`;
const days = (value: number) => Math.round(value) === 1 ? "1 day" : `${Math.round(value)} days`;

const relevel = debounce(relevelNow, 300);

function ResetSetting() {
    return (
        <SettingsSection name="Reset Auto Level" id="vc-voice-leveler-reset" description="Forget how loud everyone is and start over" inlineSetting>
            <Button variant="dangerSecondary" size="small" onClick={reset}>Reset</Button>
        </SettingsSection>
    );
}

export const settings = definePluginSettings({
    level: {
        type: OptionType.SLIDER,
        displayName: "Voice Level",
        description: "How loud everyone should sound",
        markers: [10, 50, 100, 150, 200],
        default: 100,
        stickToMarkers: false,
        componentProps: { onValueRender: percent },
        onChange: relevel
    },
    lowest: {
        type: OptionType.SLIDER,
        displayName: "Lowest Volume",
        description: "Never turn anyone down below this",
        markers: [0, 25, 50, 75, 100],
        default: 50,
        stickToMarkers: false,
        componentProps: { onValueRender: percent },
        isValid: (value: number) => value <= settings.store.highest || "Must be lower than the highest volume",
        onChange: relevel
    },
    highest: {
        type: OptionType.SLIDER,
        displayName: "Highest Volume",
        description: "Never turn anyone up above this",
        markers: [100, 200, 300, 400, 500],
        default: 200,
        stickToMarkers: false,
        componentProps: { onValueRender: percent },
        isValid: (value: number) => value >= settings.store.lowest || "Must be higher than the lowest volume",
        onChange: relevel
    },
    shout: {
        type: OptionType.BOOLEAN,
        displayName: "Shout Limit",
        description: "Turn people down right away when they shout",
        default: true
    },
    crowd: {
        type: OptionType.BOOLEAN,
        displayName: "Crowd Mode",
        description: "Turn everyone down a little while lots of people talk",
        default: false
    },
    custom: {
        type: OptionType.BOOLEAN,
        displayName: "Level Custom Volumes",
        description: "Also level people you've set your own volume for",
        default: true
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        displayName: "Ignore Bots",
        description: "Don't change the volume of bots",
        default: true
    },
    showButton: {
        type: OptionType.BOOLEAN,
        displayName: "Voice Panel Button",
        description: "Show the Auto Level button in the voice panel",
        default: true
    },
    memory: {
        type: OptionType.SLIDER,
        displayName: "Remember For",
        description: "How long to remember how loud each person is",
        markers: [1, 3, 7, 14, 30, 60, 90],
        default: 30,
        stickToMarkers: true,
        componentProps: { onValueRender: days }
    },
    reset: {
        type: OptionType.COMPONENT,
        component: ResetSetting
    },
    excluded: {
        type: OptionType.CUSTOM,
        description: "",
        default: [] as string[]
    }
});

function limits(): Limits {
    const { level, lowest, highest, shout } = settings.store;
    return {
        shout,
        level: fromSlider(level),
        minVolume: fromSlider(lowest),
        maxVolume: fromSlider(Math.min(highest, CEILING))
    };
}

function voiceConnection() {
    let found: MediaEngineConnection | undefined;
    MediaEngineStore.getMediaEngine().eachConnection(connection => { found = connection; }, "default");
    return found;
}

const isExcluded = (userId: string) => settings.store.excluded.includes(userId);
const isBot = (userId: string) => UserStore.getUser(userId)?.bot === true;
const isSkippedBot = (userId: string) => settings.store.ignoreBots && isBot(userId);
const isMuted = (userId: string) => MediaEngineStore.getLocalVolume(userId) <= 0 || MediaEngineStore.isLocalMute(userId);
const isSkippedCustom = (userId: string) => !settings.store.custom && Math.round(MediaEngineStore.getLocalVolume(userId)) !== 100;
const isUserSet = (userId: string) => manual.has(userId) || isSkippedCustom(userId);

function statusOf(userId: string): Status {
    const saved = MediaEngineStore.getLocalVolume(userId);
    const volume = toSlider(saved);

    if (isMuted(userId)) return { label: "Muted by you", volume, off: true };
    if (isExcluded(userId)) return { label: "Turned off", volume, off: true };
    if (isSkippedBot(userId)) return { label: "Bots are ignored", volume, off: true };
    if (isUserSet(userId)) return { label: `You set them to ${percent(volume)}`, volume, off: true };

    const speaker = speakers.get(userId);
    if (speaker?.noise === "noise") return { label: "Background noise, kept down", volume };
    if (speaker?.noise === "open") return { label: "Mic is always on, kept down", volume };
    if (speaker == null || speaker.level == null) return { label: "Hasn't talked yet", volume };
    if (!speaker.ready) return { label: speaker.relearning ? "Sounds different, listening again" : "Listening", volume };
    if (speaker.volume == null || Math.abs(speaker.volume - saved) < 0.5) return { label: "No change needed", volume };

    const direction = speaker.volume > saved ? "Turned up" : "Turned down";
    return {
        label: Math.round(saved) === 100 ? direction : `${direction} from ${percent(volume)}`,
        volume: toSlider(speaker.volume),
        leveled: true
    };
}

export function statusText({ label, volume, leveled }: Status) {
    return leveled && volume != null ? `${label} to ${percent(volume)}` : label;
}

export function levelCheckbox(userId: string) {
    const locked = isSkippedBot(userId) || isMuted(userId) || isSkippedCustom(userId) && !isExcluded(userId);
    return {
        checked: !locked && !isExcluded(userId) && !manual.has(userId),
        disabled: locked
    };
}

function inCall(userId: string) {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    return channelId != null && userId !== UserStore.getCurrentUser()?.id && userId in VoiceStateStore.getVoiceStatesForChannel(channelId);
}

function publish() {
    const voiceChannelId = SelectedChannelStore.getVoiceChannelId();
    const people = voiceChannelId == null ? [] : Object.keys(VoiceStateStore.getVoiceStatesForChannel(voiceChannelId));
    const me = UserStore.getCurrentUser()?.id;

    // focus survives a reconnect but only shows for people who are here
    const state: StatusState = { speakers: {}, focus: [...focus].filter(userId => people.includes(userId)) };

    for (const userId of new Set([...people, ...speakers.keys(), ...manual])) {
        if (userId !== me) state.speakers[userId] = statusOf(userId);
    }

    const snapshot = JSON.stringify(state);
    if (snapshot === published) return;

    published = snapshot;
    useStatus.setState(state, true);
}

function apply(speaker: Speaker, { volume, gain }: Decision, now: number) {
    speaker.volume = volume;
    speaker.gain = gain;
    speaker.changedAt = now;
}

function release(connection: MediaEngineConnection | undefined, userId: string) {
    if (connection && speakers.has(userId)) connection.setLocalVolume(userId, MediaEngineStore.getLocalVolume(userId));
    speakers.delete(userId);
}

function releaseAll() {
    const connection = voiceConnection();
    for (const userId of [...speakers.keys()]) release(connection, userId);
}

function forgetExpired() {
    const expired = Date.now() - settings.store.memory * DAY;

    for (const userId in learned) {
        if (learned[userId].at > expired) continue;

        delete learned[userId];
        unsaved = true;
    }
}

async function remember() {
    forgetExpired();
    if (!unsaved) return;

    unsaved = false;
    await DataStore.set(STORE_KEY, learned);
}

function seed(userId: string, now: number) {
    const speaker = createSpeaker(learned[userId], MediaEngineStore.getLocalVolume(userId), now);
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
    const heard: [string, Speaker][] = [];
    let talking = 0;

    for (const [userId, streams] of Object.entries(inbound)) {
        const audio = streams.find(stream => stream.type === "audio");
        if (!audio) continue;

        const level = audio.audioDetected && audio.audioLevel > 0 ? audio.audioLevel : null;
        if (level != null) talkedAt.set(userId, now);

        if (isExcluded(userId) || isSkippedBot(userId) || isMuted(userId)) {
            release(connection, userId);
            if (level != null && !isBot(userId)) talking++;
            continue;
        }

        const speaker = speakers.get(userId) ?? seed(userId, now);
        const loudness = hear(speaker, level, now, audio.decodingPLC, audio.decodingNormal);
        if (loudness != null) {
            learned[userId] = { loudness, at: now };
            unsaved = true;
        }

        if (level != null && !isBot(userId) && !speaker.noise) talking++;
        heard.push([userId, speaker]);
    }

    for (const userId of [...speakers.keys()]) {
        if (!(userId in inbound)) release(connection, userId);
    }
    for (const userId of [...talkedAt.keys()]) {
        if (!(userId in inbound)) talkedAt.delete(userId);
    }

    crowd += (talking - crowd) * CROWD_SMOOTHING;
    const focusTalking = [...focus].some(userId => now - (talkedAt.get(userId) ?? -Infinity) < FOCUS_HOLD_MS);

    for (const [userId, speaker] of heard) {
        const userSet = isUserSet(userId);
        if (!userSet && speaker.ready && speaker.level != null && now - speaker.changedAt >= COOLDOWN_MS) {
            const decision = decide(speaker.level, bounds, speaker.gain);
            if (decision) apply(speaker, decision, now);
        }

        const saved = MediaEngineStore.getLocalVolume(userId);
        const duck = duckFor(focus.has(userId), focusTalking, settings.store.crowd ? crowd : 0);
        const volume = shape(speaker, userSet ? saved : speaker.volume ?? saved, saved, bounds, duck);
        const engine = connection.localVolumes[userId] ?? 100;
        const next = ramp(engine, volume);
        if (next !== engine) connection.setLocalVolume(userId, next);
    }

    ticks++;
    if (ticks % PUBLISH_EVERY === 0) publish();
    if (ticks % SAVE_EVERY === 0) remember();
}

// settings call this even while the plugin is off
function relevelNow() {
    if (!running) return;

    const now = Date.now();
    const bounds = limits();

    for (const [userId, speaker] of speakers) {
        if (speaker.ready && speaker.level != null && !isUserSet(userId)) apply(speaker, volumeFor(speaker.level, bounds), now);
    }

    publish();
}

function pause() {
    if (timer === undefined) return;

    clearInterval(timer);
    timer = undefined;
    talkedAt.clear();
    crowd = 0;
    releaseAll();
    remember();
}

function sync() {
    const current = SelectedChannelStore.getVoiceChannelId();
    if (current !== channelId) {
        channelId = current;
        manual.clear();
        focus.clear();
    }

    if (running && RTCConnectionStore.isConnected()) {
        timer ??= setInterval(tick, TICK_MS);
        return;
    }

    pause();
    publish();
}

async function reset() {
    const confirmed = await Alerts.confirm({
        title: "Reset Auto Level?",
        body: "Auto Level will forget how loud everyone is.",
        confirmText: "Reset"
    });
    if (!confirmed) return;

    releaseAll();
    learned = {};
    unsaved = false;
    publish();
    await DataStore.del(STORE_KEY);
    showToast({ text: "Auto Level reset" });
}

export function toggle(userId: string) {
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

export function toggleFocus(userId: string) {
    if (!focus.delete(userId)) focus.add(userId);
    publish();
}

export function turnAllBackOn() {
    settings.store.excluded = [];
    publish();
}

const userContextPatch: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    settings.use(["excluded", "ignoreBots", "custom"]);
    const { speakers: status, focus: focused } = useStatus();

    const group = findGroupChildrenByChildId("user-volume", children);
    if (!group || !user) return;

    const items = [
        <Menu.MenuCheckboxItem
            key="vc-voice-leveler"
            id="vc-voice-leveler"
            label="Auto Level"
            subtext={statusText(status[user.id] ?? statusOf(user.id))}
            action={() => toggle(user.id)}
            {...levelCheckbox(user.id)}
        />
    ];

    if (inCall(user.id)) items.push(
        <Menu.MenuCheckboxItem
            key="vc-voice-leveler-focus"
            id="vc-voice-leveler-focus"
            label="Focus"
            checked={focused.includes(user.id)}
            action={() => toggleFocus(user.id)}
        />
    );

    group.splice(group.findIndex(child => child?.props?.id === "user-volume") + 1, 0, ...items);
};

export default definePlugin({
    name: "VoiceLeveler",
    description: "Evens out everyone's volume in voice chat",
    authors: [Devs.Nays],
    tags: ["Voice"],
    settings,
    managedStyle,

    patches: [
        {
            find: "hasRemoteVoiceState:",
            replacement: {
                match: /grow:0,shrink:0,className:\i\.\i,children:\[\i&&!\i\?\(0,\i\.jsx\)\(\i,\{channel:\i\}\):null/,
                replace: "$&,$self.renderButton()"
            }
        }
    ],

    renderButton: () => <LevelerButton />,

    contextMenus: {
        "user-context": userContextPatch
    },

    flux: {
        RTC_CONNECTION_STATE: sync,
        AUDIO_SET_LOCAL_VOLUME({ userId, context }: { userId: string; context: string; }) {
            if (context !== "default") return;

            manual.add(userId);
            publish();
        }
    },

    async start() {
        learned = await DataStore.get<Record<string, Memory>>(STORE_KEY) ?? {};
        forgetExpired();

        running = true;
        sync();
        publish();
    },

    stop() {
        running = false;
        pause();
        manual.clear();
        focus.clear();
        publish();
    }
});
