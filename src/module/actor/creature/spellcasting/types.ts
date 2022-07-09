import { AbilityString } from "@actor/types";
import { SpellPF2e } from "@item";
import { MagicTradition } from "@item/spell/types";
import { OneToFour, OneToTen, ZeroToTen, ZeroToEleven } from "@module/data";
import { Statistic, StatisticChatData, StatisticCompatData } from "@system/statistic";

// temporary type until the spellcasting entry is migrated to no longer use slotX keys
type SlotKey = `slot${ZeroToEleven}`;

type PreparationType = keyof ConfigPF2e["PF2E"]["preparationType"];

interface SpellPrepData {
    id: string | null;
    expended?: boolean;
    name?: string;
    prepared?: boolean;
}

interface SpellSlotData {
    prepared: Record<number, SpellPrepData>;
    value: number;
    max: number;
}

interface BaseSpellcastingEntry {
    id: string;
    name: string;
    ability: AbilityString;
    tradition: MagicTradition;
    statistic: Statistic | StatisticCompatData;
}

interface SpellcastingEntry extends BaseSpellcastingEntry {
    isPrepared: boolean;
    isSpontaneous: boolean;
    isInnate: boolean;
    isFocusPool: boolean;
    spelldc: {
        value: number;
        dc: number;
        mod: number;
    };
    statisticData: StatisticChatData;
    prepared: {
        value: PreparationType;
        flexible?: boolean;
    };
    showSlotlessLevels: boolean;
    proficiency: OneToFour;
    rank: OneToFour;
    slots: Record<SlotKey, SpellSlotData>;
    autoHeightenLevel: OneToTen | null;
    sort: number;
}

interface SpellcastingEntryOptions {
    id?: string;
    name?: string;
    ability?: AbilityString | "";
    tradition?: MagicTradition | "";
    prepared?: {
        value?: PreparationType;
        flexible?: boolean;
    };
    spells?: Collection<Embedded<SpellPF2e>> | null;
    slots?: Record<SlotKey, SpellSlotData>;
    showSlotlessLevels?: boolean;
    proficiency?: OneToFour;
    sort?: number;
    spelldc?: {
        value: number;
        dc: number;
        mod: number;
    };
    autoHeightenLevel?: OneToTen | null;
}

/** Sheet render data types */
interface SpellcastingSlotLevel {
    label: string;
    level: ZeroToTen;
    isCantrip: boolean;

    /**
     * Number of uses and max slots or spells.
     * If this is null, allowed usages are infinite.
     * If value is undefined then it's not expendable, it's a count of total spells instead.
     */
    uses?: {
        value?: number;
        max: number;
    };

    active: (ActiveSpell | null)[];
}

interface SpellPrepEntry {
    spell: Embedded<SpellPF2e>;
    signature?: boolean;
}

interface ActiveSpell {
    spell: Embedded<SpellPF2e>;
    chatData: Record<string, unknown>;
    expended?: boolean;
    /** Is this spell marked as signature/collection */
    signature?: boolean;
    /** Is the spell not actually of this level? */
    virtual?: boolean;
}

/** Final render data used for showing a spell list  */
interface SpellListData {
    id: string;
    name: string;
    levels: SpellcastingSlotLevel[];
}

/** Spell list render data for a SpellcastingEntryPF2e */
interface SpellcastingEntryListData extends SpellListData {
    statistic: StatisticChatData;
    tradition: MagicTradition;
    castingType: PreparationType;
    proficiency: OneToFour;
    ability: AbilityString;
    isPrepared?: boolean;
    isSpontaneous?: boolean;
    isFlexible?: boolean;
    isInnate?: boolean;
    isFocusPool?: boolean;
    isRitual?: boolean;
    showSlotlessLevels?: boolean;
    flexibleAvailable?: { value: number; max: number };
    spellPrepList: Record<number, SpellPrepEntry[]> | null;
}

export {
    ActiveSpell,
    BaseSpellcastingEntry,
    PreparationType,
    SlotKey,
    SpellcastingEntry,
    SpellcastingEntryListData,
    SpellcastingEntryOptions,
    SpellcastingSlotLevel,
    SpellPrepEntry,
    SpellSlotData,
};
