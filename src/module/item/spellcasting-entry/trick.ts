import { CharacterPF2e } from "@actor";
import { AbilityString } from "@actor/types";
import { SpellPF2e } from "@item";
import { extractModifiers } from "@module/rules/util";
import { Statistic } from "@system/statistic";
import { BaseSpellcastingEntry } from "./data";

export const TRICK_MAGIC_SKILLS = ["arc", "nat", "occ", "rel"] as const;
export type TrickMagicItemSkill = typeof TRICK_MAGIC_SKILLS[number];

const TrickMagicTradition = {
    arc: "arcane",
    nat: "primal",
    occ: "occult",
    rel: "divine",
} as const;

export const TraditionSkills = {
    arcane: "arc",
    divine: "rel",
    occult: "occ",
    primal: "nat",
} as const;

/** A pseudo spellcasting entry used to trick magic item for a single skill */
export class TrickMagicItemEntry implements BaseSpellcastingEntry {
    id = `trick-${this.skill}`;

    statistic: Statistic;

    ability: AbilityString;

    tradition = TrickMagicTradition[this.skill];

    constructor(public actor: CharacterPF2e, public skill: TrickMagicItemSkill) {
        const { abilities } = actor;
        const { ability } = (["int", "wis", "cha"] as const)
            .map((ability) => {
                return { ability, value: abilities[ability].value };
            })
            .reduce((highest, next) => {
                if (next.value > highest.value) {
                    return next;
                } else {
                    return highest;
                }
            });

        this.ability = ability;
        const tradition = TrickMagicTradition[skill];

        const selectors = [`${ability}-based`, "all", "spell-attack-dc"];
        const attackSelectors = [
            `${tradition}-spell-attack`,
            "spell-attack",
            "spell-attack-roll",
            "attack",
            "attack-roll",
        ];
        const saveSelectors = [`${tradition}-spell-dc`, "spell-dc"];

        this.statistic = new Statistic(actor, {
            slug: `trick-${tradition}`,
            label: CONFIG.PF2E.magicTraditions[tradition],
            ability,
            rank: actor.system.skills[skill].rank,
            modifiers: extractModifiers(actor.synthetics, selectors),
            domains: selectors,
            check: {
                type: "spell-attack-roll",
                modifiers: extractModifiers(actor.synthetics, attackSelectors),
                domains: attackSelectors,
            },
            dc: {
                modifiers: extractModifiers(actor.synthetics, saveSelectors),
                domains: saveSelectors,
            },
        });
    }

    async cast(spell: SpellPF2e, options: { level?: number } = {}): Promise<void> {
        const slotLevel = options.level ?? spell.level;
        try {
            spell.trickMagicEntry = this;
            await spell.toMessage(undefined, { data: { slotLevel } });
        } finally {
            spell.trickMagicEntry = null;
        }
    }
}
