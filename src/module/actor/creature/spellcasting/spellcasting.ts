import { CharacterPF2e, NPCPF2e } from "@actor";
import { ConsumablePF2e, SpellPF2e } from "@item";
import { goesToEleven, OneToTen, ZeroToTen } from "@module/data";
import { ErrorPF2e, groupBy, tupleHasValue } from "@util";
import { TrickMagicItemEntry } from "./trick";
import {
    ActiveSpell,
    BaseSpellcastingEntry,
    SlotKey,
    SpellcastingEntryListData,
    SpellcastingEntryOptions,
    SpellcastingSlotLevel,
    SpellPrepEntry,
} from "./types";
import { SpellcastingEntryPF2eNew } from "./entry";
import { SpellCollection } from "./collection";

export class ActorSpellcastingNew extends Collection<SpellcastingEntryPF2eNew> {
    constructor(public readonly actor: CharacterPF2e | NPCPF2e, entries: SpellcastingEntryPF2eNew[]) {
        super(entries?.map((entry) => [entry.id, entry]));

        const collections = new Collection<SpellCollection>();
        this.contents.map((entry) => {
            collections.set(entry.spells.id, entry.spells);
        });
        this.collections = collections;
    }

    /** All available spell lists on this actor */
    collections: Collection<SpellCollection>;

    /** Returns a list of entries pre-filtered to SpellcastingEntryPF2e */
    get regular() {
        return this.contents;
    }

    /**
     * All spellcasting entries that count as prepared/spontaneous, which qualify as a
     * full fledged spellcasting feature for wands and scrolls.
     */
    get spellcastingFeatures() {
        return this.regular.filter((entry) => entry.isPrepared || entry.isSpontaneous);
    }

    async createSpellcastingEntry(options: SpellcastingEntryOptions): Promise<void> {
        const entry = new SpellcastingEntryPF2eNew(this.actor, options);

        const updatedEntries = this.actor.data.data.spellcastingEntries.concat(entry.entryData);
        await this.actor.update({ "data.spellcastingEntries": updatedEntries });
    }

    async editSpellcastingEntry(options: SpellcastingEntryOptions): Promise<void> {
        if (!options.id) return;

        const entries = this.actor.data.data.spellcastingEntries;

        entries.filter((entry) => entry.id === options.id).map((entry) => mergeObject(entry, options));

        await this.actor.update({ "data.spellcastingEntries": entries });
    }

    async deleteSpellcastingEntry(id: string): Promise<void> {
        await this.actor.update({
            "data.spellcastingEntries": this.actor.data.data.spellcastingEntries.filter((entry) => entry.id !== id),
        });
    }

    async sortEntryBefore(id: string, dropTarget: string): Promise<void> {
        const entryToSort = this.get(id);
        const entryToRelativeTo = this.get(dropTarget);

        if (!entryToSort || !entryToRelativeTo) return;

        const entries = this.contents;

        const currIndex = entries.findIndex((entry) => entry.id === entryToSort.id);
        const newIndex = Math.clamped(
            entries.findIndex((entry) => entry.id === entryToRelativeTo.id),
            0,
            entries.length - 1
        );

        // reset all sort values to current position in array
        entries.map((entry, i) => mergeObject(entry, { sort: i }));

        // Increase or decrease values as needed to reposition the new entry
        entries.map((entry, i) => {
            if (entry.id === entryToSort.id) {
                mergeObject(entry, { sort: newIndex });
            } else if (currIndex > newIndex && i >= newIndex) {
                // Moving backwards in the list, position before
                mergeObject(entry, { sort: i + 1 });
            } else if (currIndex < newIndex && i <= newIndex) {
                // Moving forward in the list, position after
                mergeObject(entry, { sort: i - 1 });
            }
        });

        await this.actor.update({ "data.spellcastingEntries": entries.map((entry) => entry.entryData) });
    }

    async deleteAll(): Promise<void> {
        this.actor.update({ "data.spellcastingEntries": [] });
    }

    /** Checks to see if we have an entry that matches the tradition of the consumable */
    canCastConsumable(item: ConsumablePF2e): boolean {
        const spellData = item.data.data.spell?.data?.data;
        return (
            !!spellData &&
            this.spellcastingFeatures.some((entry) => tupleHasValue(spellData.traditions.value, entry.tradition))
        );
    }

    /** Casts the given spell as part of a specific spellcasting entry */
    /** Can be either a real spellcasting entry, or a trick item entry */
    async cast(
        entry: BaseSpellcastingEntry,
        spell: SpellPF2e,
        options: { slot?: number; level?: number; consume?: boolean; message?: boolean }
    ): Promise<void> {
        if (entry instanceof SpellcastingEntryPF2eNew) {
            const consume = options.consume ?? true;
            const message = options.message ?? true;
            const level = options.level ?? spell.level;
            const valid = !consume || spell.isCantrip || (await this.consume(entry, spell, level, options.slot));
            if (message && valid) {
                await spell.toMessage(undefined, { data: { spellLvl: level } });
            }
        } else if (entry instanceof TrickMagicItemEntry) {
            const level = options.level ?? spell.level;
            try {
                spell.trickMagicEntry = entry;
                await spell.toMessage(undefined, { data: { spellLvl: level } });
            } finally {
                spell.trickMagicEntry = null;
            }
        } else {
            throw ErrorPF2e("Cannot find spellcasting entry");
        }
    }

    /** Consumes a specific spellslot */
    async consume(entry: SpellcastingEntryPF2eNew, spell: SpellPF2e, level: number, slot?: number): Promise<boolean> {
        if (entry.isRitual) return true;

        if (entry.isFocusPool) {
            const currentPoints = this.actor.data.data.resources.focus?.value ?? 0;
            if (currentPoints > 0) {
                await this.actor.update({ "data.resources.focus.value": currentPoints - 1 });
                return true;
            } else {
                ui.notifications.warn(game.i18n.localize("PF2E.Focus.NotEnoughFocusPointsError"));
                return false;
            }
        }

        const levelLabel = game.i18n.localize(CONFIG.PF2E.spellLevels[level as OneToTen]);
        const slotKey = goesToEleven(level) ? (`slot${level}` as const) : "slot0";
        if (entry.slots === null) {
            return false;
        }

        // For prepared spells, we deduct the slot. We use the given one or try to find a good match
        if (entry.isPrepared && !entry.isFlexible) {
            const preparedData = entry.slots[slotKey].prepared;
            slot ??= Number(
                Object.entries(preparedData)
                    .filter(([_, slot]) => slot.id === spell.id && !slot.expended)
                    .at(0)?.[0]
            );

            if (!Number.isInteger(slot)) {
                throw ErrorPF2e("Slot not given for prepared spell, and no alternative slot was found");
            }

            const isExpended = preparedData[slot].expended ?? false;
            if (isExpended) {
                ui.notifications.warn(game.i18n.format("PF2E.SpellSlotExpendedError", { name: spell.name }));
                return false;
            }

            await entry.setSlotExpendedState(level, slot, true);
            return true;
        }

        if (entry.isInnate) {
            const remainingUses = spell.data.data.location.uses?.value || 0;
            if (remainingUses <= 0) {
                ui.notifications.warn(game.i18n.format("PF2E.SpellSlotExpendedError", { name: spell.name }));
                return false;
            }

            await spell.update({ "data.location.uses.value": remainingUses - 1 });
            return true;
        }

        const slots = entry.slots[slotKey];
        if (slots.value > 0) {
            await this.editSpellcastingEntry({ id: entry.id, [`slots.${slotKey}.value`]: slots.value - 1 });
            return true;
        } else {
            ui.notifications.warn(
                game.i18n.format("PF2E.SpellSlotNotEnoughError", { name: spell.name, level: levelLabel })
            );
            return false;
        }
    }

    /** Returns rendering data to display the spellcasting entry in the sheet */
    getSpellData(entry: SpellcastingEntryPF2eNew): SpellcastingEntryListData;
    getSpellData(id: string): SpellcastingEntryListData;
    getSpellData(entryOrId: SpellcastingEntryPF2eNew | string): SpellcastingEntryListData {
        const entry = entryOrId instanceof SpellcastingEntryPF2eNew ? entryOrId : this.get(entryOrId);

        if (!(entry instanceof SpellcastingEntryPF2eNew)) {
            throw ErrorPF2e("Cannot find spellcasting entry");
        }

        const { actor } = this;

        const results: SpellcastingSlotLevel[] = [];
        const spells = entry.spells?.contents.sort((s1, s2) => (s1.data.sort || 0) - (s2.data.sort || 0)) ?? [];
        const signatureSpells = spells.filter((s) => s.data.data.location.signature);

        if (entry.isPrepared) {
            // Prepared Spells. Active spells are what's been prepped.
            for (let level = 0; level <= entry.highestLevel; level++) {
                const data = entry.slots[`slot${level}` as SlotKey];

                // Detect which spells are active. If flexible, it will be set later via signature spells
                const active: (ActiveSpell | null)[] = [];
                const showLevel = entry.showSlotlessLevels || data.max > 0;
                if (showLevel && (level === 0 || !entry.isFlexible)) {
                    const maxPrepared = Math.max(data.max, 0);
                    active.push(...Array(maxPrepared).fill(null));
                    for (const [key, value] of Object.entries(data.prepared)) {
                        const spell = value.id ? entry.spells?.get(value.id) : null;
                        if (spell) {
                            active[Number(key)] = {
                                spell,
                                chatData: spell.getChatData(),
                                expended: !!value.expended,
                            };
                        }
                    }
                }

                results.push({
                    label: level === 0 ? "PF2E.TraitCantrip" : CONFIG.PF2E.spellLevels[level as OneToTen],
                    level: level as ZeroToTen,
                    uses: {
                        value: level > 0 && entry.isFlexible ? data.value || 0 : undefined,
                        max: data.max,
                    },
                    isCantrip: level === 0,
                    active,
                });
            }
        } else if (entry.isFocusPool) {
            // Focus Spells. All non-cantrips are grouped together as they're auto-scaled
            const cantrips = spells.filter((spell) => spell.isCantrip);
            const leveled = spells.filter((spell) => !spell.isCantrip);

            if (cantrips.length) {
                results.push({
                    label: "PF2E.TraitCantrip",
                    level: 0,
                    isCantrip: true,
                    active: cantrips.map((spell) => ({ spell, chatData: spell.getChatData() })),
                });
            }

            if (leveled.length) {
                results.push({
                    label: "PF2E.Focus.label",
                    level: Math.max(1, Math.ceil(actor.level / 2)) as OneToTen,
                    isCantrip: false,
                    uses: actor.data.data.resources.focus ?? { value: 0, max: 0 },
                    active: leveled.map((spell) => ({ spell, chatData: spell.getChatData() })),
                });
            }
        } else {
            // Everything else (Innate/Spontaneous/Ritual)
            const alwaysShowHeader = !entry.isRitual;
            const spellsByLevel = groupBy(spells, (spell) => (spell.isCantrip ? 0 : spell.level));
            for (let level = 0; level <= entry.highestLevel; level++) {
                const data = entry.slots[`slot${level}` as SlotKey];
                const spells = spellsByLevel.get(level) ?? [];
                if (alwaysShowHeader || spells.length) {
                    const uses = entry.isSpontaneous && level !== 0 ? { value: data.value, max: data.max } : undefined;
                    const active = spells.map((spell) => ({
                        spell,
                        chatData: spell.getChatData(),
                        expended: entry.isInnate && !spell.data.data.location.uses?.value,
                        uses: entry.isInnate && !spell.unlimited ? spell.data.data.location.uses : undefined,
                    }));

                    // These entries hide if there are no active spells at that level, or if there are no spell slots
                    const hideForSpontaneous = entry.isSpontaneous && uses?.max === 0 && active.length === 0;
                    const hideForInnate = entry.isInnate && active.length === 0;
                    if (!entry.showSlotlessLevels && (hideForSpontaneous || hideForInnate)) continue;

                    results.push({
                        label: level === 0 ? "PF2E.TraitCantrip" : CONFIG.PF2E.spellLevels[level as OneToTen],
                        level: level as ZeroToTen,
                        isCantrip: level === 0,
                        uses,
                        active,
                    });
                }
            }
        }

        // Handle signature spells, we need to add signature spells to each spell level
        if (entry.isSpontaneous || entry.isFlexible) {
            for (const spell of signatureSpells) {
                for (const result of results) {
                    if (spell.baseLevel > result.level) continue;
                    if (!entry.showSlotlessLevels && result.uses?.max === 0) continue;

                    const existing = result.active.find((a) => a?.spell.id === spell.id);
                    if (existing) {
                        existing.signature = true;
                    } else {
                        const chatData = spell.getChatData({}, { spellLvl: result.level });
                        result.active.push({ spell, chatData, signature: true, virtual: true });
                    }
                }
            }
        }

        // If flexible, the limit is the number of slots, we need to notify the user
        const flexibleAvailable = (() => {
            if (!entry.isFlexible) return undefined;
            const totalSlots = results
                .filter((result) => !result.isCantrip)
                .map((level) => level.uses?.max || 0)
                .reduce((first, second) => first + second, 0);
            return { value: signatureSpells.length, max: totalSlots };
        })();

        return {
            id: entry.id,
            name: entry.name,
            statistic: entry.statisticData,
            tradition: entry.tradition,
            proficiency: entry.proficiency,
            ability: entry.ability,
            castingType: entry.prepared.value,
            isPrepared: entry.isPrepared,
            isSpontaneous: entry.isSpontaneous,
            isFlexible: entry.isFlexible,
            isInnate: entry.isInnate,
            isFocusPool: entry.isFocusPool,
            isRitual: entry.isRitual,
            showSlotlessLevels: entry.showSlotlessLevels,
            flexibleAvailable,
            levels: results,
            spellPrepList: this.getSpellPrepList(entry, spells),
        };
    }

    private getSpellPrepList(entry: SpellcastingEntryPF2eNew, spells: Embedded<SpellPF2e>[]) {
        if (!entry.isPrepared) return {};

        const spellPrepList: Record<number, SpellPrepEntry[]> = {};
        const spellsByLevel = groupBy(spells, (spell) => (spell.isCantrip ? 0 : spell.baseLevel));
        for (let level = 0; level <= entry.highestLevel; level++) {
            // Build the prep list
            spellPrepList[level] =
                spellsByLevel.get(level as ZeroToTen)?.map((spell) => ({
                    spell,
                    signature: entry.isFlexible && spell.data.data.location.signature,
                })) ?? [];
        }

        return Object.values(spellPrepList).some((s) => !!s.length) ? spellPrepList : null;
    }

    refocus(options: { all?: boolean } = {}) {
        if (!options.all) {
            throw ErrorPF2e("Actors do not currently support regular refocusing");
        }

        const focus = this.actor.data.data.resources.focus;

        const rechargeFocus = focus?.max && focus.value < focus.max;
        if (focus && rechargeFocus) {
            focus.value = focus.max;
            return { "data.resources.focus.value": focus.value };
        }

        return null;
    }

    /**
     * Recharges all spellcasting entries based on the type of entry it is
     * @todo Support a timespan property of some sort and handle 1/hour innate spells
     * @todo Fix regular refocus?
     */
    recharge() {
        type SpellcastingUpdate = EmbeddedDocumentUpdateData<SpellPF2e> | EmbeddedDocumentUpdateData<SpellPF2e>[];

        const entries = this.contents;

        const itemUpdates = entries.flatMap((entry): SpellcastingUpdate => {
            if (!(entry instanceof SpellcastingEntryPF2eNew)) return [];

            // Innate spells should refresh uses
            if (entry.isInnate) {
                return (
                    entry.spells?.map((spell) => {
                        const value = spell.data.data.location.uses?.max ?? 1;
                        return { _id: spell.id, "data.location.uses.value": value };
                    }) ?? []
                );
            }

            return [];
        });

        entries
            .filter((entry) => !entry.isFocusPool && !entry.isInnate) // Spontaneous and Prepared spells
            .map((entry) => {
                const slots = entry.slots;
                for (const slot of Object.values(slots)) {
                    if (entry.isPrepared && !entry.isFlexible) {
                        for (const preparedSpell of Object.values(slot.prepared)) {
                            if (preparedSpell.expended) {
                                preparedSpell.expended = false;
                            }
                        }
                    } else if (slot.value < slot.max) {
                        slot.value = slot.max;
                    }
                }
            });

        const focus = this.actor.data.data.resources.focus;

        const rechargeFocus = focus?.max && focus.value < focus.max;
        const actorUpdates =
            focus && rechargeFocus
                ? { "data.resources.focus.value": focus.max, "data.spellcastingEntries": entries }
                : { "data.spellcastingEntries": entries.map((entry) => entry.entryData) };

        return { itemUpdates, actorUpdates };
    }
}
