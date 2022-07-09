import { CharacterPF2e, CreaturePF2e, NPCPF2e } from "@actor";
import { SpellcastingEntry, SpellcastingEntryPF2eNew } from "@actor/creature/spellcasting";

function createEmptySpellcastingEntry(actor: CharacterPF2e | NPCPF2e): SpellcastingEntryPF2eNew {
    return new SpellcastingEntryPF2eNew(actor, {
        name: "UntitledPlaceholder",
        tradition: "arcane",
        ability: "cha",
        prepared: { value: "innate" },
    });
}

/** Dialog to create or edit spellcasting entries. It works on a clone of spellcasting entry, but will not persist unless the changes are accepted */
class SpellcastingCreateAndEditDialog extends FormApplication<SpellcastingEntryPF2eNew> {
    private actor: CreaturePF2e;

    constructor(actor: CreaturePF2e, entry: SpellcastingEntryPF2eNew, options: Partial<FormApplicationOptions>) {
        super(entry, options);
        this.actor = actor;
    }

    static override get defaultOptions(): FormApplicationOptions {
        const options = super.defaultOptions;
        options.id = "spellcasting-dialog";
        options.classes = [];
        options.title = game.i18n.localize("PF2E.SpellcastingSettings.Title");
        options.template = "systems/pf2e/templates/actors/spellcasting-dialog.html";
        options.width = 350;
        options.submitOnChange = true;
        options.closeOnSubmit = false;
        return options;
    }

    override async getData(): Promise<SpellcastingCreateAndEditDialogSheetData> {
        return {
            ...(await super.getData()),
            actor: this.actor,
            data: this.object,
            magicTraditions: CONFIG.PF2E.magicTraditions,
            spellcastingTypes: CONFIG.PF2E.preparationType,
            abilities: CONFIG.PF2E.abilities,
        };
    }

    protected override async _updateObject(event: Event, formData: Record<string, unknown>): Promise<void> {
        const wasInnate = this.object.isInnate;

        // Unflatten the form data, so that we may make some modifications
        const inputData: DeepPartial<SpellcastingEntry> = expandObject(formData);

        // When swapping to innate, convert to cha, but don't force it
        if (inputData.prepared?.value === "innate" && !wasInnate && inputData.ability) {
            inputData.ability = "cha";
        }

        if (inputData.autoHeightenLevel) {
            inputData.autoHeightenLevel ||= null;
        }

        mergeObject(this.object, inputData);

        // If this wasn't a submit, only re-render and exit
        if (event.type !== "submit") {
            await this.render();
            return;
        }

        return this.updateAndClose();
    }

    private async updateAndClose(): Promise<void> {
        const updateData = this.object;
        console.log(updateData);

        //         if (this.object.isRitual) {
        //             updateData.tradition = "";
        //             updateData.ability = "";
        //         }

        if (!this.object.isPrepared) {
            delete updateData.prepared.flexible;
        }

        if (this.object.name === "UntitledPlaceholder") {
            const preparationType = game.i18n.localize(CONFIG.PF2E.preparationType[updateData.prepared.value]) ?? "";
            const traditionSpells = game.i18n.localize(CONFIG.PF2E.magicTraditions[this.object.tradition]);
            updateData.name = this.object.isRitual
                ? preparationType
                : game.i18n.format("PF2E.SpellCastingFormat", { preparationType, traditionSpells });

            await this.actor.spellcastingNew.createSpellcastingEntry({
                name: updateData.name,
                tradition: updateData.tradition,
                ability: updateData.ability,
                prepared: { value: updateData.prepared.value, flexible: updateData.prepared.flexible ?? undefined },
                autoHeightenLevel: updateData.autoHeightenLevel,
            });
        } else {
            await this.actor.spellcastingNew.editSpellcastingEntry({
                id: this.object.id,
                tradition: updateData.tradition,
                ability: updateData.ability,
                prepared: { flexible: updateData.prepared.flexible },
                autoHeightenLevel: updateData.autoHeightenLevel,
            });
        }

        this.close();
    }
}

interface SpellcastingCreateAndEditDialogSheetData extends FormApplicationData<SpellcastingEntryPF2eNew> {
    actor: CreaturePF2e;
    data: SpellcastingEntry;
    magicTraditions: ConfigPF2e["PF2E"]["magicTraditions"];
    spellcastingTypes: ConfigPF2e["PF2E"]["preparationType"];
    abilities: ConfigPF2e["PF2E"]["abilities"];
}

export async function createSpellcastingDialog(
    event: JQuery.ClickEvent,
    actor: CreaturePF2e,
    entryToAmend?: SpellcastingEntryPF2eNew
) {
    if (!(actor instanceof CharacterPF2e || actor instanceof NPCPF2e)) return;

    const entry = entryToAmend ? entryToAmend : createEmptySpellcastingEntry(actor);

    const dialog = new SpellcastingCreateAndEditDialog(actor, entry, {
        top: event.clientY - 80,
        left: window.innerWidth - 710,
        height: "auto",
    });
    return dialog.render(true);
}
