import { ActorPF2e } from "@actor";
import { ModifierPF2e, MODIFIER_TYPE, StatisticModifier } from "@actor/modifiers";
import { SaveType } from "@actor/types";
import { SAVE_TYPES } from "@actor/values";
import { ItemType } from "@item/data";
import { Rarity } from "@module/data";
import { extractModifiers, extractNotes } from "@module/rules/util";
import { Statistic } from "@system/statistic";
import { HazardData } from "./data";

export class HazardPF2e extends ActorPF2e {
    override get allowedItemTypes(): (ItemType | "physical")[] {
        return [...super.allowedItemTypes, "action", "melee"];
    }

    get rarity(): Rarity {
        return this.system.traits.rarity;
    }

    get isComplex(): boolean {
        return this.system.details.isComplex;
    }

    /** Minimal check since the disabled status of a hazard isn't logged */
    override get canAttack(): boolean {
        return this.itemTypes.melee.length > 0;
    }

    override prepareBaseData(): void {
        super.prepareBaseData();

        const { attributes, details } = this.system;
        attributes.initiative = { tiebreakPriority: this.hasPlayerOwner ? 2 : 1 };

        attributes.hp.negativeHealing = false;
        attributes.hp.brokenThreshold = Math.floor(attributes.hp.max / 2);
        attributes.hasHealth = attributes.hp.max > 0;
        details.alliance = null;
    }

    override prepareDerivedData(): void {
        super.prepareDerivedData();

        const { data } = this.data;

        this.prepareSynthetics();

        // Armor Class
        {
            const base = data.attributes.ac.value;
            const domains = ["ac", "dex-based", "all"];
            const modifiers = [
                new ModifierPF2e("PF2E.BaseModifier", base, MODIFIER_TYPE.UNTYPED),
                ...extractModifiers(this.synthetics, domains, { test: this.getRollOptions(domains) }),
            ];

            const stat = mergeObject(new StatisticModifier("ac", modifiers), data.attributes.ac, {
                overwrite: false,
            });
            stat.base = base;
            stat.value = stat.totalModifier;
            stat.breakdown = stat.modifiers
                .filter((m) => m.enabled)
                .map((m) => `${m.label} ${m.modifier < 0 ? "" : "+"}${m.modifier}`)
                .join(", ");

            data.attributes.ac = stat;
        }

        this.saves = this.prepareSaves();
    }

    protected prepareSaves(): { [K in SaveType]?: Statistic } {
        const data = this.system;
        const { rollNotes } = this.synthetics;

        // Saving Throws
        return SAVE_TYPES.reduce((saves: { [K in SaveType]?: Statistic }, saveType) => {
            const save = data.saves[saveType];
            const saveName = game.i18n.localize(CONFIG.PF2E.saves[saveType]);
            const base = save.value;
            const ability = CONFIG.PF2E.savingThrowDefaultAbilities[saveType];

            // Saving Throws with a value of 0 are not usable by the hazard
            // Later on we'll need to explicitly check for null, since 0 is supposed to be valid
            if (!base) return saves;

            const selectors = [saveType, `${ability}-based`, "saving-throw", "all"];
            const stat = new Statistic(this, {
                slug: saveType,
                label: saveName,
                notes: extractNotes(rollNotes, selectors),
                domains: selectors,
                modifiers: [
                    new ModifierPF2e("PF2E.BaseModifier", base, MODIFIER_TYPE.UNTYPED),
                    ...extractModifiers(this.synthetics, selectors),
                ],
                check: {
                    type: "saving-throw",
                },
                dc: {},
            });

            mergeObject(this.system.saves[saveType], stat.getCompatData());

            saves[saveType] = stat;
            return saves;
        }, {});
    }
}

export interface HazardPF2e {
    readonly data: HazardData;

    saves: { [K in SaveType]?: Statistic };
}
