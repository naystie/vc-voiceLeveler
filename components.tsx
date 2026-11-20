/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Naystie
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { plugins } from "@api/PluginManager";
import { TextButton } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { openPluginModal } from "@components/settings";
import { Text } from "@components/Text";
import { debounce } from "@shared/debounce";
import { classNameFactory } from "@utils/css";
import { classes } from "@utils/misc";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { Avatar, ChannelStore, Checkbox, GuildMemberStore, IconUtils, Popout, ScrollerThin, SelectedChannelStore, Slider, Tooltip, useRef, UserStore, useStateFromStores, VoiceStateStore } from "@webpack/common";

import { levelCheckbox, percent, settings, statusText, toggle, toggleFocus, turnAllBackOn, useStatus } from ".";

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const SpeakingStore = findStoreLazy("SpeakingStore");

const cl = classNameFactory("vc-voice-leveler-");
const listFormat = new Intl.ListFormat("en");

const setLevel = debounce((value: number) => { settings.store.level = value; }, 100);

function LevelerIcon() {
    return (
        <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x={5} y={3} width={2} height={9} rx={1} />
            <rect x={5} y={18} width={2} height={3} rx={1} />
            <rect x={11} y={3} width={2} height={2} rx={1} />
            <rect x={11} y={11} width={2} height={10} rx={1} />
            <rect x={17} y={3} width={2} height={6} rx={1} />
            <rect x={17} y={15} width={2} height={6} rx={1} />
            <rect x={3} y={13} width={6} height={4} rx={2} />
            <rect x={9} y={6} width={6} height={4} rx={2} />
            <rect x={15} y={10} width={6} height={4} rx={2} />
        </svg>
    );
}

function FocusIcon() {
    return (
        <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true">
            <circle cx={12} cy={12} r={8} fill="none" stroke="currentColor" strokeWidth={2} />
            <circle cx={12} cy={12} r={3.5} fill="currentColor" />
        </svg>
    );
}

function nameOf(userId: string, guildId?: string) {
    const user = UserStore.getUser(userId);
    return (guildId && GuildMemberStore.getNick(guildId, userId)) || user?.globalName || user?.username || userId;
}

function avatarOf(userId: string) {
    const user = UserStore.getUser(userId);
    return user ? IconUtils.getUserAvatarURL(user, false, 64) : IconUtils.getDefaultAvatarURL(userId);
}

function useCall() {
    const channelId = useStateFromStores([SelectedChannelStore], () => SelectedChannelStore.getVoiceChannelId());
    const states = useStateFromStores([VoiceStateStore], () => channelId == null ? null : VoiceStateStore.getVoiceStatesForChannel(channelId), [channelId]);

    const me = UserStore.getCurrentUser()?.id;
    const guildId = channelId == null ? undefined : ChannelStore.getChannel(channelId)?.guild_id;
    const name = (userId: string) => nameOf(userId, guildId);
    const people = Object.keys(states ?? {}).filter(userId => userId !== me).sort((a, b) => name(a).localeCompare(name(b)));

    return { people, name };
}

function Person({ userId, name }: { userId: string; name: string; }) {
    const speaking = useStateFromStores([SpeakingStore], () => SpeakingStore.isSpeaking(userId));
    const status = useStatus(state => state.speakers[userId]);
    const focused = useStatus(state => state.focus.includes(userId));
    const { checked, disabled } = levelCheckbox(userId);

    return (
        <div className={cl("person", status?.off && "off")}>
            <Avatar className={cl("avatar", speaking && "speaking")} src={avatarOf(userId)} size="SIZE_32" aria-hidden />
            <div className={cl("who")}>
                <Text size="sm" weight="medium" className={cl("name")}>{name}</Text>
                {status && (
                    <Text size="xs" defaultColor={false} className={cl("status", status.leveled && "leveled")}>
                        {statusText(status)}
                    </Text>
                )}
            </div>
            <Tooltip text={focused ? "Stop focusing" : "Focus"}>
                {props => (
                    <button
                        {...props}
                        className={cl("focus", focused && "focused")}
                        aria-label={`Focus on ${name}`}
                        aria-pressed={focused}
                        onClick={() => toggleFocus(userId)}
                    >
                        <FocusIcon />
                    </button>
                )}
            </Tooltip>
            <Tooltip text="Auto Level">
                {props => (
                    <div {...props} className={cl("box")}>
                        <Checkbox value={checked} disabled={disabled} size={20} onChange={() => toggle(userId)} />
                    </div>
                )}
            </Tooltip>
        </div>
    );
}

function Toggle({ title, note, checked, onChange }: { title: string; note?: string; checked: boolean; onChange(value: boolean): void; }) {
    return (
        <div className={cl("toggle")}>
            <div className={cl("who")}>
                <Text size="sm" weight="medium">{title}</Text>
                {note && <Text size="xs" defaultColor={false} className={cl("status")}>{note}</Text>}
            </div>
            <div className={cl("box")}>
                <Checkbox value={checked} size={20} onChange={(_, value) => onChange(value)} />
            </div>
        </div>
    );
}

function LevelerPopout() {
    const { level, shout, crowd, excluded } = settings.use(["level", "shout", "crowd", "excluded"]);
    const { people, name } = useCall();

    return (
        <div className={cl("popout")} role="dialog" aria-label="Auto Level">
            <div className={cl("section")}>
                <div className={cl("heading")}>
                    <Text size="xs" weight="semibold" defaultColor={false} className={cl("label")}>Voice Level</Text>
                    <Text size="xs" weight="semibold" defaultColor={false} className={cl("label")}>{percent(level)}</Text>
                </div>
                <Slider
                    mini
                    initialValue={level}
                    minValue={10}
                    maxValue={200}
                    onValueChange={setLevel}
                    onValueRender={percent}
                />
            </div>

            <div className={cl("section", "list")}>
                <Text size="xs" weight="semibold" defaultColor={false} className={cl("label")}>In This Call</Text>
                {people.length > 0 ? (
                    <ScrollerThin className={cl("people")}>
                        {people.map(userId => <Person key={userId} userId={userId} name={name(userId)} />)}
                    </ScrollerThin>
                ) : (
                    <Text size="sm" defaultColor={false} className={cl("status")}>No one else is here.</Text>
                )}
            </div>

            <div className={cl("section")}>
                <Toggle title="Shout Limit" note="Turn people down when they shout" checked={shout} onChange={value => { settings.store.shout = value; }} />
                <Toggle title="Crowd Mode" note="Quieter while lots of people talk" checked={crowd} onChange={value => { settings.store.crowd = value; }} />
            </div>

            <div className={cl("footer")}>
                <TextButton variant="link" onClick={() => openPluginModal(plugins.VoiceLeveler)}>Settings</TextButton>
                {excluded.length > 0 && (
                    <TextButton variant="link" onClick={turnAllBackOn}>
                        Turn back on for {excluded.length === 1 ? "1 person" : `${excluded.length} people`}
                    </TextButton>
                )}
            </div>
        </div>
    );
}

export const LevelerButton = ErrorBoundary.wrap(function LevelerButton() {
    const { showButton } = settings.use(["showButton"]);
    const focus = useStatus(state => state.focus);
    const { name } = useCall();
    const buttonRef = useRef<HTMLButtonElement>(null);

    if (!showButton) return null;

    const focusing = focus.length > 0;
    const tooltip = focusing ? `Focusing on ${listFormat.format(focus.map(name))}` : "Auto Level";

    return (
        <Popout
            position="top"
            align="center"
            targetElementRef={buttonRef}
            renderPopout={() => <LevelerPopout />}
        >
            {popoutProps => (
                <PanelButton
                    ref={buttonRef}
                    tooltipText={tooltip}
                    className={classes(cl("button"), focusing && cl("focusing"))}
                    icon={LevelerIcon}
                    onClick={popoutProps.onClick}
                />
            )}
        </Popout>
    );
}, { noop: true });
