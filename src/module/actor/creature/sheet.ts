import { CreaturePF2e } from "@actor";
import { CharacterStrike } from "@actor/character/data";
import { NPCStrike } from "@actor/npc/data";
import { CreatureSheetItemRenderer } from "@actor/sheet/item-summary-renderer";
import { ABILITY_ABBREVIATIONS, SKILL_DICTIONARY } from "@actor/values";
import { ConditionPF2e, PhysicalItemPF2e, SpellPF2e } from "@item";
import { ITEM_CARRY_TYPES } from "@item/data/values";
import { goesToEleven, ZeroToFour } from "@module/data";
import { createSheetTags } from "@module/sheet/helpers";
import { eventToRollParams } from "@scripts/sheet-util";
import { ErrorPF2e, fontAwesomeIcon, objectHasKey, setHasElement, tupleHasValue } from "@util";
import { ActorSheetPF2e } from "../sheet/base";
import { CreatureConfig } from "./config";
import { SkillData } from "./data";
import { CreatureSheetData } from "./types";
import { ItemSourcePF2e } from "@item/data";
import { ItemPF2e } from "@item";
import { DropCanvasItemDataPF2e } from "@module/canvas/drop-canvas-data";
import { isPhysicalData } from "@item/data/helpers";
import { createSpellcastingDialog } from "@actor/sheet/spellcasting-dialog";
import { SpellcastingEntryPF2eNew, SpellcastingEntryListData } from "@actor/creature/spellcasting";
import { SpellPreparationSheet } from "@item/spellcasting-entry/sheet";
import { CharacterPF2e } from "@actor/character";

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
            languages: createSheetTags(CONFIG.PF2E.languages, actor.data.data.traits.languages),
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

    protected prepareSpellcasting(): SpellcastingEntryListData[] {
        return this.actor.spellcastingNew.map((entry) => {
            return this.actor.spellcastingNew.getSpellData(entry.id); // .sort((a, b) => a.sort - b.sort);
        });
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
            const baseValue: number = getProperty(this.actor.data._source, propertyPath);
            $input.val(baseValue).attr({ name: propertyPath });
        });

        $html.find<HTMLInputElement>("input[data-property]").on("blur", (event) => {
            const $input = $(event.target);
            $input.removeAttr("name").removeAttr("style").attr({ type: "text" });
            const propertyPath = $input.attr("data-property") ?? "";
            const preparedValue: number = getProperty(this.actor.data, propertyPath);
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

            // Handle spellcasting 'item' properties first.
            if (itemProperty === "name" || itemProperty.startsWith("slots")) {
                this.actor.spellcastingNew.editSpellcastingEntry({ id: itemId, [itemProperty]: value as string });
            } else {
                this.actor.updateEmbeddedDocuments("Item", [{ _id: itemId, [itemProperty]: value }]);
            }
        });

        // Toggle Dying or Wounded
        $html.find(".dots.dying, .dots.wounded").on("click contextmenu", (event) => {
            type ConditionName = "dying" | "wounded";
            const condition = Array.from(event.delegateTarget.classList).find((className): className is ConditionName =>
                ["dying", "wounded"].includes(className)
            );
            if (condition) {
                const currentMax = this.actor.data.data.attributes[condition]?.max;
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

        // Allow clicking the 'spell attack' text just below spellcasting entry header to make a spell attack.
        $html.find(".spell-attack").on("click", async (event) => {
            if (!["character"].includes(this.actor.data.type)) {
                throw ErrorPF2e("This sheet only works for characters");
            }
            if (!(this.actor instanceof CharacterPF2e))
                throw ErrorPF2e(`Attempting to cast spell on non-creature actor`);
            const index = $(event.currentTarget).closest("[data-container-id]").data("containerId");
            const entry = this.actor.spellcastingNew.get(index);
            if (entry) {
                const stat = entry.generateStatistic();
                await stat.check.roll(eventToRollParams(event));
            }
        });

        const attackSelectors = '.item-image[data-action="strike-attack"], button[data-action="strike-attack"]';
        $strikesList.find(attackSelectors).on("click", (event) => {
            if (!("actions" in this.actor.data.data)) {
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

        $strikesList.find("button[data-action=trait-action]").on("click", (event) => {
            if (!("actions" in this.actor.data.data)) {
                throw ErrorPF2e("Trait actions are not supported on this actor");
            }

            const strike = this.getStrikeFromDOM(event.currentTarget);
            if (!strike) return;
            const $button = $(event.currentTarget);
            const traitActionIndex = Number($button.attr("data-trait-action-index"));
            const variantIndex = Number($button.attr("data-variant-index"));

            const variant = strike.traitActions[traitActionIndex]?.variants[variantIndex];

            variant?.roll({ event, modifiers: variant?.modifiers, weapon: variant?.weapon });
        });

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

        // We can't use form submission for these updates since duplicates force array updates.
        // We'll have to move focus points to the top of the sheet to remove this
        $html.find(".focus-pool").on("change", (event) => {
            this.actor.update({ "data.resources.focus.max": $(event.target).val() });
        });

        $html.find(".toggle-signature-spell").on("click", (event) => {
            this.onToggleSignatureSpell(event);
        });

        // Action Browser
        $html.find(".action-browse").on("click", () => game.pf2e.compendiumBrowser.openTab("action"));

        // Spell Browser
        $html.find(".spell-browse").on("click", (event) => this.onClickBrowseSpellCompendia(event));

        // Casting spells and consuming slots
        $html.find("button[data-action=cast-spell]").on("click", (event) => {
            const $spellEl = $(event.currentTarget).closest(".item");
            const { itemId, spellLvl, slotId, entryId } = $spellEl.data();
            const entry = this.actor.spellcastingNew.get(entryId);
            if (!(entry instanceof SpellcastingEntryPF2eNew)) {
                console.warn("PF2e System | Failed to load spellcasting entry");
                return;
            }

            const spell = entry.spells?.get(itemId);
            if (!spell) {
                console.warn("PF2e System | Failed to load spell");
                return;
            }

            this.actor.spellcastingNew.cast(entry, spell, { slot: slotId, level: spellLvl });
        });

        // Regenerating spell slots and spell uses
        $html.find(".spell-slots-increment-reset").on("click", (event) => {
            const target = $(event.currentTarget);
            const itemId = target.data().itemId;
            const itemLevel = target.data().level;
            const actor = this.actor;
            const item = actor.spellcastingNew.get(itemId) ?? actor.items.get(itemId);
            if (item instanceof SpellcastingEntryPF2eNew) {
                const slotLevel = goesToEleven(itemLevel) ? (`slot${itemLevel}` as const) : "slot0";
                actor.spellcastingNew.editSpellcastingEntry({
                    id: item.id,
                    [`slots.${slotLevel}.value`]: item.slots[slotLevel].max,
                });
            } else if (item instanceof SpellPF2e) {
                const max = item.data.data.location.uses?.max;
                if (!max) return;
                item.update({ "data.location.uses.value": max });
            }
        });

        // Set Expended Status of Spell Slot
        $html.find(".item-toggle-prepare").on("click", (event) => {
            const slotId = Number($(event.currentTarget).parents(".item").attr("data-slot-id") ?? 0);
            const spellLvl = Number($(event.currentTarget).parents(".item").attr("data-spell-lvl") ?? 0);
            const entryId = $(event.currentTarget).parents(".item").attr("data-entry-id") ?? "";
            const entry = this.actor.spellcastingNew.get(entryId, { strict: true });
            const expendedState = ((): boolean => {
                const expendedString = $(event.currentTarget).parents(".item").attr("data-expended-state") ?? "";
                return expendedString !== "true";
            })();

            entry.setSlotExpendedState(spellLvl, slotId, expendedState);
        });

        // Remove Spell Slot
        $html.find(".item-unprepare").on("click", (event) => {
            const spellLvl = Number($(event.currentTarget).parents(".item").attr("data-spell-lvl") ?? 0);
            const slotId = Number($(event.currentTarget).parents(".item").attr("data-slot-id") ?? 0);
            const entryId = $(event.currentTarget).parents(".item").attr("data-entry-id") ?? "";
            const entry = this.actor.spellcastingNew.get(entryId, { strict: true });

            entry.unprepareSpell(spellLvl, slotId);
        });

        const $spellcasting = $html.find(".tab.spellcasting, .tab.spells");
        const $spellControls = $spellcasting.find(".item-control");

        // Adding/Editing/Removing Spellcasting entries
        $spellcasting
            .find("[data-action=spellcasting-create]")
            .on("click", (event) => this.createSpellcastingEntry(event));
        $spellControls
            .filter("a[data-action=spellcasting-edit]")
            .on("click", (event) => this.editSpellcastingEntry(event));
        $spellControls
            .filter("a[data-action=spellcasting-remove]")
            .on("click", (event) => this.removeSpellcastingEntry(event));

        // Toggle slotless levels
        $spellcasting.find(".slotless-level-toggle").on("click", async (event) => {
            event.preventDefault();

            const itemId = $(event.currentTarget).parents(".item-container").attr("data-container-id") ?? "";
            const entry = this.actor.spellcastingNew.get(itemId);

            if (!entry) throw new Error("Tried to toggle visibility of slotless levels on a non-existent entry");

            const bool = !entry.showSlotlessLevels;

            await this.actor.spellcastingNew.editSpellcastingEntry({ id: entry.id, showSlotlessLevels: bool });
        });

        // Show spell preparation sheet for prepared spellcasting entries
        $html.find(".prepared-toggle").on("click", async (event) => {
            event.preventDefault();
            const itemId = $(event.currentTarget).parents(".item-container").attr("data-container-id") ?? "";
            this.openSpellPreparationSheet(itemId);
        });
    }

    /** Opens the spell preparation sheet, but only if its a prepared entry */
    openSpellPreparationSheet(entryId: string) {
        const entry = this.actor.spellcastingNew.get(entryId);
        if (entry instanceof SpellcastingEntryPF2eNew && entry.isPrepared) {
            const $book = this.element.find(`.item-container[data-container-id="${entry.id}"] .prepared-toggle`);
            const offset = $book.offset() ?? { left: 0, top: 0 };
            const sheet = new SpellPreparationSheet(entry, this.actor, {
                top: offset.top - 60,
                left: offset.left + 200,
            });
            sheet.render(true);
        }
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
        const rootAction = this.actor.data.data.actions?.[actionIndex];
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

        spell.update({ "data.location.signature": !spell.data.data.location.signature });
    }

    private onClickBrowseSpellCompendia(event: JQuery.ClickEvent<HTMLElement>) {
        const level = Number($(event.currentTarget).attr("data-level")) ?? null;
        const spellcastingIndex = $(event.currentTarget).closest("[data-container-id]").attr("data-container-id") ?? "";
        const entry = this.actor.spellcastingNew.get(spellcastingIndex);
        if (!(entry instanceof SpellcastingEntryPF2eNew)) {
            return;
        }

        game.pf2e.compendiumBrowser.openSpellTab(entry, level);
    }

    /** Handle creating a new spellcasting entry for the actor */
    private createSpellcastingEntry(event: JQuery.ClickEvent) {
        event.preventDefault();
        createSpellcastingDialog(event, this.actor);
    }

    private editSpellcastingEntry(event: JQuery.ClickEvent): void {
        const { containerId } = $(event.target).closest("[data-container-id]").data();
        const entry = this.actor.spellcastingNew.get(containerId);
        if (!entry) {
            console.warn("PF2e System | Failed to load spellcasting entry");
            return;
        }

        createSpellcastingDialog(event, this.actor, entry);
    }

    /**
     * Handle removing an existing spellcasting entry for the actor
     */
    private removeSpellcastingEntry(event: JQuery.ClickEvent): void {
        event.preventDefault();

        const li = $(event.currentTarget).parents("[data-container-id]");
        const itemId = li.attr("data-container-id") ?? "";
        const entry = this.actor.spellcastingNew.get(itemId);
        if (!entry) return;

        // Render confirmation modal dialog
        renderTemplate("systems/pf2e/templates/actors/delete-spellcasting-dialog.html").then((html) => {
            new Dialog({
                title: "Delete Confirmation",
                content: html,
                buttons: {
                    Yes: {
                        icon: '<i class="fa fa-check"></i>',
                        label: "Yes",
                        callback: async () => {
                            console.debug("PF2e System | Deleting Spell Container: ", entry.name);
                            // Delete all child objects
                            const itemsToDelete: string[] = [];
                            for (const item of this.actor.itemTypes.spell) {
                                if (item.data.data.location.value === itemId) {
                                    itemsToDelete.push(item.id);
                                }
                            }
                            // don't delete entry in the background for now
                            // itemsToDelete.push(entry.id)
                            await this.actor.deleteEmbeddedDocuments("Item", itemsToDelete);

                            // Remove spellcasting entry too
                            await this.actor.spellcastingNew.deleteSpellcastingEntry(entry.id);

                            li.slideUp(200, () => this.render(false));
                        },
                    },
                    cancel: {
                        icon: '<i class="fas fa-times"></i>',
                        label: "Cancel",
                    },
                },
                default: "Yes",
            }).render(true);
        });
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
        if (target.name === "data.attributes.hp.value") {
            const inputted = Number(target.value) || 0;
            target.value = Math.floor(Math.clamped(inputted, 0, this.actor.hitPoints.max)).toString();
        }

        return super._onSubmit(event, options);
    }

    /** Redirect an update to shield HP to the actual item */
    protected override async _updateObject(event: Event, formData: Record<string, unknown>): Promise<void> {
        const heldShield = this.actor.heldShield;
        if (heldShield && typeof formData["data.attributes.shield.hp.value"] === "number") {
            await heldShield.update({
                "data.hp.value": formData["data.attributes.shield.hp.value"],
            });
        }
        delete formData["data.attributes.shield.hp.value"];

        return super._updateObject(event, formData);
    }

    /** Handle a drop event for an existing owned spell to sort that spell */
    protected override async _onSortItem(event: ElementDragEvent, itemSource: ItemSourcePF2e): Promise<ItemPF2e[]> {
        const $dropItemEl = $(event.target).closest(".item");
        const $dropContainerEl = $(event.target).closest(".item-container");

        const dropSlotType = $dropItemEl.attr("data-item-type");
        const dropContainerType = $dropContainerEl.attr("data-container-type");
        const item = this.actor.items.get(itemSource._id);
        if (!item) return [];

        // if they are dragging onto another spell, it's just sorting the spells
        // or moving it from one spellcastingEntry to another
        if (item.isOfType("spell")) {
            const targetLocation = $dropContainerEl.attr("data-container-id") ?? "";
            const entry = this.actor.spellcastingNew.get(targetLocation, { strict: true });
            const collection = this.actor.spellcastingNew.collections.get(targetLocation, { strict: true });

            if (dropSlotType === "spellLevel") {
                const { level } = $dropItemEl.data();
                const spell = await collection.addSpell(item, level);
                this.openSpellPreparationSheet(entry.id);
                return [spell ?? []].flat();
            } else if ($dropItemEl.attr("data-slot-id")) {
                const dropId = Number($dropItemEl.attr("data-slot-id"));
                const spellLvl = Number($dropItemEl.attr("data-spell-lvl"));

                if (Number.isInteger(dropId) && Number.isInteger(spellLvl)) {
                    await entry.prepareSpell(item, spellLvl, dropId);
                    return []; // TODO: maybe return something? previously it returned the spellcastingentry item
                }
            } else if (dropSlotType === "spell") {
                const dropId = $dropItemEl.attr("data-item-id") ?? "";
                const target = this.actor.items.get(dropId);
                if (target?.isOfType("spell") && item.id !== dropId) {
                    const sourceLocation = item.data.data.location.value;

                    // Inner helper to test if two spells are siblings
                    const testSibling = (item: SpellPF2e, test: SpellPF2e) => {
                        if (item.isCantrip !== test.isCantrip) return false;
                        if (item.isCantrip && test.isCantrip) return true;
                        if (item.isFocusSpell && test.isFocusSpell) return true;
                        if (item.level === test.level) return true;
                        return false;
                    };

                    if (sourceLocation === targetLocation && testSibling(item, target)) {
                        const siblings = collection.filter((spell) => testSibling(item, spell));
                        await item.sortRelative({ target, siblings });
                        return [target];
                    } else {
                        const spell = await collection.addSpell(item, target.level);
                        this.openSpellPreparationSheet(collection.id);
                        return [spell ?? []].flat();
                    }
                }
            } else if (dropContainerType === "spellcastingEntry") {
                // if the drop container target is a spellcastingEntry then check if the item is a spell and if so update its location.
                // if the dragged item is a spell and is from the same actor
                if (CONFIG.debug.hooks)
                    console.debug("PF2e System | ***** spell from same actor dropped on a spellcasting entry *****");

                const dropId = $(event.target).parents(".item-container").attr("data-container-id");
                return dropId ? [await item.update({ "data.location.value": dropId })] : [];
            }
        }

        return super._onSortItem(event, itemSource);
    }

    /** Extend the base _onDrop method to handle sorting of spellcasting entries */
    protected override async _onDrop(event: ElementDragEvent): Promise<boolean | void> {
        const dataString = event.dataTransfer?.getData("text/plain");
        const dropData = JSON.parse(dataString ?? "");
        if ("PF2e" in dropData && dropData.PF2e.type === "spellcastingEntry") {
            const $dropContainerEl = $(event.target).closest(".item-container");
            const dropContainerType = $dropContainerEl.attr("data-container-type");
            if (dropContainerType === "spellcastingEntry") {
                const sourceId = dropData.PF2e.data.id;
                const dropId = $dropContainerEl.attr("data-container-id") ?? "";

                if (sourceId !== dropId) {
                    await this.actor.spellcastingNew.sortEntryBefore(sourceId, dropId);
                }
            }
        } else {
            return super._onDrop(event);
        }
    }

    /** Extend the base _onDrop method to handle sorting of spellcasting entries */
    protected override _onDragStart(event: ElementDragEvent): void {
        const $target = $(event.currentTarget);
        const $itemRef = $target.closest(".item");
        const containerType = $itemRef.attr("data-container-type");

        if (containerType === "spellcastingEntry") {
            // Show a different drag/drop preview element and copy some data if this is a handle
            // This will make the preview nicer and also trick foundry into thinking the actual item started drag/drop
            const targetElement = $target.get(0);
            const previewElement = $itemRef.get(0);
            if (previewElement && targetElement && targetElement !== previewElement) {
                event.dataTransfer.setDragImage(previewElement, 0, 0);
                mergeObject(targetElement.dataset, previewElement.dataset);
            }

            const baseDragData: { [key: string]: unknown } = {
                actorId: this.actor.id,
                sceneId: canvas.scene?.id ?? null,
                tokenId: this.actor.token?.id ?? null,
            };

            // Owned Items
            const itemId = $itemRef.attr("data-item-id");
            const item = this.actor.spellcastingNew.get(itemId ?? "");

            const supplementalData = (() => {
                if (item) return { PF2e: { type: "spellcastingEntry", data: item } };

                return null;
            })();

            return event.dataTransfer.setData(
                "text/plain",
                JSON.stringify({
                    ...baseDragData,
                    ...supplementalData,
                })
            );
        } else {
            return super._onDragStart(event);
        }
    }

    /** Extend the base _onDropItem method to handle dragging spells onto spell slots. */
    protected override async _onDropItem(event: ElementDragEvent, data: DropCanvasItemDataPF2e): Promise<ItemPF2e[]> {
        event.preventDefault();

        const item = await ItemPF2e.fromDropData(data);
        if (!item) return [];
        const itemSource = item.toObject();

        const actor = this.actor;
        const isSameActor = data.actorId === actor.id || (actor.isToken && data.tokenId === actor.token?.id);
        if (isSameActor) return this._onSortItem(event, itemSource);

        const sourceItemId = data.data?._id;
        if (data.actorId && isPhysicalData(itemSource) && typeof sourceItemId === "string") {
            await this.moveItemBetweenActors(
                event,
                data.actorId,
                data.tokenId ?? "",
                actor.id,
                actor.token?.id ?? "",
                sourceItemId
            );
            return [item];
        }

        // mystify the item if the alt key was pressed
        if (event.altKey && isPhysicalData(itemSource)) {
            itemSource.data.identification.unidentified = (item as PhysicalItemPF2e).getMystifiedData("unidentified");
            itemSource.data.identification.status = "unidentified";
        }

        // get the item type of the drop target
        const $itemEl = $(event.target).closest(".item");
        const $containerEl = $(event.target).closest(".item-container");
        const containerAttribute = $containerEl.attr("data-container-type");
        const unspecificInventory = this._tabs[0]?.active === "inventory" && !containerAttribute;
        const dropContainerType = unspecificInventory ? "actorInventory" : containerAttribute;

        // otherwise they are dragging a new spell onto their sheet.
        // we still need to put it in the correct spellcastingEntry
        if (item.isOfType("spell") && itemSource.type === "spell") {
            if (dropContainerType === "spellcastingEntry") {
                const entryId = $containerEl.attr("data-container-id") ?? "";
                const collection = this.actor.spellcastingNew.collections.get(entryId, { strict: true });
                const level = Math.max(Number($itemEl.attr("data-level")) || 0, item.baseLevel);
                this.openSpellPreparationSheet(collection.id);
                return [(await collection.addSpell(item, level)) ?? []].flat();
            }
        }

        return super._onDropItem(event, data);
    }
}
