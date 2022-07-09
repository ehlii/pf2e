import { SpellPF2e } from "@item";
import { ErrorPF2e } from "@util";
import { SpellcastingEntryPF2eNew } from ".";

export class SpellCollection extends Collection<Embedded<SpellPF2e>> {
    constructor(private entry: SpellcastingEntryPF2eNew) {
        super();
    }

    get id() {
        return this.entry.id;
    }

    get actor() {
        return this.entry.actor;
    }

    /**
     * Adds a spell to this spell collection, either moving it from another one if its the same actor,
     * or creating a new spell if its not.
     */
    async addSpell(spell: SpellPF2e, targetLevel?: number): Promise<SpellPF2e | null> {
        const actor = this.actor;
        if (!actor.isOfType("creature")) {
            throw ErrorPF2e("Spellcasting entries can only exist on creatures");
        }

        targetLevel ??= spell.level;
        const spellcastingEntryId = spell.data.data.location.value;
        if (spellcastingEntryId === this.id && spell.level === targetLevel) {
            return null;
        }

        const isStandardSpell = !(spell.isCantrip || spell.isFocusSpell || spell.isRitual);
        const heightenedUpdate =
            isStandardSpell && (this.entry.isSpontaneous || this.entry.isInnate)
                ? { "data.location.heightenedLevel": Math.max(spell.baseLevel, targetLevel) }
                : {};

        if (spell.actor === actor) {
            return spell.update({ "data.location.value": this.id, ...heightenedUpdate });
        } else {
            const source = spell.clone({ "data.location.value": this.id, ...heightenedUpdate }).toObject();
            const created = (await actor.createEmbeddedDocuments("Item", [source])).shift();

            return created instanceof SpellPF2e ? created : null;
        }
    }
}
