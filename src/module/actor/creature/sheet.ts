import { CreaturePF2e } from "@actor";
import { CharacterStrike } from "@actor/character/data";
import { NPCStrike } from "@actor/npc/data";
import { CreatureSheetItemRenderer } from "@actor/sheet/item-summary-renderer";
import { ABILITY_ABBREVIATIONS, SKILL_DICTIONARY } from "@actor/values";
import { ConditionPF2e, PhysicalItemPF2e, SpellcastingEntryPF2e, SpellPF2e } from "@item";
import { ITEM_CARRY_TYPES } from "@item/data/values";
import { goesToEleven, ZeroToFour } from "@module/data";
import { createSheetTags } from "@module/sheet/helpers";
import { eventToRollParams } from "@scripts/sheet-util";
import { ErrorPF2e, fontAwesomeIcon, objectHasKey, setHasElement, tupleHasValue } from "@util";
import { ActorSheetPF2e } from "../sheet/base";
import { CreatureConfig } from "./config";
import { SkillData } from "./data";
import { CreatureSheetData, SpellcastingSheetData } from "./types";

/**
 * Base class for NPC and character sheets
 * @category Actor
 */
export abstract class CreatureSheetPF2e<TActor extends CreaturePF2e> extends ActorSheetPF2e<TActor> {
    override itemRenderer = new CreatureSheetItemRenderer(this);

    /** A DocumentSheet class presenting additional, per-actor settings */
    protected abstract readonly actorConfigClass: ConstructorOf<CreatureConfig<CreaturePF2e>> | null;

    override async getData(options?: ActorSheetOptions): Promise<CreatureSheetData<TActor>> {
        const sheetData = await super.getData(options);
        const { actor } = this;

        // Update save labels
        if (sheetData.data.saves) {
            for (const key of ["fortitude", "reflex", "will"] as const) {
                const save = sheetData.data.saves[key];
                save.icon = this.getProficiencyIcon(save.rank);
                save.hover = CONFIG.PF2E.proficiencyLevels[save.rank];
                save.label = CONFIG.PF2E.saves[key];
            }
        }

        // Update proficiency label
        if (sheetData.data.attributes !== undefined) {
            sheetData.data.attributes.perception.icon = this.getProficiencyIcon(
                sheetData.data.attributes.perception.rank
            );
            sheetData.data.attributes.perception.hover =
                CONFIG.PF2E.proficiencyLevels[sheetData.data.attributes.perception.rank];
        }

        // Ability Scores
        if (sheetData.data.abilities) {
            for (const key of ABILITY_ABBREVIATIONS) {
                sheetData.data.abilities[key].label = CONFIG.PF2E.abilities[key];
            }
        }

        // Update skill labels
        if (sheetData.data.skills) {
            const skills: Record<string, SkillData & Record<string, string>> = sheetData.data.skills;
            const mainSkills: Record<string, string> = CONFIG.PF2E.skills;
            for (const key in skills) {
                const skill = skills[key];
                skill.icon = this.getProficiencyIcon(skill.rank);
                skill.hover = CONFIG.PF2E.proficiencyLevels[skill.rank];
                skill.label = skill.label ?? mainSkills[key];
            }
        }

        return {
            ...sheetData,
            languages: createSheetTags(CONFIG.PF2E.languages, actor.system.traits.languages),
            abilities: CONFIG.PF2E.abilities,
            skills: CONFIG.PF2E.skills,
            actorSizes: CONFIG.PF2E.actorSizes,
            alignments: deepClone(CONFIG.PF2E.alignments),
            rarity: CONFIG.PF2E.rarityTraits,
            frequencies: CONFIG.PF2E.frequencies,
            attitude: CONFIG.PF2E.attitude,
            pfsFactions: CONFIG.PF2E.pfsFactions,
            conditions: game.pf2e.ConditionManager.getFlattenedConditions(actor.itemTypes.condition),
            dying: {
                maxed: actor.attributes.dying.value >= actor.attributes.dying.max,
                remainingDying: Math.max(actor.attributes.dying.max - actor.attributes.dying.value),
                remainingWounded: Math.max(actor.attributes.wounded.max - actor.attributes.wounded.value),
            },
        };
    }

    protected prepareSpellcasting(): SpellcastingSheetData[] {
        return this.actor.spellcasting
            .map((entry) => {
                const data = entry.toObject(false);
                const spellData = entry.getSpellData();
                return mergeObject(data, spellData);
            })
            .sort((a, b) => a.sort - b.sort);
    }

    /** Get the font-awesome icon used to display a certain level of skill proficiency */
    protected getProficiencyIcon(level: ZeroToFour): string {
        return [...Array(level)].map(() => fontAwesomeIcon("check-circle").outerHTML).join("");
    }

    /** Preserve browser focus on unnamed input elements when updating */
    protected override async _render(force?: boolean, options?: RenderOptions): Promise<void> {
        const focused = document.activeElement;
        const contained = this.element.get(0)?.contains(focused);

        await super._render(force, options);

        if (focused instanceof HTMLInputElement && focused.name && contained) {
            const selector = `input[data-property="${focused.name}"]:not([name])`;
            const sameInput = this.element.get(0)?.querySelector<HTMLInputElement>(selector);
            sameInput?.focus();
            sameInput?.select();
        }
    }

    override activateListeners($html: JQuery): void {
        super.activateListeners($html);

        // Handlers for number inputs of properties subject to modification by AE-like rules elements
        $html.find<HTMLInputElement>("input[data-property]").on("focus", (event) => {
            const $input = $(event.target);
            const propertyPath = $input.attr("data-property") ?? "";
            const baseValue: number = getProperty(this.actor._source, propertyPath);
            $input.val(baseValue).attr({ name: propertyPath });
        });

        $html.find<HTMLInputElement>("input[data-property]").on("blur", (event) => {
            const $input = $(event.target);
            $input.removeAttr("name").removeAttr("style").attr({ type: "text" });
            const propertyPath = $input.attr("data-property") ?? "";
            const preparedValue: number = getProperty(this.actor, propertyPath);
            $input.val(preparedValue >= 0 && $input.hasClass("modifier") ? `+${preparedValue}` : preparedValue);
        });

        // Toggle equip
        $html.find(".tab.inventory a[data-carry-type]").on("click", (event) => {
            $html.find(".carry-type-hover").tooltipster("close");

            const itemId = $(event.currentTarget).closest("[data-item-id]").attr("data-item-id") ?? "";
            const item = this.actor.items.get(itemId, { strict: true });
            if (!(item instanceof PhysicalItemPF2e)) {
                throw ErrorPF2e("Tried to update carry type of non-physical item");
            }

            const carryType = $(event.currentTarget).attr("data-carry-type") ?? "";
            const handsHeld = Number($(event.currentTarget).attr("data-hands-held")) ?? 1;
            const inSlot = $(event.currentTarget).attr("data-in-slot") === "true";
            if (carryType && setHasElement(ITEM_CARRY_TYPES, carryType)) {
                this.actor.adjustCarryType(item, carryType, handsHeld, inSlot);
            }
        });

        // General handler for embedded item updates
        const selectors = "input[data-item-id][data-item-property], select[data-item-id][data-item-property]";
        $html.find(selectors).on("change", (event) => {
            const $target = $(event.target);

            const { itemId, itemProperty } = event.target.dataset;
            if (!itemId || !itemProperty) return;

            const value = (() => {
                const value = $(event.target).val();
                if (typeof value === "undefined" || value === null) {
                    return value;
                }

                const dataType =
                    $target.attr("data-dtype") ??
                    ($target.attr("type") === "checkbox"
                        ? "Boolean"
                        : ["number", "range"].includes($target.attr("type") ?? "")
                        ? "Number"
                        : "String");

                switch (dataType) {
                    case "Boolean":
                        return typeof value === "boolean" ? value : value === "true";
                    case "Number":
                        return Number(value);
                    case "String":
                        return String(value);
                    default:
                        return value;
                }
            })();

            this.actor.updateEmbeddedDocuments("Item", [{ _id: itemId, [itemProperty]: value }]);
        });

        // Toggle Dying or Wounded
        $html.find(".dots.dying, .dots.wounded").on("click contextmenu", (event) => {
            type ConditionName = "dying" | "wounded";
            const condition = Array.from(event.delegateTarget.classList).find((className): className is ConditionName =>
                ["dying", "wounded"].includes(className)
            );
            if (condition) {
                const currentMax = this.actor.system.attributes[condition]?.max;
                if (event.type === "click" && currentMax) {
                    this.actor.increaseCondition(condition, { max: currentMax });
                } else if (event.type === "contextmenu") {
                    this.actor.decreaseCondition(condition);
                }
            }
        });

        // Roll recovery flat check when Dying
        $html
            .find("[data-action=recovery-check]")
            .tooltipster({ theme: "crb-hover" })
            .filter(":not(.disabled)")
            .on("click", (event) => {
                this.actor.rollRecovery(event);
            });

        // Roll skill checks
        $html.find(".skill-name.rollable, .skill-score.rollable").on("click", (event) => {
            const skill = event.currentTarget.closest<HTMLElement>("[data-skill]")?.dataset.skill ?? "";
            const key = objectHasKey(SKILL_DICTIONARY, skill) ? SKILL_DICTIONARY[skill] : skill;
            const rollParams = eventToRollParams(event);
            this.actor.skills[key]?.check.roll(rollParams);
        });

        // strikes
        const $strikesList = $html.find("ol.strikes-list");

        $strikesList.find("button[data-action=strike-damage]").on("click", async (event) => {
            if (!["character", "npc"].includes(this.actor.data.type)) {
                throw ErrorPF2e("This sheet only works for characters and NPCs");
            }
            await this.getStrikeFromDOM(event.currentTarget)?.damage?.({ event });
        });

        $strikesList.find("button[data-action=strike-critical]").on("click", async (event) => {
            if (!["character", "npc"].includes(this.actor.data.type)) {
                throw ErrorPF2e("This sheet only works for characters and NPCs");
            }
            await this.getStrikeFromDOM(event.currentTarget)?.critical?.({ event });
        });

        $html.find(".spell-attack").on("click", async (event) => {
            if (!["character"].includes(this.actor.data.type)) {
                throw ErrorPF2e("This sheet only works for characters");
            }
            const index = $(event.currentTarget).closest("[data-container-id]").data("containerId");
            const entry = this.actor.spellcasting.get(index);
            if (entry) {
                await entry.statistic.check.roll(eventToRollParams(event));
            }
        });

        // Casting spells and consuming slots
        $html.find("button[data-action=cast-spell]").on("click", (event) => {
            const $spellEl = $(event.currentTarget).closest(".item");
            const { itemId, slotLevel, slotId, entryId } = $spellEl.data();
            const entry = this.actor.spellcasting.get(entryId, { strict: true });
            const spell = entry.spells.get(itemId, { strict: true });
            entry.cast(spell, { slot: slotId, level: slotLevel });
        });

        // Regenerating spell slots and spell uses
        $html.find(".spell-slots-increment-reset").on("click", (event) => {
            const target = $(event.currentTarget);
            const itemId = target.data().itemId;
            const itemLevel = target.data().level;
            const actor = this.actor;
            const item = actor.items.get(itemId);
            if (item instanceof SpellcastingEntryPF2e) {
                const data = item.data.toObject();
                if (!data.data.slots) return;
                const slotLevel = goesToEleven(itemLevel) ? (`slot${itemLevel}` as const) : "slot0";
                data.data.slots[slotLevel].value = data.data.slots[slotLevel].max;
                item.update(data);
            } else if (item instanceof SpellPF2e) {
                const max = item.system.location.uses?.max;
                if (!max) return;
                item.update({ "system.location.uses.value": max });
            }
        });

        const attackSelectors = '.item-image[data-action="strike-attack"], button[data-action="strike-attack"]';
        $strikesList.find(attackSelectors).on("click", (event) => {
            if (!("actions" in this.actor.system)) {
                throw ErrorPF2e("Strikes are not supported on this actor");
            }

            const target = event.currentTarget;
            const altUsage = tupleHasValue(["thrown", "melee"] as const, target.dataset.altUsage)
                ? target.dataset.altUsage
                : null;

            const strike = this.getStrikeFromDOM(event.currentTarget);
            if (!strike) return;
            const $button = $(event.currentTarget);
            const variantIndex = Number($button.attr("data-variant-index"));

            strike.variants[variantIndex]?.roll({ event, altUsage });
        });

        // We can't use form submission for these updates since duplicates force array updates.
        // We'll have to move focus points to the top of the sheet to remove this
        $html.find(".focus-pool").on("change", (event) => {
            this.actor.update({ "system.resources.focus.max": $(event.target).val() });
        });

        $html.find(".toggle-signature-spell").on("click", (event) => {
            this.onToggleSignatureSpell(event);
        });

        // Action Browser
        $html.find(".action-browse").on("click", () => game.pf2e.compendiumBrowser.openTab("action"));

        // Spell Browser
        $html.find(".spell-browse").on("click", (event) => this.onClickBrowseSpellCompendia(event));

        // Decrease effect value
        $html.find(".effects-list .decrement").on("click", async (event) => {
            const target = $(event.currentTarget);
            const parent = target.parents(".item");
            const effect = this.actor.items.get(parent.attr("data-item-id") ?? "");
            if (effect instanceof ConditionPF2e) {
                await this.actor.decreaseCondition(effect);
            }
        });

        // Increase effect value
        $html.find(".effects-list .increment").on("click", async (event) => {
            const target = $(event.currentTarget);
            const parent = target.parents(".item");
            const effect = this.actor?.items.get(parent.attr("data-item-id") ?? "");
            if (effect instanceof ConditionPF2e) {
                await this.actor.increaseCondition(effect);
            }
        });
    }

    /** Replace sheet config with a special PC config form application */
    protected override _getHeaderButtons(): ApplicationHeaderButton[] {
        const buttons = super._getHeaderButtons();
        if (!this.actor.isOfType("character", "npc")) return buttons;

        if (this.isEditable) {
            const index = buttons.findIndex((b) => b.class === "close");
            buttons.splice(index, 0, {
                label: "Configure", // Top-level foundry localization key
                class: "configure-creature",
                icon: "fas fa-cog",
                onclick: () => this.onConfigureActor(),
            });
        }

        return buttons;
    }

    /** Open actor configuration for this sheet's creature */
    private onConfigureActor(): void {
        if (!this.actorConfigClass) return;
        new this.actorConfigClass(this.actor).render(true);
    }

    protected getStrikeFromDOM(target: HTMLElement): CharacterStrike | NPCStrike | null {
        const actionIndex = Number(target.closest<HTMLElement>("[data-action-index]")?.dataset.actionIndex);
        const rootAction = this.actor.system.actions?.[actionIndex];
        if (!rootAction) return null;

        const altUsage = tupleHasValue(["thrown", "melee"] as const, target.dataset.altUsage)
            ? target.dataset.altUsage
            : null;

        return altUsage
            ? rootAction.altUsages?.find((s) => (altUsage === "thrown" ? s.item.isThrown : s.item.isMelee)) ?? null
            : rootAction;
    }

    private onToggleSignatureSpell(event: JQuery.ClickEvent): void {
        const { itemId } = event.target.closest(".item").dataset;
        const spell = this.actor.items.get(itemId);
        if (!(spell instanceof SpellPF2e)) {
            return;
        }

        spell.update({ "system.location.signature": !spell.system.location.signature });
    }

    private onClickBrowseSpellCompendia(event: JQuery.ClickEvent<HTMLElement>) {
        const level = Number($(event.currentTarget).attr("data-level")) ?? null;
        const spellcastingIndex = $(event.currentTarget).closest("[data-container-id]").attr("data-container-id") ?? "";
        const entry = this.actor.spellcasting.get(spellcastingIndex);
        if (!(entry instanceof SpellcastingEntryPF2e)) {
            return;
        }

        game.pf2e.compendiumBrowser.openSpellTab(entry, level);
    }

    // Ensure a minimum of zero hit points and a maximum of the current max
    protected override async _onSubmit(
        event: Event,
        options: OnSubmitFormOptions = {}
    ): Promise<Record<string, unknown>> {
        // Limit HP value to data.attributes.hp.max value
        if (!(event.currentTarget instanceof HTMLInputElement)) {
            return super._onSubmit(event, options);
        }

        const target = event.currentTarget;
        if (target.name === "system.attributes.hp.value") {
            const inputted = Number(target.value) || 0;
            target.value = Math.floor(Math.clamped(inputted, 0, this.actor.hitPoints.max)).toString();
        }

        return super._onSubmit(event, options);
    }

    /** Redirect an update to shield HP to the actual item */
    protected override async _updateObject(event: Event, formData: Record<string, unknown>): Promise<void> {
        const heldShield = this.actor.heldShield;
        if (heldShield && typeof formData["system.attributes.shield.hp.value"] === "number") {
            await heldShield.update({
                "system.hp.value": formData["system.attributes.shield.hp.value"],
            });
        }
        delete formData["system.attributes.shield.hp.value"];

        return super._updateObject(event, formData);
    }
}
