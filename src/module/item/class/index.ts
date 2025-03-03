import { FeatSlotLevel } from "@actor/character/feats";
import { SaveType } from "@actor/types";
import { SAVE_TYPES, SKILL_ABBREVIATIONS } from "@actor/values";
import { ABCItemPF2e, FeatPF2e } from "@item";
import { ARMOR_CATEGORIES } from "@item/armor/data";
import { WEAPON_CATEGORIES } from "@item/weapon/values";
import { ZeroToFour } from "@module/data";
import { setHasElement, sluggify } from "@util";
import { ClassData, ClassTrait } from "./data";

class ClassPF2e extends ABCItemPF2e {
    get attacks() {
        return this.system.attacks;
    }

    get defenses() {
        return this.system.defenses;
    }

    get classDC(): ZeroToFour {
        return this.system.classDC;
    }

    get hpPerLevel(): number {
        return this.system.hp;
    }

    get perception(): ZeroToFour {
        return this.system.perception;
    }

    get savingThrows(): Record<SaveType, ZeroToFour> {
        return this.system.savingThrows;
    }

    get grantedFeatSlots() {
        const actorLevel = this.actor?.level ?? 0;
        const filterLevels = (levels: number[]) => levels.filter((level) => actorLevel >= level) ?? [];
        const system = this.system;

        const ancestryLevels: FeatSlotLevel[] = filterLevels(system.ancestryFeatLevels.value);
        if (game.settings.get("pf2e", "ancestryParagonVariant")) {
            ancestryLevels.unshift({ id: "ancestry-bonus", label: "1" });
            for (let level = 3; level <= actorLevel; level += 4) {
                const index = (level + 1) / 2;
                ancestryLevels.splice(index, 0, level);
            }
        }

        return {
            ancestry: ancestryLevels,
            class: filterLevels(system.classFeatLevels.value),
            skill: filterLevels(system.skillFeatLevels.value),
            general: filterLevels(system.generalFeatLevels.value),
        };
    }

    /** Include all class features in addition to any with the expected location ID */
    override getLinkedFeatures(): Embedded<FeatPF2e>[] {
        if (!this.actor) return [];

        return Array.from(
            new Set([
                ...super.getLinkedFeatures(),
                ...this.actor.itemTypes.feat.filter((f) => f.featType === "classfeature"),
            ])
        );
    }

    override prepareBaseData(): void {
        super.prepareBaseData();

        const { keyAbility } = this.system;
        keyAbility.selected ??= keyAbility.value.length === 1 ? keyAbility.value[0]! : null;
    }

    /** Prepare a character's data derived from their class */
    override prepareActorData(this: Embedded<ClassPF2e>): void {
        if (!this.actor.isOfType("character")) {
            console.error("Only a character can have a class");
            return;
        }

        this.actor.class = this;
        const { attributes, build, details, martial, saves, skills } = this.actor.system;

        // Add base key ability options

        const { keyAbility } = this.system;
        build.abilities.keyOptions = [...keyAbility.value];
        build.abilities.boosts.class = keyAbility.selected;

        attributes.classhp = this.hpPerLevel;

        attributes.perception.rank = Math.max(attributes.perception.rank, this.perception) as ZeroToFour;
        this.logAutoChange("system.attributes.perception.rank", this.perception);

        attributes.classDC.rank = Math.max(attributes.classDC.rank, this.classDC) as ZeroToFour;
        this.logAutoChange("system.attributes.classDC.rank", this.classDC);

        for (const category of ARMOR_CATEGORIES) {
            martial[category].rank = Math.max(martial[category].rank, this.defenses[category]) as ZeroToFour;
            this.logAutoChange(`data.martial.${category}.rank`, this.defenses[category]);
        }

        for (const category of WEAPON_CATEGORIES) {
            martial[category].rank = Math.max(martial[category].rank, this.attacks[category]) as ZeroToFour;
            this.logAutoChange(`data.martial.${category}.rank`, this.attacks[category]);
        }

        for (const saveType of SAVE_TYPES) {
            saves[saveType].rank = Math.max(saves[saveType].rank, this.savingThrows[saveType]) as ZeroToFour;
            this.logAutoChange(`data.saves.${saveType}.rank`, this.savingThrows[saveType]);
        }

        for (const trainedSkill of this.system.trainedSkills.value) {
            if (setHasElement(SKILL_ABBREVIATIONS, trainedSkill)) {
                skills[trainedSkill].rank = Math.max(skills[trainedSkill].rank, 1) as ZeroToFour;
            }
        }

        const slug = this.slug ?? sluggify(this.name);
        details.class = { name: this.name, trait: slug };
        this.actor.rollOptions.all[`class:${slug}`] = true;
    }
}

interface ClassPF2e {
    readonly data: ClassData;

    get slug(): ClassTrait | null;
}

export { ClassPF2e };
