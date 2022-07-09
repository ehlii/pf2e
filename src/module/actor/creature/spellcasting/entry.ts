import { CharacterPF2e, NPCPF2e } from "@actor";
import { AbilityString } from "@actor/types";
import { SpellPF2e } from "@item";
import { MagicTradition } from "@item/spell/types";
import { MAGIC_TRADITIONS } from "@item/spell/values";
import { OneToFour, OneToTen } from "@module/data";
import { Statistic, StatisticChatData } from "@system/statistic";
import { ErrorPF2e, sluggify } from "@util";
import { extractModifiers, extractNotes } from "@module/rules/util";
import { ModifierPF2e, MODIFIER_TYPE } from "@actor/modifiers";
import { PreparationType, SlotKey, SpellcastingEntry, SpellcastingEntryOptions, SpellSlotData } from "./types";
import { SpellCollection } from "./collection";

export class SpellcastingEntryPF2eNew implements SpellcastingEntry {
    id: string;
    name: string;
    ability: AbilityString;
    tradition: MagicTradition;
    prepared: { value: PreparationType; flexible?: boolean };
    spelldc: { value: number; dc: number; mod: number };
    statistic: Statistic;
    statisticData: StatisticChatData;
    proficiency: OneToFour;
    rank: OneToFour;
    showSlotlessLevels: boolean;
    sort: number;

    spells!: SpellCollection;
    highestLevel!: number;
    slots: Record<SlotKey, SpellSlotData>;

    autoHeightenLevel: OneToTen | null;

    constructor(public actor: CharacterPF2e | NPCPF2e, options: SpellcastingEntryOptions) {
        // Basic setup from options passed to constructor
        const {
            id,
            name,
            ability,
            tradition,
            prepared,
            proficiency,
            slots,
            showSlotlessLevels,
            sort,
            spelldc,
            autoHeightenLevel,
        } = options;

        this.id = id ? id : randomID(16);
        this.ability = ability || "int";
        this.tradition = tradition || "arcane";
        this.prepared = { value: prepared?.value ?? "innate", flexible: prepared?.flexible ?? undefined };
        this.spelldc = actor instanceof NPCPF2e && spelldc !== undefined ? spelldc : { value: 0, dc: 0, mod: 0 };
        this.name = name ? name : this.tradition + "-" + this.prepared.value + "-spells";
        this.showSlotlessLevels = showSlotlessLevels !== undefined ? showSlotlessLevels : true;
        this.sort = sort !== undefined ? sort : 1000000;
        this.autoHeightenLevel = autoHeightenLevel !== undefined ? autoHeightenLevel : null;

        // Set slots if passed, and if not, have a default
        if (slots) {
            this.slots = slots;
        } else {
            const slotsDefault: Record<any, SpellSlotData> = {};
            for (const key of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const) {
                const slotKey = `slot${key}` as const;
                const slotData = { max: 0, value: 0, prepared: [] };
                slotsDefault[slotKey] = slotData;
            }
            this.slots = slotsDefault;
        }

        // Figure out proficiencies and rank
        if (proficiency) {
            this.proficiency = proficiency;
        } else if (actor instanceof NPCPF2e) {
            this.proficiency = 1;
        } else {
            const { traditions } = actor.data.data.proficiencies;

            if (this.isInnate) {
                const allRanks = Array.from(MAGIC_TRADITIONS).map((t) => traditions[t].rank);
                this.proficiency = Math.max(1, ...allRanks) as OneToFour;
            } else {
                this.proficiency = Math.max(1, traditions[this.tradition].rank) as OneToFour;
            }
        }

        this.rank = this.proficiency;

        // Figure out statistic data
        const stat = this.generateStatistic();
        this.statistic = stat;
        this.statisticData = stat.getChatData();

        // Set spellcasting entry spells
        this.spells = new SpellCollection(this);
        const spells = actor.itemTypes.spell.filter((i) => i.data.data.location.value === this.id);
        for (const spell of spells) {
            this.spells.set(spell.id, spell);
        }
    }

    get isPrepared(): boolean {
        return this.prepared.value === "prepared";
    }

    get isFlexible(): boolean {
        return this.isPrepared && !!this.prepared.flexible;
    }

    get isSpontaneous(): boolean {
        return this.prepared.value === "spontaneous";
    }

    get isInnate(): boolean {
        return this.prepared.value === "innate";
    }

    get isFocusPool(): boolean {
        return this.prepared.value === "focus";
    }

    get isRitual(): boolean {
        return this.prepared.value === "ritual";
    }

    get rollOptions(): string[] {
        return [
            `spellcasting:${this.ability}`,
            `spellcasting:${this.tradition}`,
            `spellcasting:${this.prepared.value}`,
        ];
    }

    /** Returns a set of options that can be used to re-create this spellcasting entry */
    get entryData(): SpellcastingEntryOptions {
        return {
            id: this.id,
            name: this.name,
            ability: this.ability,
            tradition: this.tradition,
            prepared: this.prepared,
            slots: this.slots,
            showSlotlessLevels: this.showSlotlessLevels,
            proficiency: this.proficiency,
            sort: this.sort,
            autoHeightenLevel: this.autoHeightenLevel,
        };
    }

    generateStatistic(): Statistic {
        if (!this.actor) throw ErrorPF2e(`Cannot retrieve statistic for ${this.name}`);

        const { synthetics } = this.actor;
        const { rollNotes } = synthetics;
        const { ability, name, tradition, rank, rollOptions, spelldc } = this;

        const baseSelectors = ["all", `${ability}-based`, "spell-attack-dc"];
        const attackSelectors = [
            `${tradition}-spell-attack`,
            "spell-attack",
            "spell-attack-roll",
            "attack",
            "attack-roll",
        ];
        const saveSelectors = [`${tradition}-spell-dc`, "spell-dc"];

        if (this.actor instanceof CharacterPF2e) {
            const statistic = new Statistic(this.actor, {
                slug: sluggify(name),
                label: CONFIG.PF2E.magicTraditions[tradition],
                ability: ability,
                rank: rank,
                modifiers: extractModifiers(synthetics, baseSelectors),
                notes: extractNotes(rollNotes, [...baseSelectors, ...attackSelectors]),
                domains: baseSelectors,
                rollOptions: rollOptions,
                check: {
                    type: "spell-attack-roll",
                    modifiers: extractModifiers(synthetics, attackSelectors),
                    domains: attackSelectors,
                },
                dc: {
                    modifiers: extractModifiers(synthetics, saveSelectors),
                    domains: saveSelectors,
                },
            });

            return statistic;
        } else {
            // Has to be an NPC

            const baseMod = Number(spelldc.value ?? 0);
            const baseDC = Number(spelldc.dc ?? 0);
            const abilityMod = this.actor.data.data.abilities[ability].mod;

            const attackModifiers = [
                new ModifierPF2e("PF2E.BaseModifier", baseMod - abilityMod, MODIFIER_TYPE.UNTYPED),
                new ModifierPF2e(CONFIG.PF2E.abilities[ability], abilityMod, MODIFIER_TYPE.ABILITY),
                ...extractModifiers(synthetics, baseSelectors),
                ...extractModifiers(synthetics, attackSelectors),
            ];

            // Save Modifiers, reverse engineer using the user configured value - 10
            const saveModifiers = [
                new ModifierPF2e("PF2E.BaseModifier", baseDC - 10 - abilityMod, MODIFIER_TYPE.UNTYPED),
                new ModifierPF2e(CONFIG.PF2E.abilities[ability], abilityMod, MODIFIER_TYPE.ABILITY),
                ...extractModifiers(synthetics, baseSelectors),
                ...extractModifiers(synthetics, saveSelectors),
            ];

            // Generate statistic from the data
            const statistic = new Statistic(this.actor, {
                slug: sluggify(name),
                label: CONFIG.PF2E.magicTraditions[tradition],
                notes: extractNotes(rollNotes, [...baseSelectors, ...attackSelectors]),
                domains: baseSelectors,
                rollOptions: rollOptions,
                check: {
                    type: "spell-attack-roll",
                    modifiers: attackModifiers,
                    domains: attackSelectors,
                },
                dc: {
                    modifiers: saveModifiers,
                    domains: saveSelectors,
                },
            });

            return statistic;
        }
    }

    /**
     * Adds a spell to a spellcasting entry, either moving it from another one if its the same actor,
     * or creating a new spell if its not.
     */
    async addSpell(spell: SpellPF2e, targetLevel?: number): Promise<SpellPF2e | null> {
        return this.spells.addSpell(spell, targetLevel);
    }

    /** For prepared spellcasting slots: saves the prepared spell slot data to the spellcasting entry */
    async prepareSpell(spell: SpellPF2e, spellLevel: number, spellSlot: number): Promise<void> {
        if (spell.baseLevel > spellLevel && !(spellLevel === 0 && spell.isCantrip)) {
            console.warn(`Attempted to add level ${spell.baseLevel} spell to level ${spellLevel} spell slot.`);
            return;
        }

        if (CONFIG.debug.hooks) {
            console.debug(
                `PF2e System | Updating location for spell ${spell.name} to match spellcasting entry ${this.id}`
            );
        }

        const key = `slots.slot${spellLevel}.prepared.${spellSlot}`;
        const updates: Record<string, unknown> = { [key]: { id: spell.id } };

        const slot = this.slots[`slot${spellLevel}` as SlotKey].prepared[spellSlot];
        if (slot) {
            if (slot.prepared !== undefined) {
                updates[`${key}.-=prepared`] = null;
            }
            if (slot.name !== undefined) {
                updates[`${key}.-=name`] = null;
            }
        }

        const entries = this.actor.data.data.spellcastingEntries;
        entries.filter((e) => e.id === this.id).map((e) => mergeObject(e, updates));

        await this.actor.update({ "data.spellcastingEntries": entries });
    }

    /** For prepared spellcasting slots: removes the spell slot and updates the spellcasting entry */
    async unprepareSpell(spellLevel: number, spellSlot: number): Promise<void> {
        if (CONFIG.debug.hooks === true) {
            console.debug(
                `PF2e System | Updating spellcasting entry ${this.id} to remove spellslot ${spellSlot} for spell level ${spellLevel}`
            );
        }

        const key = `slots.slot${spellLevel}.prepared.${spellSlot}`;
        const updates: Record<string, unknown> = {
            [key]: {
                name: game.i18n.localize("PF2E.SpellSlotEmpty"),
                id: null,
                prepared: false,
                expended: false,
            },
        };

        const entries = this.actor.data.data.spellcastingEntries;
        entries.filter((e) => e.id === this.id).map((e) => mergeObject(e, updates));

        await this.actor.update({ "data.spellcastingEntries": entries });
    }

    /** Sets the expended state of a spell slot and updates the spellcasting entry */
    async setSlotExpendedState(spellLevel: number, spellSlot: number, isExpended: boolean): Promise<void> {
        const key = `slots.slot${spellLevel}.prepared.${spellSlot}.expended`;
        const updates = { [key]: isExpended };

        const entries = this.actor.data.data.spellcastingEntries;
        entries.filter((e) => e.id === this.id).map((e) => mergeObject(e, updates));

        await this.actor.update({ "data.spellcastingEntries": entries });
    }
}
