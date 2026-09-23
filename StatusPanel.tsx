/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Nays
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Button, TextButton } from "@components/Button";
import { Card } from "@components/Card";
import { SettingsSection } from "@components/settings/tabs/plugins/components/Common";
import { classNameFactory } from "@utils/css";
import { proxyLazy } from "@utils/lazy";
import { findStoreLazy } from "@webpack";
import { Avatar, ChannelStore, GuildMemberStore, IconUtils, SelectedChannelStore, UserStore, useStateFromStores, VoiceStateStore, zustandCreate } from "@webpack/common";
import type { ReactNode } from "react";

export interface Status {
    label: string;
    volume?: number;
    leveled?: boolean;
}

export interface StatusState {
    active: boolean;
    speakers: Partial<Record<string, Status>>;
    excluded: string[];
    clearExcluded(): void;
    turnOn(): void;
}

export const useStatus = proxyLazy(() => zustandCreate(() => ({ active: true, speakers: {}, excluded: [], clearExcluded() { }, turnOn() { } })));

const SpeakingStore = findStoreLazy("SpeakingStore");
const cl = classNameFactory("vc-voice-leveler-");
const METER_MAX = 200;

function nameOf(userId: string, guildId?: string) {
    const user = UserStore.getUser(userId);
    return (guildId && GuildMemberStore.getNick(guildId, userId)) || user?.globalName || user?.username || userId;
}

function Meter({ volume, leveled }: { volume: number; leveled?: boolean; }) {
    return (
        <div className={cl("meter")} aria-hidden>
            <div className={cl("fill", leveled && "leveled")} style={{ width: `${Math.min(volume, METER_MAX) / METER_MAX * 100}%` }} />
            <div className={cl("notch")} />
        </div>
    );
}

function Row({ userId, status, guildId }: { userId: string; status?: Status; guildId?: string; }) {
    const user = UserStore.getUser(userId);
    const speaking = useStateFromStores([SpeakingStore], () => SpeakingStore.isSpeaking(userId));

    return (
        <div className={cl("row")}>
            <Avatar
                src={user ? IconUtils.getUserAvatarURL(user, false, 64) : IconUtils.getDefaultAvatarURL(userId)}
                size="SIZE_32"
                isSpeaking={speaking}
                aria-hidden
            />
            <div className={cl("who")}>
                <BaseText size="sm" weight="medium" className={cl("name")}>{nameOf(userId, guildId)}</BaseText>
                {status?.label && <BaseText size="xs" defaultColor={false} className={cl("label")}>{status.label}</BaseText>}
            </div>
            {status?.volume != null && (
                <>
                    <Meter volume={status.volume} leveled={status.leveled} />
                    <BaseText size="xs" weight="semibold" defaultColor={false} className={cl("value", status.leveled && "leveled")}>
                        {Math.round(status.volume)}%
                    </BaseText>
                </>
            )}
        </div>
    );
}

function Empty({ children }: { children: ReactNode; }) {
    return (
        <Card className={cl("card", "empty")}>
            {children}
        </Card>
    );
}

export function StatusPanel() {
    const channelId = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId());
    const states = useStateFromStores([VoiceStateStore], () => channelId == null ? null : VoiceStateStore.getVoiceStatesForChannel(channelId), [channelId]);
    const { active, speakers, excluded, clearExcluded, turnOn }: StatusState = useStatus();

    const me = UserStore.getCurrentUser().id;
    const guildId = channelId == null ? undefined : ChannelStore.getChannel(channelId)?.guild_id;
    const byName = (a: string, b: string) => nameOf(a, guildId).localeCompare(nameOf(b, guildId));

    const inCall = states == null ? [] : Object.keys(states).filter(userId => userId !== me).sort(byName);
    const others = excluded.filter(userId => states == null || !(userId in states)).sort(byName);

    return (
        <div className={cl("panel")}>
            <SettingsSection name="In This Call" id="vc-voice-leveler-status" description="Blue means Auto Level changed it.">
                {!active ? (
                    <Empty>
                        <BaseText size="sm" defaultColor={false} className={cl("label")}>Auto Level is turned off.</BaseText>
                        <Button size="small" onClick={turnOn}>Turn On</Button>
                    </Empty>
                ) : inCall.length === 0 ? (
                    <Empty>
                        <BaseText size="sm" defaultColor={false} className={cl("label")}>
                            {states == null ? "You're not in a voice channel." : "No one else is here yet."}
                        </BaseText>
                    </Empty>
                ) : (
                    <Card className={cl("card")}>
                        {inCall.map(userId => <Row key={userId} userId={userId} status={speakers[userId]} guildId={guildId} />)}
                    </Card>
                )}
            </SettingsSection>

            {others.length > 0 && (
                <SettingsSection name="Turned Off" id="vc-voice-leveler-excluded" description="Auto Level won't change these people.">
                    <Card className={cl("card")}>
                        {others.map(userId => <Row key={userId} userId={userId} />)}
                        <div className={cl("footer")}>
                            <TextButton variant="link" onClick={clearExcluded}>Turn all back on</TextButton>
                        </div>
                    </Card>
                </SettingsSection>
            )}
        </div>
    );
}
