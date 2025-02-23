/*
Copyright 2019, 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { Mjolnir } from "../Mjolnir";
import BanList, { RULE_ROOM, RULE_SERVER, RULE_USER, USER_RULE_TYPES } from "../models/BanList";
import { LogLevel, LogService, MatrixGlob, RichReply } from "matrix-bot-sdk";
import { RECOMMENDATION_BAN, recommendationToStable } from "../models/ListRule";
import config from "../config";
import { logMessage } from "../LogProxy";
import { DEFAULT_LIST_EVENT_TYPE } from "./SetDefaultBanListCommand";

interface Arguments {
    list: BanList;
    entity: string;
    ruleType: string;
    reason: string;
}

// Exported for tests
export async function parseArguments(roomId: string, event: any, mjolnir: Mjolnir, parts: string[]): Promise<Arguments> {
    let defaultShortcode = null;
    try {
        const data = await mjolnir.client.getAccountData(DEFAULT_LIST_EVENT_TYPE);
        defaultShortcode = data['shortcode'];
    } catch (e) {
        LogService.warn("UnbanBanCommand", "Non-fatal error getting default ban list");
        LogService.warn("UnbanBanCommand", e);

        // Assume no default.
    }

    let argumentIndex = 2;
    let ruleType = null;
    let entity = null;
    let list = null;
    let force = false;
    while (argumentIndex < 7 && argumentIndex < parts.length) {
        const arg = parts[argumentIndex++];
        if (!arg) break;
        if (["user", "room", "server"].includes(arg.toLowerCase())) {
            if (arg.toLowerCase() === 'user') ruleType = RULE_USER;
            if (arg.toLowerCase() === 'room') ruleType = RULE_ROOM;
            if (arg.toLowerCase() === 'server') ruleType = RULE_SERVER;
        } else if (!entity && (arg[0] === '@' || arg[0] === '!' || arg[0] === '#' || arg.includes("*"))) {
            entity = arg;
            if (arg.startsWith("@") && !ruleType) ruleType = RULE_USER;
            else if (arg.startsWith("#") && !ruleType) ruleType = RULE_ROOM;
            else if (arg.startsWith("!") && !ruleType) ruleType = RULE_ROOM;
            else if (!ruleType) ruleType = RULE_SERVER;
        } else if (!list) {
            const foundList = mjolnir.lists.find(b => b.listShortcode.toLowerCase() === arg.toLowerCase());
            if (foundList) {
                list = foundList;
            }
        }

        if (entity) break;
    }

    if (parts[parts.length - 1] === "--force") {
        force = true;
        // Remove from parts to ease reason handling
        parts.pop();
    }

    if (!entity) {
        // It'll be a server at this point - figure out which positional argument is the server
        // name and where the reason starts.
        let serverIndex = 2;
        if (ruleType) serverIndex++;
        if (list) serverIndex++;
        entity = parts[serverIndex];
        if (!ruleType) ruleType = RULE_SERVER;
        argumentIndex = serverIndex + 1;
    }

    if (!list) {
        list = mjolnir.lists.find(b => b.listShortcode.toLowerCase() === defaultShortcode);
    }

    let replyMessage = null;
    if (!list) replyMessage = "No ban list matching that shortcode was found";
    else if (!ruleType) replyMessage = "Please specify the type as either 'user', 'room', or 'server'";
    else if (!entity) replyMessage = "No entity found";

    if (config.commands.confirmWildcardBan && /[*?]/.test(entity) && !force) {
        replyMessage = "Wildcard bans require an additional `--force` argument to confirm";
    }

    if (replyMessage) {
        const reply = RichReply.createFor(roomId, event, replyMessage, replyMessage);
        reply["msgtype"] = "m.notice";
        await mjolnir.client.sendMessage(roomId, reply);
        return null;
    }

    return {
        list,
        entity,
        ruleType,
        reason: parts.splice(argumentIndex).join(" ").trim(),
    };
}

// !mjolnir ban <shortcode> <user|server|room> <glob> [reason] [--force]
export async function execBanCommand(roomId: string, event: any, mjolnir: Mjolnir, parts: string[]) {
    const bits = await parseArguments(roomId, event, mjolnir, parts);
    if (!bits) return; // error already handled

    const recommendation = recommendationToStable(RECOMMENDATION_BAN);
    const ruleContent = {
        entity: bits.entity,
        recommendation,
        reason: bits.reason || '<no reason supplied>',
    };
    const stateKey = `rule:${bits.entity}`;

    await mjolnir.client.sendStateEvent(bits.list.roomId, bits.ruleType, stateKey, ruleContent);
    await mjolnir.client.unstableApis.addReactionToEvent(roomId, event['event_id'], '✅');
}

// !mjolnir unban <shortcode> <user|server|room> <glob> [apply:t/f]
export async function execUnbanCommand(roomId: string, event: any, mjolnir: Mjolnir, parts: string[]) {
    const bits = await parseArguments(roomId, event, mjolnir, parts);
    if (!bits) return; // error already handled

    const ruleContent = {}; // empty == clear/unban
    const stateKey = `rule:${bits.entity}`;

    await mjolnir.client.sendStateEvent(bits.list.roomId, bits.ruleType, stateKey, ruleContent);

    if (USER_RULE_TYPES.includes(bits.ruleType) && bits.reason === 'true') {
        const rule = new MatrixGlob(bits.entity);
        await logMessage(LogLevel.INFO, "UnbanBanCommand", "Unbanning users that match glob: " + bits.entity);
        let unbannedSomeone = false;
        for (const protectedRoomId of Object.keys(mjolnir.protectedRooms)) {
            const members = await mjolnir.client.getRoomMembers(protectedRoomId, null, ['ban'], null);
            await logMessage(LogLevel.DEBUG, "UnbanBanCommand", `Found ${members.length} banned user(s)`);
            for (const member of members) {
                const victim = member.membershipFor;
                if (member.membership !== 'ban') continue;
                if (rule.test(victim)) {
                    await logMessage(LogLevel.DEBUG, "UnbanBanCommand", `Unbanning ${victim} in ${protectedRoomId}`, protectedRoomId);

                    if (!config.noop) {
                        await mjolnir.client.unbanUser(victim, protectedRoomId);
                    } else {
                        await logMessage(LogLevel.WARN, "UnbanBanCommand", `Attempted to unban ${victim} in ${protectedRoomId} but Mjolnir is running in no-op mode`, protectedRoomId);
                    }

                    unbannedSomeone = true;
                }
            }
        }

        if (unbannedSomeone) {
            await logMessage(LogLevel.DEBUG, "UnbanBanCommand", `Syncing lists to ensure no users were accidentally unbanned`);
            await mjolnir.syncLists(config.verboseLogging);
        }
    }

    await mjolnir.client.unstableApis.addReactionToEvent(roomId, event['event_id'], '✅');
}
